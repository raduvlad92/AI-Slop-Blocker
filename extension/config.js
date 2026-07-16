// Central config for the extension's network endpoints.
// Update these before shipping (and keep host_permissions in manifest.json in sync).

// Cloudflare Worker that collects anonymous block submissions (see /backend).
export const BACKEND_URL = "https://aislopblocker-api.YOUR-SUBDOMAIN.workers.dev";

// Public community blocklist, fetched straight from GitHub raw (no auth, plain JSON).
// Replace YOUR-GH-USER/aislopblocker with the real repo path once pushed.
export const BLOCKLIST_VIDEOS_URL =
  "https://raw.githubusercontent.com/YOUR-GH-USER/aislopblocker/main/blocklist/videos.json";
export const BLOCKLIST_CHANNELS_URL =
  "https://raw.githubusercontent.com/YOUR-GH-USER/aislopblocker/main/blocklist/channels.json";

// How often to re-sync the community blocklist (chrome.alarms, minutes).
export const SYNC_INTERVAL_MINUTES = 360; // 6 hours
