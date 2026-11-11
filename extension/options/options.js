const api = typeof browser === "undefined" ? chrome : browser;

// Options page logic — vanilla JS. List mutations go through the background
// worker; settings and rendering use api.storage.local directly.

const DEFAULTS = {
  settings: {
    hideAIOverview: true,
    hideYouTube: true,
    showCardButtons: false,
    watchAction: "overlay",
  },
  personal: { videos: {}, channels: {} },
  reportingConsent: { enabled: false, updatedAt: 0 },
  community: { videos: [], channels: [], syncedAt: 0 },
  allowlist: { videos: {}, channels: {} },
  communitySync: { attemptedAt: 0, error: null },
  blockedCount: 0,
  events: [],
};

const $ = (id) => document.getElementById(id);

async function render() {
  const data = await api.storage.local.get(DEFAULTS);

  $("counter").textContent = data.blockedCount.toLocaleString();
  $("toggle-google").checked = data.settings.hideAIOverview;
  $("toggle-youtube").checked = data.settings.hideYouTube;
  $("toggle-card-buttons").checked = !!data.settings.showCardButtons;
  const action = data.settings.watchAction || "overlay";
  const radio = document.querySelector(`input[name="watchAction"][value="${action}"]`);
  if (radio) radio.checked = true;
  if (!$("toggle-reporting").disabled) {
    $("toggle-reporting").checked = data.reportingConsent?.enabled === true;
  }
  $("reporting-status").textContent = data.reportingConsent?.enabled === true
    ? "Sharing is on for future block reports. You can turn it off at any time."
    : "Sharing is off. New blocks stay on this device.";

  renderList(
    $("my-channels"),
    $("my-channels-count"),
    Object.entries(data.personal.channels),
    (id, meta) => meta.name || id,
    "channels"
  );
  renderList(
    $("my-videos"),
    $("my-videos-count"),
    Object.entries(data.personal.videos),
    (id, meta) => (meta.channelName ? `${id} — ${meta.channelName}` : id),
    "videos"
  );
  const allowed = [...Object.entries(data.allowlist.channels).map(([id, meta]) => [id, { ...meta, kind: "channels" }]),
    ...Object.entries(data.allowlist.videos).map(([id, meta]) => [id, { ...meta, kind: "videos" }])];
  renderList($("allowed-list"), $("allowed-count"), allowed, (id, meta) => meta.name || id, null, "remove-allow");
  const community = [...data.community.channels.map((id) => [id, { ...(data.community.metadata?.channels?.[id] || {}), kind: "channels" }]),
    ...data.community.videos.map((id) => [id, { ...(data.community.metadata?.videos?.[id] || {}), kind: "videos" }])];
  renderList($("community-list"), null, community, (id, meta) => meta.name || id, null, "allow");

  renderStats(data.events);

  const { videos, channels, syncedAt } = data.community;
  $("community-summary").textContent =
    `${videos.length.toLocaleString()} videos · ${channels.length.toLocaleString()} channels`;
  const age = Date.now() - (syncedAt || 0);
  const last = syncedAt ? `Last updated ${new Date(syncedAt).toLocaleString()}.` : "No community list downloaded yet.";
  $("last-synced").textContent = data.communitySync.error
    ? `${data.communitySync.error} ${syncedAt ? "Using the previous list. " : ""}${last}`
    : age > 6 * 60 * 60_000 && syncedAt ? `Update overdue. ${last} Use Sync now to retry.` : last;
  $("last-synced").dataset.state = data.communitySync.error || (syncedAt && age > 6 * 60 * 60_000) ? "warning" : "ok";
}

function renderList(listEl, countEl, entries, labelFn, storageKey, action = "remove") {
  if (countEl) countEl.textContent = `(${entries.length})`;
  const query = $("list-search").value.trim().toLowerCase();
  entries = entries.filter(([id, meta]) => `${id} ${labelFn(id, meta)} ${meta.reason || ""}`.toLowerCase().includes(query));
  listEl.textContent = "";

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = query ? "No matching entries." : action === "allow" ? "No community entries yet." : action === "remove-allow" ? "No exceptions." : "Nothing blocked yet.";
    listEl.appendChild(li);
    return;
  }

  // Newest first
  entries.sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));

  for (const [id, meta] of entries.slice(0, 200)) {
    const li = document.createElement("li");
    const label = document.createElement("a");
    const kind = storageKey || meta.kind;
    label.href = kind === "videos" ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : `https://www.youtube.com/${id.startsWith("@") ? "" : "channel/"}${encodeURIComponent(id)}`;
    label.target = "_blank";
    label.rel = "noopener noreferrer";
    label.className = "id";
    label.textContent = labelFn(id, meta);
    label.title = id;
    if (meta.reason) { const reason = document.createElement("small"); reason.textContent = meta.reason; label.appendChild(reason); }

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = action === "allow" ? "Always allow" : "Remove";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const response = await api.runtime.sendMessage(action === "remove"
          ? { type: "asb-remove-block", storageKey, id }
          : { type: "asb-allow", kind, id, name: meta.name, allowed: action === "allow" });
        if (!response?.ok) throw new Error(response?.error || "Could not remove block");
      } catch (err) {
        $("transfer-status").textContent = "Couldn't save the list change. Please try again.";
      } finally {
        btn.disabled = false;
        render();
      }
    });

    li.append(label, btn);
    listEl.appendChild(li);
  }
  if (entries.length > 200) {
    const more = document.createElement("li");
    more.textContent = "Showing the first 200 matches. Search to narrow the list.";
    listEl.appendChild(more);
  }
}

function formatMinutes(mins) {
  if (!mins) return "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function renderStats(events) {
  // Daily table, last 14 days (today first), zero days included.
  const tbody = $("daily-stats");
  tbody.textContent = "";
  for (let i = 0; i < 14; i++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const next = day.getTime() + 864e5;
    const dayEvents = events.filter((e) => e.t >= day.getTime() && e.t < next);
    const videos = dayEvents.filter((e) => e.kind === "video");
    const overviews = dayEvents.length - videos.length;
    const mins = videos.reduce((s, e) => s + (e.mins || 8), 0);

    const tr = document.createElement("tr");
    const label =
      i === 0 ? "Today" : i === 1 ? "Yesterday"
      : day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    for (const text of [label, videos.length || "—", overviews || "—", formatMinutes(mins)]) {
      const td = document.createElement("td");
      td.textContent = String(text);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Hour-of-day histogram over the whole log.
  const byHour = new Array(24).fill(0);
  for (const e of events) byHour[new Date(e.t).getHours()]++;
  const max = Math.max(1, ...byHour);
  const chart = $("hour-chart");
  chart.textContent = "";
  byHour.forEach((count, hour) => {
    const col = document.createElement("div");
    col.className = "hour-col";
    col.title = `${String(hour).padStart(2, "0")}:00 — ${count} blocked`;
    const bar = document.createElement("div");
    bar.className = "hour-bar";
    bar.style.height = `${Math.round((count / max) * 100)}%`;
    const label = document.createElement("span");
    label.className = "hour-label";
    label.textContent = hour % 6 === 0 ? String(hour) : "";
    col.append(bar, label);
    chart.appendChild(col);
  });
}

$("toggle-google").addEventListener("change", saveSettings);
$("toggle-youtube").addEventListener("change", saveSettings);
$("toggle-card-buttons").addEventListener("change", saveSettings);
$("toggle-reporting").addEventListener("change", async () => {
  const toggle = $("toggle-reporting");
  const enabled = toggle.checked;
  toggle.disabled = true;
  $("reporting-status").textContent = "Saving your choice…";
  try {
    if (enabled && api.runtime.getBrowserInfo) {
      const types = api.runtime.getManifest().browser_specific_settings.gecko.data_collection_permissions.optional;
      const granted = await api.permissions.request({ data_collection: types });
      if (!granted) throw new Error("Report sharing needs the optional Firefox data permission.");
    }
    const response = await api.runtime.sendMessage({ type: "asb-set-reporting", enabled });
    if (!response?.ok) throw new Error(response?.error || "Could not save reporting choice");
    toggle.disabled = false;
    await render();
  } catch (error) {
    toggle.disabled = false;
    await render();
    $("reporting-status").textContent = error.message || "Couldn't save your choice. Please try again.";
  }
});
document
  .querySelectorAll('input[name="watchAction"]')
  .forEach((r) => r.addEventListener("change", saveSettings));
async function saveSettings() {
  try {
    const result = await api.runtime.sendMessage({ type: "asb-settings", settings: {
      hideAIOverview: $("toggle-google").checked,
      hideYouTube: $("toggle-youtube").checked,
      showCardButtons: $("toggle-card-buttons").checked,
      watchAction: document.querySelector('input[name="watchAction"]:checked')?.value || "overlay",
    } });
    if (!result?.ok) throw new Error("Couldn't save your settings. Please try again.");
  } catch {
    await render();
    $("transfer-status").textContent = "Couldn't save your settings. Please try again.";
  }
}

$("sync-now").addEventListener("click", async () => {
  $("sync-now").disabled = true;
  $("sync-now").textContent = "Syncing…";
  let transportError = false;
  try {
    await api.runtime.sendMessage({ type: "asb-sync-now" });
  } catch {
    transportError = true;
  } finally {
    $("sync-now").disabled = false;
    $("sync-now").textContent = "Sync now";
    await render();
    if (transportError) $("last-synced").textContent = "Couldn't contact the extension. Reload this page and try again.";
  }
});

// Reflect changes made elsewhere (blocking from YouTube while this tab is open).
api.storage.local.onChanged.addListener(render);

render();

$("list-search").addEventListener("input", render);
$("export-data").addEventListener("click", async () => {
  try {
    const result = await api.runtime.sendMessage({ type: "asb-export" });
    if (!result?.ok) throw new Error(result?.error || "Couldn't export your backup");
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-slop-blocker-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $("transfer-status").textContent = "Backup exported. Installation IDs, reporting consent, reports and statistics are excluded.";
  } catch (error) { $("transfer-status").textContent = error.message; }
});
$("import-data").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0];
  if (!file) return;
  $("import-data").disabled = true;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Choose a JSON backup smaller than 2 MB");
    const result = await api.runtime.sendMessage({ type: "asb-import", text: await file.text() });
    if (!result?.ok) throw new Error(result?.error || "Couldn't import this backup");
    $("transfer-status").textContent = `Imported ${result.added} new entries. Existing entries were kept. Sharing choice unchanged; no reports sent.`;
    await render();
  } catch (error) { $("transfer-status").textContent = error.message; }
  finally { $("import-data").disabled = false; $("import-file").value = ""; }
});
