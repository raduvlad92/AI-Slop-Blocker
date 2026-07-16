const DEFAULTS = {
  settings: { hideAIOverview: true, hideYouTube: true },
  blockedCount: 0,
};

const $ = (id) => document.getElementById(id);

async function render() {
  const data = await chrome.storage.local.get(DEFAULTS);
  $("counter").textContent = data.blockedCount.toLocaleString();
  $("toggle-google").checked = data.settings.hideAIOverview;
  $("toggle-youtube").checked = data.settings.hideYouTube;
}

async function saveSettings() {
  await chrome.storage.local.set({
    settings: {
      hideAIOverview: $("toggle-google").checked,
      hideYouTube: $("toggle-youtube").checked,
    },
  });
}

$("toggle-google").addEventListener("change", saveSettings);
$("toggle-youtube").addEventListener("change", saveSettings);
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
