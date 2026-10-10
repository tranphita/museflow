import {
  QUEUE_CONTROL_ID,
  applyJobPatch,
  claimPatch,
  defaultControl,
  exhaustedLeases,
  isJob,
  pickNextJob,
  planEnqueue,
} from '../core/jobs.js';

const DB_NAME = 'museta-library';
const DB_VERSION = 2;
const SERIES = 'series';
const OUTPUTS = 'outputs';
const JOBS = 'jobs';

let dbPromise;
function db() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SERIES))
          database.createObjectStore(SERIES, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(OUTPUTS)) database.createObjectStore(OUTPUTS);
        if (!database.objectStoreNames.contains(JOBS)) database.createObjectStore(JOBS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = null;
        };
        resolve(request.result);
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error('Another Museta tab still uses the old series library. Reload every Museta tab.'));
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Could not open the series library.'));
      };
    });
  return dbPromise;
}

async function transact(storeName, mode, body) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    let result;
    body(tx.objectStore(storeName), value => (result = value));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Series library request failed.'));
    tx.onabort = () => reject(tx.error || new Error('Series library request was cancelled.'));
  });
}

const request = (storeName, mode, action) =>
  transact(storeName, mode, (store, done) => {
    const req = action(store);
    req.onsuccess = () => done(req.result);
  });

function modify(storeName, key, change) {
  return transact(storeName, 'readwrite', (store, done) => {
    const req = store.get(key);
    req.onsuccess = () => {
      const next = change(req.result);
      if (next) store.put(next);
      done(next || null);
    };
  });
}

export const listSeries = () => request(SERIES, 'readonly', store => store.getAll());
export const getSeries = id => request(SERIES, 'readonly', store => store.get(id));
export const saveSeries = series => request(SERIES, 'readwrite', store => store.put(series));
export const deleteSeries = id => request(SERIES, 'readwrite', store => store.delete(id));
export const saveOutput = (key, blob) => request(OUTPUTS, 'readwrite', store => store.put(blob, key));
export const getOutput = key => request(OUTPUTS, 'readonly', store => store.get(key));
export const deleteOutput = key => request(OUTPUTS, 'readwrite', store => store.delete(key));

export const updateEpisode = (seriesId, episodeId, patch) =>
  modify(SERIES, seriesId, series =>
    series
      ? {
          ...series,
          episodes: series.episodes.map(episode =>
            episode.id === episodeId ? { ...episode, ...patch } : episode,
          ),
        }
      : null,
  );

export const listJobs = async () => (await request(JOBS, 'readonly', store => store.getAll())).filter(isJob);
export const deleteJob = id => request(JOBS, 'readwrite', store => store.delete(id));
export const putJobs = jobs =>
  transact(JOBS, 'readwrite', store => {
    for (const job of jobs) store.put(job);
  });
export const enqueueJobs = jobs =>
  transact(JOBS, 'readwrite', (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const plan = planEnqueue(req.result || [], jobs);
      for (const id of plan.remove) store.delete(id);
      for (const job of plan.add) store.put(job);
      done(plan);
    };
  });
export const updateJob = (id, patch, { owner } = {}) =>
  modify(JOBS, id, current => applyJobPatch(current, patch, owner));

export async function getQueueControl() {
  return { ...defaultControl(), ...(await request(JOBS, 'readonly', store => store.get(QUEUE_CONTROL_ID))) };
}

export const updateQueueControl = patch =>
  modify(JOBS, QUEUE_CONTROL_ID, saved => {
    const current = { ...defaultControl(), ...saved };
    return { ...current, ...(typeof patch === 'function' ? patch(current) : patch), id: QUEUE_CONTROL_ID };
  });

export function claimJob(workerId, now = Date.now()) {
  return transact(JOBS, 'readwrite', (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result || [];
      const control = { ...defaultControl(), ...records.find(record => !isJob(record)) };
      for (const stuck of exhaustedLeases(records, now, control.leaseMs, control.maxAttempts))
        store.put({
          ...stuck,
          status: 'failed',
          workerId: null,
          endedAt: now,
          errorKind: 'unknown',
          error: `The worker stopped responding in all ${stuck.attempts} attempts; its tab may have crashed.`,
        });
      const job = control.paused ? null : pickNextJob(records, now, control.leaseMs, control.maxAttempts);
      if (!job) return done(null);
      const claimed = { ...job, ...claimPatch(job, workerId, now) };
      store.put(claimed);
      done(claimed);
    };
  });
}

export async function finishJob(id, owner, outputKey, blob, patch) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([JOBS, OUTPUTS], 'readwrite');
    let result = null;
    const req = tx.objectStore(JOBS).get(id);
    req.onsuccess = () => {
      const next = applyJobPatch(req.result, patch, owner);
      if (!next) return;
      tx.objectStore(OUTPUTS).put(blob, outputKey);
      tx.objectStore(JOBS).put(next);
      result = next;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Could not save the episode MP4.'));
    tx.onabort = () => reject(tx.error || new Error('Saving the episode MP4 was cancelled.'));
  });
}
