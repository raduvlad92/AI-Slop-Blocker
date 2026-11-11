const api = typeof browser === "undefined" ? chrome : browser;

// Background service worker (MV3).
// Responsibilities:
//   1. First-install setup: local UUID and defaults; reporting requires an explicit opt-in.
//   2. Periodic community-blocklist sync via api.alarms.
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
const FIREFOX_REPORT_DATA = ["browsingActivity", "websiteContent", "websiteActivity", "personallyIdentifyingInfo"];

async function hasReportPermission() {
  if (!api.runtime.getBrowserInfo) return true;
  try {
    const permissions = await api.permissions.getAll();
    return FIREFOX_REPORT_DATA.every((type) => permissions.data_collection?.includes(type));
  } catch { return false; }
}

api.permissions?.onRemoved?.addListener((removed) => {
  if (removed.data_collection?.some((type) => FIREFOX_REPORT_DATA.includes(type))) {
    queueMutation(() => setReporting({ enabled: false })).catch(() => {});
  }
});

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
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validInstallId(id) {
  return typeof id === "string" && INSTALL_ID_RE.test(id);
}

function validId(id, kind) {
  return typeof id === "string" && !["constructor", "prototype", "__proto__"].includes(id) &&
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
  const data = await api.storage.local.get({
    personal: { videos: {}, channels: {} },
    channelAliases: {},
    reportingConsent: DEFAULT_REPORTING_CONSENT,
    blockedCount: 0,
    events: [],
    allowlist: { videos: {}, channels: {} },
    undoBlocks: {},
  });
  info.channelId = globalThis.ASBChannels?.canonical(info.channelId, data.channelAliases) || info.channelId;
  const now = Date.now();
  const actionId = `${now}-${Math.random().toString(36).slice(2)}`;
  const entries = [];
  const removedAllowlist = [];
  const put = (kind, id, meta) => {
    entries.push({ kind, id, before: Object.hasOwn(data.personal[kind], id) ? data.personal[kind][id] : null });
    data.personal[kind][id] = { ...meta, addedAt: now, actionId };
  };
  // A channel's companion video is tracked separately from explicit video blocks.
  if (info.videoId && (info.scope === "video" || !data.personal.videos[info.videoId])) {
    put("videos", info.videoId, { channelName: info.channelName || "", channelId: info.channelId,
      ...(info.scope === "channel" ? { channelBlock: info.channelId } : {}) });
  }
  if (info.scope === "channel") {
    put("channels", info.channelId, { name: info.channelName || "" });
  }
  if (info.videoId && Object.hasOwn(data.allowlist.videos, info.videoId)) {
    removedAllowlist.push({ kind: "videos", id: info.videoId, value: data.allowlist.videos[info.videoId] });
    delete data.allowlist.videos[info.videoId];
  }
  if (info.channelId) {
    for (const id of Object.keys(data.allowlist.channels)) {
      if (ASBChannels.canonical(id, data.channelAliases) === info.channelId) {
        removedAllowlist.push({ kind: "channels", id, value: data.allowlist.channels[id] });
        delete data.allowlist.channels[id];
      }
    }
  }
  data.blockedCount += 1;
  data.events = appendEvent(data.events, "video", msg.mins, now);
  data.events.at(-1).actionId = actionId;
  data.undoBlocks = Object.fromEntries(Object.entries(data.undoBlocks)
    .filter(([, value]) => value.createdAt > now - 5 * 60_000).slice(-19));
  data.undoBlocks[actionId] = { createdAt: now, entries, removedAllowlist };
  await api.storage.local.set(data);

  // Reporting remains best-effort and cannot hold up another local mutation.
  if (data.reportingConsent?.enabled === true) {
    submitToBackend(info).catch((err) => console.warn("[ASB] submission failed:", err.message));
  }
  return { ok: true, ...data, undoToken: actionId };
}

async function persistEvent(msg) {
  if (msg.kind !== "video" && msg.kind !== "overview") throw new Error("Invalid event kind");
  const { events } = await api.storage.local.get({ events: [] });
  const updated = appendEvent(events, msg.kind, msg.mins);
  await api.storage.local.set({ events: updated });
  return { ok: true };
}

function removePersonalEntry(personal, channelAliases, kind, key) {
  delete personal[kind][key];
  if (kind !== "channels") return;
  const id = globalThis.ASBChannels?.canonical(key, channelAliases) || key;
  for (const channel of Object.keys(personal.channels)) {
    if ((globalThis.ASBChannels?.canonical(channel, channelAliases) || channel) === id) delete personal.channels[channel];
  }
  for (const [videoId, meta] of Object.entries(personal.videos)) {
    const linked = meta.channelBlock && (globalThis.ASBChannels?.canonical(meta.channelBlock, channelAliases) || meta.channelBlock);
    if (linked === id) delete personal.videos[videoId];
  }
}

async function removeBlock(msg) {
  if ((msg.storageKey !== "videos" && msg.storageKey !== "channels") ||
      typeof msg.id !== "string" || !msg.id || msg.id.length > 256 ||
      ["__proto__", "constructor", "prototype"].includes(msg.id)) throw new Error("Invalid block removal");
  const { personal, channelAliases } = await api.storage.local.get({ personal: { videos: {}, channels: {} }, channelAliases: {} });
  removePersonalEntry(personal, channelAliases, msg.storageKey, msg.id);
  await api.storage.local.set({ personal });
  return { ok: true, personal };
}

async function undoBlock(msg) {
  if (typeof msg.token !== "string") throw new Error("Invalid undo request");
  const data = await api.storage.local.get({ personal: { videos: {}, channels: {} }, allowlist: { videos: {}, channels: {} }, channelAliases: {}, undoBlocks: {}, events: [], blockedCount: 0 });
  const undo = Object.hasOwn(data.undoBlocks, msg.token) ? data.undoBlocks[msg.token] : null;
  if (!undo || undo.createdAt < Date.now() - 5 * 60_000) throw new Error("This block can no longer be undone. Remove it in Settings.");
  let restored = false;
  const normalizedKey = (kind, id) => kind === "channels" ? ASBChannels.canonical(id, data.channelAliases) : id;
  for (const { kind, id, before } of undo.entries) {
    const key = kind === "channels" ? ASBChannels.canonical(id, data.channelAliases) : id;
    if (data.personal[kind][key]?.actionId !== msg.token) continue;
    restored = true;
    if (before) data.personal[kind][key] = before;
    else delete data.personal[kind][key];
  }
  // Undo can arrive out of order from different tabs. Rewire later snapshots
  // so undoing those actions cannot resurrect an already-undone block.
  for (const later of Object.values(data.undoBlocks)) {
    for (const entry of later.entries) {
      if (entry.before?.actionId !== msg.token) continue;
      entry.before = undo.entries.find((prior) => prior.kind === entry.kind && normalizedKey(prior.kind, prior.id) === normalizedKey(entry.kind, entry.id))?.before || null;
      later.removedAllowlist ||= [];
      later.removedAllowlist.push(...(undo.removedAllowlist || []));
    }
  }
  if (restored) {
    const tokens = Object.keys(data.undoBlocks);
    const laterTokens = tokens.slice(tokens.indexOf(msg.token) + 1);
    for (const exception of undo.removedAllowlist || []) {
      const conflicts = laterTokens.some((token) => data.undoBlocks[token].entries.some((entry) => {
        const key = normalizedKey(entry.kind, entry.id);
        const current = data.personal[entry.kind][key];
        if (current?.actionId !== token) return false;
        return exception.kind === "videos" ? entry.kind === "videos" && key === exception.id
          : (entry.kind === "channels" ? key : ASBChannels.canonical(current.channelId, data.channelAliases)) === normalizedKey("channels", exception.id);
      }));
      if (!conflicts) data.allowlist[exception.kind][exception.id] ||= exception.value;
    }
  }
  delete data.undoBlocks[msg.token];
  data.events = data.events.filter((event) => event.actionId !== msg.token);
  data.blockedCount = Math.max(0, data.blockedCount - 1);
  await api.storage.local.set(data);
  return { ok: true };
}

async function setAllowance(msg) {
  if (!["videos", "channels"].includes(msg.kind) || !validId(msg.id, msg.kind)) throw new Error("Invalid exception");
  const data = await api.storage.local.get({ allowlist: { videos: {}, channels: {} }, personal: { videos: {}, channels: {} }, channelAliases: {} });
  const id = msg.kind === "channels" ? ASBChannels.canonical(msg.id, data.channelAliases) : msg.id;
  if (msg.allowed === true) {
    removePersonalEntry(data.personal, data.channelAliases, msg.kind, id);
    data.allowlist[msg.kind][id] = { name: String(msg.name || id).slice(0, 100), addedAt: Date.now() };
  } else if (msg.allowed === false) delete data.allowlist[msg.kind][id];
  else throw new Error("Invalid exception choice");
  await api.storage.local.set({ allowlist: data.allowlist, personal: data.personal });
  return { ok: true };
}

const TRANSFER_LIMIT = 2 * 1024 * 1024;
function cleanSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Invalid settings");
  const result = {};
  for (const key of ["hideAIOverview", "hideYouTube", "showCardButtons"]) {
    if (!(key in settings)) continue;
    if (typeof settings[key] !== "boolean") throw new Error("Invalid filter setting");
    result[key] = settings[key];
  }
  if ("watchAction" in settings) {
    if (!["overlay", "redirect", "next", "sidebar"].includes(settings.watchAction)) throw new Error("Invalid playback setting");
    result.watchAction = settings.watchAction;
  }
  return result;
}

function cleanLists(lists) {
  if (!lists || typeof lists !== "object" || Array.isArray(lists)) throw new Error("Invalid lists");
  const result = { videos: {}, channels: {} };
  for (const kind of ["videos", "channels"]) {
    const entries = Object.hasOwn(lists, kind) ? lists[kind] : {};
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length > 5000) throw new Error("Invalid or oversized list");
    for (const [rawId, meta] of Object.entries(entries)) {
      if (!validId(rawId, kind) || !meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid block entry");
      const id = kind === "channels" ? ASBChannels.normalize(rawId) : rawId;
      if (!id) throw new Error("Invalid channel");
      result[kind][id] = { addedAt: Number.isFinite(meta.addedAt) && meta.addedAt >= 0 ? meta.addedAt : Date.now() };
      for (const key of ["name", "channelName"]) {
        if (typeof meta[key] === "string") result[kind][id][key] = meta[key].slice(0, 100);
      }
      for (const key of ["channelId", "channelBlock"]) {
        if (typeof meta[key] === "string" && validId(meta[key], "channels")) result[kind][id][key] = ASBChannels.normalize(meta[key]);
      }
    }
  }
  return result;
}

async function exportData() {
  const data = await api.storage.local.get({ personal: { videos: {}, channels: {} }, allowlist: { videos: {}, channels: {} }, settings: DEFAULT_SETTINGS });
  return { ok: true, data: { format: "ai-slop-blocker", version: 1, exportedAt: new Date().toISOString(),
    personal: cleanLists(data.personal), allowlist: cleanLists(data.allowlist), settings: cleanSettings(data.settings) } };
}

async function importData(msg) {
  if (typeof msg.text !== "string" || new TextEncoder().encode(msg.text).length > TRANSFER_LIMIT) throw new Error("Choose a JSON backup smaller than 2 MB");
  let input;
  try { input = JSON.parse(msg.text); } catch { throw new Error("This file is not valid JSON"); }
  if (input?.format !== "ai-slop-blocker" || input.version !== 1) throw new Error("Unsupported AI Slop Blocker backup");
  // Validate the entire file before the first write. Only portable keys are copied.
  const personal = cleanLists(input.personal), allowlist = cleanLists(input.allowlist || { videos: {}, channels: {} });
  const settings = cleanSettings(input.settings || {});
  const stored = await api.storage.local.get({ personal: { videos: {}, channels: {} }, allowlist: { videos: {}, channels: {} }, settings: DEFAULT_SETTINGS, channelAliases: {} });
  let added = 0;
  for (const key of ["personal", "allowlist"]) {
    const incoming = key === "personal" ? personal : allowlist;
    for (const kind of ["videos", "channels"]) {
      for (const [rawId, meta] of Object.entries(incoming[kind])) {
        const id = kind === "channels" ? ASBChannels.canonical(rawId, stored.channelAliases) : rawId;
        if (!Object.hasOwn(stored[key][kind], id)) { stored[key][kind][id] = meta; added++; }
      }
      if (Object.keys(stored[key][kind]).length > 5000) throw new Error("Merged list exceeds 5,000 entries");
    }
  }
  stored.settings = { ...stored.settings, ...settings };
  delete stored.channelAliases;
  await api.storage.local.set(stored);
  return { ok: true, added };
}

async function saveSettings(msg) {
  const change = cleanSettings(msg.settings);
  const { settings } = await api.storage.local.get({ settings: DEFAULT_SETTINGS });
  await api.storage.local.set({ settings: { ...settings, ...change } });
  return { ok: true };
}

async function setReporting(msg) {
  if (typeof msg.enabled !== "boolean") throw new Error("Invalid reporting choice");
  if (msg.enabled && !await hasReportPermission()) throw new Error("Allow optional report data in Firefox before enabling sharing");
  const reportingConsent = { enabled: msg.enabled, updatedAt: Date.now() };
  const change = { reportingConsent };
  const { installId } = await api.storage.local.get("installId");
  // Repair older missing/invalid state inside the same mutation queue as
  // installation setup. The UUID stays local while reporting is disabled.
  if (!validInstallId(installId)) change.installId = crypto.randomUUID();
  await api.storage.local.set(change);
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

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await queueMutation(async () => {
    const stored = await api.storage.local.get(["installId", "settings", "reportingConsent"]);
    const change = {};
    // No install ping: creating this local UUID does not contact the backend.
    if (!validInstallId(stored.installId)) change.installId = crypto.randomUUID();
    if (!stored.settings) change.settings = DEFAULT_SETTINGS;
    if (!stored.reportingConsent) change.reportingConsent = DEFAULT_REPORTING_CONSENT;
    if (Object.keys(change).length) await api.storage.local.set(change);
  });

  api.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  api.alarms.create(BADGE_ALARM, { periodInMinutes: 30 });
  syncCommunityBlocklist();
  updateBadge();
  // Present the optional choice without enabling sharing or interrupting an
  // existing install when it receives an update.
  if (reason === "install") api.runtime.openOptionsPage().catch(() => {});
});

api.runtime.onStartup.addListener(async () => {
  // Re-sync on browser start if the cache is older than one sync interval.
  const { community } = await api.storage.local.get("community");
  const age = Date.now() - (community?.syncedAt || 0);
  if (age > SYNC_INTERVAL_MINUTES * 60 * 1000) syncCommunityBlocklist();
  updateBadge();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncCommunityBlocklist();
  if (alarm.name === BADGE_ALARM) updateBadge();
});

// ---------------------------------------------------------------------------
// Icon badge: how much slop was blocked TODAY (YouTube blocks + AI Overviews)
// ---------------------------------------------------------------------------

async function updateBadge() {
  try {
    const { events } = await api.storage.local.get({ events: [] });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = events.filter((e) => e.t >= startOfDay.getTime()).length;
    await api.action.setBadgeBackgroundColor({ color: "#e11d48" });
    await api.action.setBadgeText({ text: today ? String(today) : "" });
  } catch { /* badge is cosmetic */ }
}

api.storage.local.onChanged.addListener((changes) => {
  if (changes.events) updateBadge();
});

// ---------------------------------------------------------------------------
// Community blocklist sync
// ---------------------------------------------------------------------------

let syncInFlight;
async function fetchCommunityList(url, kind) {
  const res = await fetch(url, { cache: "no-cache", credentials: "omit", signal: globalThis.AbortSignal?.timeout?.(15_000) });
  if (!res.ok) throw new Error(`Community download failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length > 10_000) throw new Error("Invalid community list");
  const ids = [], metadata = {}, seen = new Set();
  for (const entry of data) {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!validId(id, kind)) throw new Error("Community list contains an invalid identifier");
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
    if (entry && typeof entry === "object") metadata[id] = {
      name: typeof entry.name === "string" ? entry.name.slice(0, 100) : "",
      reason: typeof entry.reason === "string" ? entry.reason.slice(0, 300) : "",
    };
  }
  return { ids, metadata };
}

function syncCommunityBlocklist() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = performCommunitySync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function performCommunitySync() {
  const attemptedAt = Date.now();
  try {
    const [videoList, channelList] = await Promise.all([
      fetchCommunityList(BLOCKLIST_VIDEOS_URL, "videos"),
      fetchCommunityList(BLOCKLIST_CHANNELS_URL, "channels"),
    ]);
    const videos = videoList.ids, channels = channelList.ids;
    let channelCount;
    await queueMutation(async () => {
      const { communityChannelBindings } = await api.storage.local.get({ communityChannelBindings: {} });
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
      await api.storage.local.set({
        community: { videos, channels: resolved, syncedAt: Date.now(),
          metadata: { videos: videoList.metadata, channels: Object.fromEntries(Object.entries(channelList.metadata)
            .map(([id, meta]) => [bindings[ASBChannels.normalize(id)] || ASBChannels.normalize(id), meta])) } },
        communityChannelBindings: bindings,
        communitySync: { attemptedAt, error: null },
      });
    });
    return { ok: true, videos: videos.length, channels: channelCount };
  } catch {
    const error = "Couldn't update community lists. Check your connection and try again.";
    await queueMutation(() => api.storage.local.set({ communitySync: { attemptedAt, error } }));
    return { ok: false, error };
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
    const { reportingConsent, installId } = await api.storage.local.get({
      reportingConsent: DEFAULT_REPORTING_CONSENT,
      installId: null,
    });
    if (reportingConsent?.enabled !== true || !installId || !await hasReportPermission()) return;
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

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  if (["asb-import", "asb-export", "asb-settings"].includes(msg?.type)) {
    const pages = msg.type === "asb-settings" ? ["options/", "popup/"] : ["options/"];
    if (!pages.some((path) => sender.url?.startsWith(api.runtime.getURL(path)))) {
      sendResponse({ ok: false, error: "Open Settings to transfer your lists" });
      return false;
    }
    queueMutation(() => msg.type === "asb-export" ? exportData() : msg.type === "asb-import" ? importData(msg) : saveSettings(msg)).then(
      sendResponse, (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }
  if (msg?.type === "asb-set-reporting") {
    const fromSettings = ["options/", "popup/"].some((path) =>
      sender.url?.startsWith(api.runtime.getURL(path))
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
      storage: api.storage.local,
      fetchPage: fetchChannelPage,
      mutate: queueMutation,
    });
    resolveChannelIdentities(msg.ids).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  const mutations = {
    "asb-block": persistBlock,
    "asb-log-event": persistEvent,
    "asb-undo": undoBlock,
    "asb-allow": setAllowance,
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
