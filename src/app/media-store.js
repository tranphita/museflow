import { state } from '../core/state.js';
import { mediaRefs } from '../core/history.js';

// The database keeps its pre-rename name so media saved by MuseFlow stays readable.
const MEDIA_DB_NAME = 'museflow-media';
const MEDIA_STORE = 'assets';
export const idbMediaPrefix = 'museta-idb:';
const legacyIdbMediaPrefixes = ['museflow-idb:'];
const storedPrefix = url =>
  [idbMediaPrefix, ...legacyIdbMediaPrefixes].find(prefix => url?.startsWith(prefix));

let mediaDbPromise;
function mediaDb() {
  if (!mediaDbPromise)
    mediaDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(MEDIA_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(MEDIA_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local media storage.'));
    });
  return mediaDbPromise;
}

function transactionDone(tx, failure) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error(failure));
    tx.onabort = () => reject(tx.error || new Error('Media storage transaction was cancelled.'));
  });
}

export async function putMedia(key, blob) {
  const db = await mediaDb();
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  tx.objectStore(MEDIA_STORE).put(blob, key);
  return transactionDone(tx, 'Could not save a media file locally.');
}

export async function getMedia(key) {
  const db = await mediaDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read a saved media file.'));
  });
}

export async function pruneMedia(keepKeys) {
  const db = await mediaDb();
  const keys = await new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const stale = keys.filter(key => !keepKeys.has(key));
  if (!stale.length) return 0;
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  for (const key of stale) tx.objectStore(MEDIA_STORE).delete(key);
  await transactionDone(tx, 'Could not clean up unused media.');
  return stale.length;
}

export function storedMediaKey(url) {
  const prefix = storedPrefix(url);
  return prefix ? decodeURIComponent(url.slice(prefix.length)) : null;
}

export async function dehydrateMediaUrl(url, key) {
  if (!url || storedPrefix(url) || !/^(?:data:|blob:)/i.test(url)) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  if (!blob.size) throw new Error('A saved image or video is empty.');
  await putMedia(key, blob);
  return idbMediaPrefix + encodeURIComponent(key);
}

export async function hydrateMediaUrl(url, cache) {
  const key = storedMediaKey(url);
  if (key === null) return url;
  if (!cache.has(key)) {
    const blob = await getMedia(key);
    cache.set(key, blob ? URL.createObjectURL(blob) : '');
  }
  return cache.get(key);
}

export async function dehydrateNodeMedia(nodes) {
  const keep = new Set();
  for (const node of nodes)
    for (const ref of mediaRefs(node.data)) {
      const key = ref.field === 'input' ? `input:${node.id}` : `${ref.field}:${ref.id || node.id}`;
      ref.holder[ref.key] = await dehydrateMediaUrl(ref.holder[ref.key], key);
      const stored = storedMediaKey(ref.holder[ref.key]);
      if (stored !== null) keep.add(stored);
    }
  return keep;
}

export async function hydrateWorkflowMedia() {
  const cache = new Map();
  for (const node of state.nodes)
    for (const ref of mediaRefs(node.data))
      ref.holder[ref.key] = await hydrateMediaUrl(ref.holder[ref.key], cache);
}
