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
