import { state } from '../core/state.js';
import { mediaRefs } from '../core/history.js';
import { staleMediaKeys } from '../core/checkpoint.js';

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
      request.onerror = () => reject(request.error || new Error('Không mở được kho media trên máy.'));
    });
  return mediaDbPromise;
}

function transactionDone(tx, failure) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error(failure));
    tx.onabort = () => reject(tx.error || new Error('Thao tác với kho media đã bị huỷ.'));
  });
}

export async function putMedia(key, blob) {
  const db = await mediaDb();
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  tx.objectStore(MEDIA_STORE).put(blob, key);
  return transactionDone(tx, 'Không lưu được file media vào máy.');
}

export async function getMedia(key) {
  const db = await mediaDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Không đọc được file media đã lưu.'));
  });
}

export async function pruneMedia(keepKeys) {
  const db = await mediaDb();
  const keys = await new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const stale = staleMediaKeys(keys, keepKeys);
  if (!stale.length) return 0;
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  for (const key of stale) tx.objectStore(MEDIA_STORE).delete(key);
  await transactionDone(tx, 'Không dọn được media không còn dùng.');
  return stale.length;
}

export async function deleteMediaWithPrefix(prefix) {
  const db = await mediaDb();
  const keys = await new Promise((resolve, reject) => {
    const request = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  const matching = keys.filter(key => String(key).startsWith(prefix));
  if (!matching.length) return 0;
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  for (const key of matching) tx.objectStore(MEDIA_STORE).delete(key);
  await transactionDone(tx, 'Không xoá được media của tập.');
  return matching.length;
}

export function storedMediaKey(url) {
  const prefix = storedPrefix(url);
  return prefix ? decodeURIComponent(url.slice(prefix.length)) : null;
}

export async function dehydrateMediaUrl(url, key) {
  if (!url || storedPrefix(url) || !/^(?:data:|blob:)/i.test(url)) return url;
  const response = await fetch(url);
  const blob = await response.blob();
  if (!blob.size) throw new Error('Một ảnh hoặc video đã lưu bị rỗng.');
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

export async function dehydrateNodeMedia(nodes, { keyPrefix = '' } = {}) {
  const keep = new Set();
  for (const node of nodes)
    for (const ref of mediaRefs(node.data)) {
      const key =
        keyPrefix + (ref.field === 'input' ? `input:${node.id}` : `${ref.field}:${ref.id || node.id}`);
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
