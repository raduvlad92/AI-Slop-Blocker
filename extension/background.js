// Background service worker (MV3).
// Responsibilities:
//   1. First-install setup: anonymous installId, default settings.
//   2. Periodic community-blocklist sync via chrome.alarms.
//   3. Relaying block submissions to the backend (content scripts message us;
//      doing the fetch here keeps network access + retry logic in one place).

import {
  BACKEND_URL,
  BLOCKLIST_VIDEOS_URL,
  BLOCKLIST_CHANNELS_URL,
  SYNC_INTERVAL_MINUTES,
} from "./config.js";

const SYNC_ALARM = "asb-blocklist-sync";

const DEFAULT_SETTINGS = {
  hideAIOverview: true,
  hideYouTube: true,
};

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["installId", "settings"]);

  // installId is a random UUID, generated once, never tied to any identity.
  // Used only for backend rate limiting / dedupe.
  if (!stored.installId) {
    await chrome.storage.local.set({ installId: crypto.randomUUID() });
  }
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }

  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  syncCommunityBlocklist();
});

chrome.runtime.onStartup.addListener(async () => {
  // Re-sync on browser start if the cache is older than one sync interval.
  const { community } = await chrome.storage.local.get("community");
  const age = Date.now() - (community?.syncedAt || 0);
  if (age > SYNC_INTERVAL_MINUTES * 60 * 1000) syncCommunityBlocklist();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncCommunityBlocklist();
});

// ---------------------------------------------------------------------------
// Community blocklist sync
// ---------------------------------------------------------------------------

async function fetchIdArray(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${url} is not a JSON array`);
  // Only keep plausible string IDs; a malformed upstream file must never
  // poison the cache or crash filtering in content scripts.
  return data.filter((x) => typeof x === "string" && x.length > 0 && x.length < 128);
}

async function syncCommunityBlocklist() {
  try {
    const [videos, channels] = await Promise.all([
      fetchIdArray(BLOCKLIST_VIDEOS_URL),
      fetchIdArray(BLOCKLIST_CHANNELS_URL),
    ]);
    await chrome.storage.local.set({
      community: { videos, channels, syncedAt: Date.now() },
    });
    return { ok: true, videos: videos.length, channels: channels.length };
  } catch (err) {
    // Fail silently: the extension keeps working with the last cached list.
    console.warn("[ASB] blocklist sync failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Submission relay (fire-and-forget with basic retry)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submitToBackend(payload) {
  const { installId } = await chrome.storage.local.get("installId");
  const body = JSON.stringify({ ...payload, installId });

  // 3 attempts with short backoff. Never surfaces errors to the UI — the
  // user's local block already happened instantly, this is best-effort.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // 4xx (validation / rate limit) will never succeed on retry — stop.
      if (res.ok || (res.status >= 400 && res.status < 500)) return;
    } catch {
      // network error — retry
    }
    await sleep(1000 * (attempt + 1));
  }
}

// ---------------------------------------------------------------------------
// Messages from content scripts / options page
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "asb-submit") {
    submitToBackend(msg.payload); // deliberately not awaited
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "asb-sync-now") {
    syncCommunityBlocklist().then(sendResponse);
    return true; // async response
  }
  return false;
});
