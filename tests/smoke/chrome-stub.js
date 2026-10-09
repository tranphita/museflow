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
        return window.__museReply ? window.__museReply(message) : { ok: true };
      },
      onUpdated: listeners(),
      onCreated: listeners(),
    },
    scripting: { async executeScript() {} },
  };
})();
