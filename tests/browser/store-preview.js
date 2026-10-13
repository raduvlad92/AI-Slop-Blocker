// Preview the actual Settings UI in a regular browser for store screenshots.
// Fresh-install data only; all Chrome API writes stay in this page's memory.
(() => {
  const state = {
    settings: { hideAIOverview: true, hideYouTube: true, showCardButtons: false, watchAction: "overlay" },
    reportingConsent: { enabled: false, updatedAt: 0 },
    personal: { videos: {}, channels: {} }, community: { videos: [], channels: [], syncedAt: 0 },
    channelAliases: {}, blockedCount: 0, events: [],
  };
  const listeners = [];
  const clone = (value) => structuredClone(value);
  async function set(update) {
    const changes = {};
    for (const [key, value] of Object.entries(update)) {
      changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
      state[key] = clone(value);
    }
    queueMicrotask(() => listeners.forEach((listener) => listener(changes)));
  }
  window.chrome = {
    storage: { local: {
      get: async (defaults) => clone({ ...defaults, ...state }), set,
      onChanged: { addListener: (listener) => listeners.push(listener) },
    } },
    runtime: {
      async sendMessage(message) {
        if (message.type === "asb-set-reporting") {
          await set({ reportingConsent: { enabled: message.enabled, updatedAt: Date.now() } });
          return { ok: true };
        }
        return { ok: false, error: "Network calls are disabled in the screenshot preview" };
      },
    },
  };
})();
