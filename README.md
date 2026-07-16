# 🤖🚫 AI Slop Blocker

A free, lightweight Chrome extension that hides AI-generated content:

- **Google Search** — removes the AI Overview / SGE box.
- **YouTube** — adds a subtle "🤖 AI Slop" button to every video thumbnail;
  one click hides the video (or the whole channel) instantly and forever,
  everywhere it appears.

No accounts. No payments. No tracking — blocks live in `chrome.storage.local`,
and the only thing ever sent anywhere is an anonymous
`{videoId, channelId, scope}` submission tied to a random install UUID.

## How the pieces connect

```
┌─────────────┐  block click   ┌──────────────────┐   manual review    ┌───────────────┐
│  /extension  │ ─────────────▶ │ /backend          │ ─── /stats ──────▶ │ Vlad merges a │
│  (Chrome MV3)│  POST /submit  │ Cloudflare Worker │                    │ PR into        │
│              │                │ + D1              │                    │ /blocklist     │
│              │ ◀───────────────────────────────────────────────────── │ (public JSON)  │
└─────────────┘  fetch videos.json / channels.json from GitHub raw      └───────────────┘
     every 6h via chrome.alarms
```

1. **[/extension](extension/)** — the Manifest V3 extension. Hides Google's AI
   Overview, overlays the block button on YouTube, keeps a personal block list
   locally, and syncs the community blocklist from GitHub raw every 6 hours.
2. **[/backend](backend/)** — a single Cloudflare Worker with a D1 database.
   `POST /submit` collects anonymous submissions (deduped, rate-limited to
   50/day per install); `GET /stats` shows the most-reported videos/channels
   for manual review. See [backend/README.md](backend/README.md) to deploy.
3. **[/blocklist](blocklist/)** — the public community list: two flat JSON
   arrays fetched directly by every install. Curated **manually** from the
   stats feed via PRs — never auto-merged (that's the anti-brigading defense;
   see [blocklist/CONTRIBUTING.md](blocklist/CONTRIBUTING.md)). A GitHub
   Action validates the JSON on every PR.

## Running the extension locally

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select the `extension/` folder.
2. Search anything on Google → the AI Overview box is gone.
3. Open YouTube, hover a thumbnail → click **🤖 AI Slop** → pick "Block this
   video" or "Block channel". The card vanishes and the counter ticks up.
4. The popup / options page (right-click the extension icon → Options) has the
   toggles, both block lists, and your slop counter.

Before shipping, replace the placeholders in
[extension/config.js](extension/config.js) (backend URL + GitHub raw URLs) and
the matching `host_permissions` entry in
[extension/manifest.json](extension/manifest.json). Icons are also still TODO
(the Web Store requires 16/48/128px PNGs).

## Permissions rationale (Chrome Web Store review)

manifest.json is strict JSON so the justifications live here:

| Permission | Why |
|---|---|
| `storage` | Personal block list, settings, slop counter, cached community list — all local. |
| `alarms` | The 6-hour community blocklist re-sync. |
| `*://*.google.com/search*` | Content script that hides the AI Overview box. Scoped to search pages only. |
| `*://*.youtube.com/*` | Content script for the block button + filtering. |
| `https://raw.githubusercontent.com/*` | Fetching the public blocklist JSON (unauthenticated, public files). |
| `https://aislopblocker-api…workers.dev/*` | Fire-and-forget anonymous block submissions. |

## Non-goals

- No AI-detection heuristics for regular Google results — too unreliable.
- No accounts, logins, or payments, ever.
- No automatic promotion of submissions into the public blocklist.
