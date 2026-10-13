// Shared helpers for content scripts (classic script — content scripts can't
// use ES modules, so this defines a single global namespace).

const ASB = {
  DEFAULTS: {
    // showCardButtons: overlay button on video thumbnails — opt-in; by
    // default the block button only appears on the currently playing video.
    // watchAction: what happens when a blocked video is opened/playing —
    // "overlay" (block playback + overlay), "redirect" (YouTube home),
    // "next" (skip to next video), "sidebar" (play top sidebar video).
    settings: {
      hideAIOverview: true,
      hideYouTube: true,
      showCardButtons: false,
      watchAction: "overlay",
    },
    personal: { videos: {}, channels: {} },
    channelAliases: {},
    community: { videos: [], channels: [], syncedAt: 0 },
    blockedCount: 0,
    // Event log powering the icon badge and the stats views:
    // { t: epoch-ms, kind: "video" | "overview", mins?: number }
    events: [],
  },

  // The background worker owns mutations so multiple tabs cannot overwrite
  // one another's blocks or stats. A block includes its stats event.
  async block(scope, info, mins) {
    const response = await chrome.runtime.sendMessage({ type: "asb-block", scope, info, mins });
    if (!response?.ok) throw new Error(response?.error || "Could not save block");
    return response;
  },

  // Append a separate event (Google Overview, badge + stats). Pruning and
  // serialization happen in the background worker.
  async logEvent(kind, mins) {
    try {
      await chrome.runtime.sendMessage({ type: "asb-log-event", kind, mins });
    } catch { /* stats are best-effort, never break blocking */ }
  },

  async getState() {
    return chrome.storage.local.get(ASB.DEFAULTS);
  },

  // Calls cb(changes) whenever any of our storage keys change (settings
  // toggled in options, list edited, community sync, another tab blocking).
  onStateChange(cb) {
    chrome.storage.local.onChanged.addListener((changes) => {
      const keys = Object.keys(ASB.DEFAULTS);
      if (keys.some((k) => k in changes)) cb(changes);
    });
  },
};
