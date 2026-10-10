export const NEW_SIDE_CHAT_URL = 'https://muse.ai/thread/new';

export function isMuseUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'muse.ai' || hostname.endsWith('.muse.ai'));
  } catch {
    return false;
  }
}

export function pinnedMuseTabIds(tabs, appUrl) {
  const ids = new Set();
  for (const tab of tabs)
    if (tab.url?.startsWith(`${appUrl}?`)) {
      const muse = Number(new URL(tab.url).searchParams.get('muse'));
      if (muse) ids.add(muse);
    }
  return ids;
}

export function selectableMuseTabs(museTabs, { pinnedId = null, pinnedIds = new Set() } = {}) {
  if (pinnedId) return museTabs.filter(tab => tab.id === pinnedId);
  return museTabs.filter(tab => !pinnedIds.has(tab.id));
}

// Muse.ai has one main chat per account at "/", so workers sharing it would type into the same conversation.
export function workerChatUrl(url) {
  if (!isMuseUrl(url)) return NEW_SIDE_CHAT_URL;
  return new URL(url).pathname.replace(/\/+$/, '') ? url : NEW_SIDE_CHAT_URL;
}
