// Background service worker (MV3).
// Responsibilities:
//   1. First-install setup: local defaults; reporting requires an explicit opt-in.
//   2. Periodic community-blocklist sync via chrome.alarms.
//   3. Relaying block submissions to the backend (content scripts message us;
//      doing the fetch here keeps network access + retry logic in one place).
//   4. Serializing personal-list and stats mutations from every tab.

import {
  BACKEND_URL,
  BLOCKLIST_VIDEOS_URL,
  BLOCKLIST_CHANNELS_URL,
  SYNC_INTERVAL_MINUTES,
} from "./config.js";
import "./content/channel-identity.js";

const SYNC_ALARM = "asb-blocklist-sync";
const BADGE_ALARM = "asb-badge-refresh"; // rolls the badge over at day change

const DEFAULT_SETTINGS = {
  hideAIOverview: true,
  hideYouTube: true,
  showCardButtons: false, // thumbnail-overlay buttons are opt-in
  watchAction: "overlay", // what to do when a blocked video is opened
};
const DEFAULT_REPORTING_CONSENT = { enabled: false, updatedAt: 0 };

// All read/modify/write operations for these keys share one queue. Content
// scripts and the options page must message us instead of writing snapshots
// back themselves, otherwise simultaneous tabs can overwrite each other.
let storageMutationQueue = Promise.resolve();

function queueMutation(operation) {
  const result = storageMutationQueue.then(operation);
  // A failed write must not prevent later requests from being processed.
  storageMutationQueue = result.catch(() => {});
  return result;
}

function appendEvent(events, kind, mins, now = Date.now()) {
  const event = { t: now, kind };
  if (Number.isFinite(mins) && mins > 0) event.mins = mins;
  return [...events, event]
    .filter((entry) => entry.t >= now - 90 * 864e5)
    .slice(-5000);
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_RE = /^(UC[A-Za-z0-9_-]{22}|@[^\s/?#]{1,100})$/u;

function validId(id, kind) {
  return typeof id === "string" &&
    (kind === "videos" ? VIDEO_ID_RE : CHANNEL_ID_RE).test(id);
}

function blockInfo(msg) {
  const { scope, info } = msg;
  if ((scope !== "video" && scope !== "channel") || !info || typeof info !== "object") {
    throw new Error("Invalid block request");
  }
  if ((info.videoId != null && !validId(info.videoId, "videos")) ||
      (scope === "video" && !validId(info.videoId, "videos")) ||
      (scope === "channel" && !validId(info.channelId, "channels"))) {
    throw new Error("Invalid video or channel ID");
  }
  return {
    videoId: info.videoId || null,
    channelId: validId(info.channelId, "channels") ? info.channelId : null,
    channelName: typeof info.channelName === "string" ? info.channelName.slice(0, 100) : null,
    scope,
  };
}

async function persistBlock(msg) {
  const info = blockInfo(msg);
  const data = await chrome.storage.local.get({
    personal: { videos: {}, channels: {} },
    channelAliases: {},
    reportingConsent: DEFAULT_REPORTING_CONSENT,
    blockedCount: 0,
    events: [],
  });
  info.channelId = globalThis.ASBChannels?.canonical(info.channelId, data.channelAliases) || info.channelId;
  const now = Date.now();
  // Preserve the existing behavior: a channel block also stores this video.
  if (info.videoId) {
    data.personal.videos[info.videoId] = { channelName: info.channelName || "", addedAt: now };
  }
  if (info.scope === "channel") {
    data.personal.channels[info.channelId] = { name: info.channelName || "", addedAt: now };
  }
  data.blockedCount += 1;
  data.events = appendEvent(data.events, "video", msg.mins, now);
  await chrome.storage.local.set(data);

  // Reporting remains best-effort and cannot hold up another local mutation.
  if (data.reportingConsent?.enabled === true) {
    submitToBackend(info).catch((err) => console.warn("[ASB] submission failed:", err.message));
  }
  return { ok: true, ...data };
}

async function persistEvent(msg) {
  if (msg.kind !== "video" && msg.kind !== "overview") throw new Error("Invalid event kind");
  const { events } = await chrome.storage.local.get({ events: [] });
  const updated = appendEvent(events, msg.kind, msg.mins);
  await chrome.storage.local.set({ events: updated });
  return { ok: true };
}

async function removeBlock(msg) {
  if ((msg.storageKey !== "videos" && msg.storageKey !== "channels") ||
      typeof msg.id !== "string" || !msg.id || msg.id.length > 256 ||
      ["__proto__", "constructor", "prototype"].includes(msg.id)) throw new Error("Invalid block removal");
  const { personal, channelAliases } = await chrome.storage.local.get({ personal: { videos: {}, channels: {} }, channelAliases: {} });
  delete personal[msg.storageKey][msg.id];
  if (msg.storageKey === "channels") {
    const id = globalThis.ASBChannels?.canonical(msg.id, channelAliases);
    if (id) delete personal.channels[id];
  }
  await chrome.storage.local.set({ personal });
  return { ok: true, personal };
}

async function setReporting(msg) {
  if (typeof msg.enabled !== "boolean") throw new Error("Invalid reporting choice");
  const reportingConsent = { enabled: msg.enabled, updatedAt: Date.now() };
  const change = { reportingConsent };
  if (msg.enabled) {
    const { installId } = await chrome.storage.local.get("installId");
    // The identifier is created only after the user affirmatively opts in.
    // Existing identifiers remain local until that same explicit choice.
    if (!installId) change.installId = crypto.randomUUID();
  }
  await chrome.storage.local.set(change);
  return { ok: true, reportingConsent };
}

async function fetchChannelPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { credentials: "omit", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("Channel lookup failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, html = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return html + decoder.decode();
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error("Channel page too large");
        html += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel(); }
  } finally { clearTimeout(timer); }
}

let resolveChannelIdentities;

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get(["settings", "reportingConsent"]);

  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (!stored.reportingConsent) {
    await queueMutation(async () => {
      const { reportingConsent } = await chrome.storage.local.get("reportingConsent");
      if (!reportingConsent) await chrome.storage.local.set({ reportingConsent: DEFAULT_REPORTING_CONSENT });
    });
  }

  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 30 });
  syncCommunityBlocklist();
  updateBadge();
  // Present the optional choice without enabling sharing or interrupting an
  // existing install when it receives an update.
  if (reason === "install") chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  // Re-sync on browser start if the cache is older than one sync interval.
  const { community } = await chrome.storage.local.get("community");
  const age = Date.now() - (community?.syncedAt || 0);
  if (age > SYNC_INTERVAL_MINUTES * 60 * 1000) syncCommunityBlocklist();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncCommunityBlocklist();
  if (alarm.name === BADGE_ALARM) updateBadge();
});

// ---------------------------------------------------------------------------
// Icon badge: how much slop was blocked TODAY (YouTube blocks + AI Overviews)
// ---------------------------------------------------------------------------

async function updateBadge() {
  try {
    const { events } = await chrome.storage.local.get({ events: [] });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = events.filter((e) => e.t >= startOfDay.getTime()).length;
    await chrome.action.setBadgeBackgroundColor({ color: "#e11d48" });
    await chrome.action.setBadgeText({ text: today ? String(today) : "" });
  } catch { /* badge is cosmetic */ }
}

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.events) updateBadge();
});

// ---------------------------------------------------------------------------
// Community blocklist sync
// ---------------------------------------------------------------------------

async function fetchIdArray(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${url} is not a JSON array`);
  // Blocklist entries are objects ({id, name, added, reason}); bare string
  // ids are also accepted. Only ids are cached — the metadata exists for
  // humans reviewing the repo. A malformed upstream file must never poison
  // the cache or crash filtering in content scripts.
  return data
    .map((x) => (typeof x === "string" ? x : x && typeof x.id === "string" ? x.id : null))
    .filter((id) => id && id.length < 128);
}

async function syncCommunityBlocklist() {
  try {
    const [videos, channels] = await Promise.all([
      fetchIdArray(BLOCKLIST_VIDEOS_URL),
      fetchIdArray(BLOCKLIST_CHANNELS_URL),
    ]);
    let channelCount;
    await queueMutation(async () => {
      const { communityChannelBindings } = await chrome.storage.local.get({ communityChannelBindings: {} });
      // Keep an already resolved community entry tied to its canonical creator
      // across syncs, even if the creator renames or releases the listed handle.
      const bindings = {};
      const resolved = [...new Set(channels.map((key) => {
        const normalized = ASBChannels.normalize(key);
        const id = communityChannelBindings[normalized];
        if (id && ASBChannels.normalize(id)?.startsWith("UC")) {
          bindings[normalized] = id;
          return id;
        }
        return normalized || key;
      }))];
      channelCount = resolved.length;
      await chrome.storage.local.set({
        community: { videos, channels: resolved, syncedAt: Date.now() },
        communityChannelBindings: bindings,
      });
    });
    return { ok: true, videos: videos.length, channels: channelCount };
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
  // 3 attempts with short backoff. Never surfaces errors to the UI — the
  // user's local block already happened instantly, this is best-effort.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Check on every retry, so turning sharing off also stops pending retries.
    // A missing consent record is local-only, including upgraded installs.
    const { reportingConsent, installId } = await chrome.storage.local.get({
      reportingConsent: DEFAULT_REPORTING_CONSENT,
      installId: null,
    });
    if (reportingConsent?.enabled !== true || !installId) return;
    const body = JSON.stringify({
      videoId: payload.videoId,
      channelId: payload.channelId,
      channelName: payload.channelName,
      scope: payload.scope,
      installId,
    });
    try {
      const res = await fetch(`${BACKEND_URL}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "omit",
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === "asb-set-reporting") {
    const fromSettings = ["options/", "popup/"].some((path) =>
      sender.url?.startsWith(chrome.runtime.getURL(path))
    );
    if (!fromSettings) {
      sendResponse({ ok: false, error: "Reporting choices must be made in extension settings" });
      return false;
    }
    queueMutation(() => setReporting(msg)).then(
      sendResponse,
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }
  if (msg?.type === "asb-resolve-channels") {
    if (!Array.isArray(msg.ids) || msg.ids.length > 20) {
      sendResponse({ ok: false, error: "Invalid channel lookup" });
      return false;
    }
    resolveChannelIdentities ||= ASBChannels.createResolver({
      storage: chrome.storage.local,
      fetchPage: fetchChannelPage,
      mutate: queueMutation,
    });
    resolveChannelIdentities(msg.ids).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  const mutations = {
    "asb-block": persistBlock,
    "asb-log-event": persistEvent,
    "asb-remove-block": removeBlock,
  };
  if (Object.hasOwn(mutations, msg?.type)) {
    queueMutation(() => mutations[msg.type](msg)).then(
      sendResponse,
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true; // keep the response channel open until the write completes
  }
  if (msg?.type === "asb-submit") {
    try {
      const info = blockInfo({ scope: msg.payload?.scope, info: msg.payload });
      submitToBackend(info).catch(() => {}); // consent-gated, deliberately not awaited
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;
  }
  if (msg?.type === "asb-sync-now") {
    syncCommunityBlocklist().then(sendResponse);
    return true; // async response
  }
  return false;
});
