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

export const MAX_WORKERS = 8;
const WORKER_WINDOW = { width: 560, height: 820, minWidth: 460 };

// Muse only hydrates a visible side chat, so worker windows are tiled instead of stacked on top of each other.
export function workerWindowBounds(id, count, screen) {
  const total = Math.max(1, count, id);
  const columns = Math.min(total, Math.max(1, Math.floor(screen.availWidth / WORKER_WINDOW.minWidth)));
  const rows = Math.ceil(total / columns);
  const width = Math.min(WORKER_WINDOW.width, Math.floor(screen.availWidth / columns));
  const height = Math.min(WORKER_WINDOW.height, Math.floor(screen.availHeight / rows));
  const index = Math.max(0, id - 1);
  return {
    left: (screen.availLeft || 0) + (index % columns) * width,
    top: (screen.availTop || 0) + Math.floor(index / columns) * height,
    width,
    height,
  };
}
