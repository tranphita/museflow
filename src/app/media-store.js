import { state } from '../core/state.js';

export let mediaDbPromise;
export function mediaDb() {
  if (!mediaDbPromise)
    mediaDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('museflow-media', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local media storage.'));
    });
  return mediaDbPromise;
}
export async function putMedia(key, blob) {
  const db = await mediaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not save a media file locally.'));
    tx.onabort = () => reject(tx.error || new Error('Media storage transaction was cancelled.'));
  });
}
export async function getMedia(key) {
  const db = await mediaDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction('assets', 'readonly').objectStore('assets').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read a saved media file.'));
  });
}
export const idbMediaPrefix = 'museflow-idb:';
export async function dehydrateMediaUrl(url, key) {
  if (!url || url.startsWith(idbMediaPrefix) || !/^(?:data:|blob:)/i.test(url)) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  if (!blob.size) throw new Error('A saved image or video is empty.');
  await putMedia(key, blob);
  return idbMediaPrefix + encodeURIComponent(key);
}
export async function hydrateMediaUrl(url, cache) {
  if (!url?.startsWith(idbMediaPrefix)) return url;
  const key = decodeURIComponent(url.slice(idbMediaPrefix.length));
  if (!cache.has(key)) {
    const blob = await getMedia(key);
    cache.set(key, blob ? URL.createObjectURL(blob) : '');
  }
  return cache.get(key);
}
export async function hydrateWorkflowMedia() {
  const cache = new Map();
  for (const node of state.nodes) {
    const data = node.data || {};
    if (data.localDataUrl) data.localDataUrl = await hydrateMediaUrl(data.localDataUrl, cache);
    for (const field of ['asset', 'endFrame'])
      if (data[field]?.url) data[field].url = await hydrateMediaUrl(data[field].url, cache);
  }
}
