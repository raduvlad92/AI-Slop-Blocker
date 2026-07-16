// Options page logic — vanilla JS, reads/writes chrome.storage.local directly.

const DEFAULTS = {
  settings: { hideAIOverview: true, hideYouTube: true },
  personal: { videos: {}, channels: {} },
  community: { videos: [], channels: [], syncedAt: 0 },
  blockedCount: 0,
};

const $ = (id) => document.getElementById(id);

async function render() {
  const data = await chrome.storage.local.get(DEFAULTS);

  $("counter").textContent = data.blockedCount.toLocaleString();
  $("toggle-google").checked = data.settings.hideAIOverview;
  $("toggle-youtube").checked = data.settings.hideYouTube;

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

$("toggle-google").addEventListener("change", saveSettings);
$("toggle-youtube").addEventListener("change", saveSettings);
async function saveSettings() {
  await chrome.storage.local.set({
    settings: {
      hideAIOverview: $("toggle-google").checked,
      hideYouTube: $("toggle-youtube").checked,
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
