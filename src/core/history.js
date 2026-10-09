export const MAX_HISTORY = 8;

export function recordGeneration(data, { asset, endFrame = null, prompt = '' }, now = Date.now()) {
  const entry = { id: asset.id, asset, endFrame, prompt, createdAt: now };
  data.history = [entry, ...(data.history || []).filter(item => item.id !== entry.id)].slice(0, MAX_HISTORY);
  return entry;
}

export function restoreGeneration(data, entryId) {
  const entry = (data.history || []).find(item => item.id === entryId);
  if (!entry) return null;
  data.asset = entry.asset;
  data.endFrame = entry.endFrame || null;
  data.status = 'success';
  data.error = '';
  return entry;
}

export function removeGeneration(data, entryId) {
  data.history = (data.history || []).filter(item => item.id !== entryId);
  if (data.asset?.id === entryId) {
    const next = data.history[0];
    data.asset = next?.asset || null;
    data.endFrame = next?.endFrame || null;
    data.status = next ? 'success' : 'idle';
  }
}

export function mediaRefs(data) {
  if (!data || typeof data !== 'object') return [];
  const refs = [];
  if (data.localDataUrl) refs.push({ holder: data, key: 'localDataUrl', field: 'input', id: null });
  const add = (media, field) => {
    if (media?.url) refs.push({ holder: media, key: 'url', field, id: media.id || null });
  };
  for (const field of ['asset', 'endFrame']) add(data[field], field);
  add(data.music, 'music');
  for (const entry of data.history || [])
    for (const field of ['asset', 'endFrame']) add(entry?.[field], field);
  return refs;
}
