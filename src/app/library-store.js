const DB_NAME = 'museta-library';
const SERIES = 'series';
const OUTPUTS = 'outputs';

let dbPromise;
function db() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(SERIES, { keyPath: 'id' });
        request.result.createObjectStore(OUTPUTS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the series library.'));
    });
  return dbPromise;
}

async function run(store, mode, action) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, mode);
    const request = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || new Error('Series library request failed.'));
    tx.onabort = () => reject(tx.error || new Error('Series library request was cancelled.'));
  });
}

export const listSeries = () => run(SERIES, 'readonly', store => store.getAll());
export const saveSeries = series => run(SERIES, 'readwrite', store => store.put(series));
export const deleteSeries = id => run(SERIES, 'readwrite', store => store.delete(id));
export const saveOutput = (key, blob) => run(OUTPUTS, 'readwrite', store => store.put(blob, key));
export const getOutput = key => run(OUTPUTS, 'readonly', store => store.get(key));
export const deleteOutput = key => run(OUTPUTS, 'readwrite', store => store.delete(key));
