// Options page logic — vanilla JS, reads/writes chrome.storage.local directly.

const DEFAULTS = {
  settings: {
    hideAIOverview: true,
    hideYouTube: true,
    showCardButtons: false,
    watchAction: "overlay",
  },
  personal: { videos: {}, channels: {} },
  community: { videos: [], channels: [], syncedAt: 0 },
  blockedCount: 0,
  events: [],
};

const $ = (id) => document.getElementById(id);

async function render() {
  const data = await chrome.storage.local.get(DEFAULTS);

  $("counter").textContent = data.blockedCount.toLocaleString();
  $("toggle-google").checked = data.settings.hideAIOverview;
  $("toggle-youtube").checked = data.settings.hideYouTube;
  $("toggle-card-buttons").checked = !!data.settings.showCardButtons;
  const action = data.settings.watchAction || "overlay";
  const radio = document.querySelector(`input[name="watchAction"][value="${action}"]`);
  if (radio) radio.checked = true;

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

  renderStats(data.events);

  const { videos, channels, syncedAt } = data.community;
  $("community-summary").textContent =
    `${videos.length.toLocaleString()} videos · ${channels.length.toLocaleString()} channels`;
  $("last-synced").textContent = syncedAt
    ? `Last synced ${new Date(syncedAt).toLocaleString()}`
    : "Not synced yet";
}

function renderList(listEl, countEl, entries, labelFn, storageKey) {
  countEl.textContent = `(${entries.length})`;
  listEl.textContent = "";

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing blocked yet.";
    listEl.appendChild(li);
    return;
  }

  // Newest first
  entries.sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));

  for (const [id, meta] of entries) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "id";
    label.textContent = labelFn(id, meta);
    label.title = id;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      const { personal } = await chrome.storage.local.get({ personal: DEFAULTS.personal });
      delete personal[storageKey][id];
      await chrome.storage.local.set({ personal });
      render();
    });

    li.append(label, btn);
    listEl.appendChild(li);
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
document
  .querySelectorAll('input[name="watchAction"]')
  .forEach((r) => r.addEventListener("change", saveSettings));
async function saveSettings() {
  // Merge over stored settings so keys managed elsewhere aren't clobbered.
  const { settings } = await chrome.storage.local.get({ settings: DEFAULTS.settings });
  await chrome.storage.local.set({
    settings: {
      ...settings,
      hideAIOverview: $("toggle-google").checked,
      hideYouTube: $("toggle-youtube").checked,
      showCardButtons: $("toggle-card-buttons").checked,
      watchAction:
        document.querySelector('input[name="watchAction"]:checked')?.value || "overlay",
    },
  });
}

$("sync-now").addEventListener("click", async () => {
  $("sync-now").disabled = true;
  $("sync-now").textContent = "Syncing…";
  try {
    await chrome.runtime.sendMessage({ type: "asb-sync-now" });
  } finally {
    $("sync-now").disabled = false;
    $("sync-now").textContent = "Sync now";
    render();
  }
});

// Reflect changes made elsewhere (blocking from YouTube while this tab is open).
chrome.storage.local.onChanged.addListener(render);

render();
