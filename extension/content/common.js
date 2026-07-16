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
    community: { videos: [], channels: [], syncedAt: 0 },
    blockedCount: 0,
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
