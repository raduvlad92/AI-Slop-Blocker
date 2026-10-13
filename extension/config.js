// Central config for the extension's network endpoints.
// Keep host_permissions in manifest.json in sync with these endpoints.

// Cloudflare Worker that collects optional pseudonymous block reports (see /backend).
export const BACKEND_URL = "https://aislopblocker-api.radu-vlad-92.workers.dev";

// Public community blocklist, fetched straight from GitHub raw (no auth, plain JSON).
export const BLOCKLIST_VIDEOS_URL =
  "https://raw.githubusercontent.com/raduvlad92/AI-Slop-Blocker/main/blocklist/videos.json";
export const BLOCKLIST_CHANNELS_URL =
  "https://raw.githubusercontent.com/raduvlad92/AI-Slop-Blocker/main/blocklist/channels.json";

// How often to re-sync the community blocklist (chrome.alarms, minutes).
export const SYNC_INTERVAL_MINUTES = 360; // 6 hours
