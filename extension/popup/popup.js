const DEFAULTS = {
  settings: {
    hideAIOverview: true,
    hideYouTube: true,
    showCardButtons: false,
    watchAction: "overlay",
  },
  blockedCount: 0,
  reportingConsent: { enabled: false, updatedAt: 0 },
  events: [],
};

const $ = (id) => document.getElementById(id);

function formatMinutes(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

async function render() {
  const data = await chrome.storage.local.get(DEFAULTS);
  $("counter").textContent = data.blockedCount.toLocaleString();
  $("toggle-google").checked = data.settings.hideAIOverview;
  $("toggle-youtube").checked = data.settings.hideYouTube;
  $("reporting-status").textContent = data.reportingConsent?.enabled === true
    ? "Community report sharing is on."
    : "Community report sharing is off.";

  const action = data.settings.watchAction || "overlay";
  const radio = document.querySelector(`input[name="watchAction"][value="${action}"]`);
  if (radio) radio.checked = true;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = data.events.filter((e) => e.t >= startOfDay.getTime()).length;
  $("today-pill").textContent = `${today} today`;

  // "Brain rot avoided": sum of blocked video lengths (estimated at 8 min
  // when the duration wasn't visible at block time).
  const mins = data.events
    .filter((e) => e.kind === "video")
    .reduce((sum, e) => sum + (e.mins || 8), 0);
  $("brainrot-pill").textContent = `🧠 ${formatMinutes(mins)} saved`;
}

async function saveSettings() {
  // Merge over stored settings — the popup doesn't own showCardButtons.
  const { settings } = await chrome.storage.local.get({ settings: DEFAULTS.settings });
  await chrome.storage.local.set({
    settings: {
      ...settings,
      hideAIOverview: $("toggle-google").checked,
      hideYouTube: $("toggle-youtube").checked,
      watchAction:
        document.querySelector('input[name="watchAction"]:checked')?.value || "overlay",
    },
  });
}

$("toggle-google").addEventListener("change", saveSettings);
$("toggle-youtube").addEventListener("change", saveSettings);
document
  .querySelectorAll('input[name="watchAction"]')
  .forEach((r) => r.addEventListener("change", saveSettings));
$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.local.onChanged.addListener(render);
render();
