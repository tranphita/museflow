(() => {
  const store = JSON.parse(sessionStorage.getItem('chrome-stub-storage') || '{}');
  const persist = () => sessionStorage.setItem('chrome-stub-storage', JSON.stringify(store));
  const listeners = () => ({ addListener() {}, removeListener() {} });
  window.__museTabMessages = [];
  window.chrome = {
    runtime: {
      getURL: path => new URL(path, location.origin + '/').href,
      getManifest: () => ({ version: '0.0.0-smoke', name: 'Smoke' }),
      onMessage: listeners(),
    },
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter(k => k in store).map(k => [k, structuredClone(store[k])]));
        },
        async set(values) {
          Object.assign(store, structuredClone(values));
          persist();
        },
        async remove(key) {
          for (const k of Array.isArray(key) ? key : [key]) delete store[k];
          persist();
        },
      },
    },
    tabs: {
      async query() {
        return window.__museTabs || [];
      },
      async sendMessage(tabId, message) {
        window.__museTabMessages.push({ tabId, message });
        return window.__museReply ? window.__museReply(message, tabId) : { ok: true };
      },
      async get(id) {
        return { id, status: 'complete', url: 'https://muse.ai/chat', windowId: 1 };
      },
      async update(id) {
        return { id };
      },
      async create({ url }) {
        window.__createdTabs = [...(window.__createdTabs || []), url];
        return { id: 900 + window.__createdTabs.length };
      },
      async remove() {},
      onUpdated: listeners(),
      onCreated: listeners(),
    },
    windows: {
      async create() {
        window.__createdWindows = (window.__createdWindows || 0) + 1;
        return { id: window.__createdWindows, tabs: [{ id: 800 + window.__createdWindows }] };
      },
      async remove() {},
    },
    power: {
      requestKeepAwake(level) {
        window.__keepAwake = level;
        window.__keepAwakeEver = true;
      },
      releaseKeepAwake() {
        window.__keepAwake = null;
      },
    },
    scripting: { async executeScript() {} },
  };
})();
