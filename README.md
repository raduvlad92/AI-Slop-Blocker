# 🤖🚫 AI Slop Blocker

> **⚠️ Work in progress** — under active development. A free release on the
> Chrome Web Store is planned soon.

A free, lightweight Chrome extension that hides AI-generated content:

- **Google Search** *(optional, can be toggled off in settings)* — removes the
  AI Overview / SGE box.
- **YouTube** — a "🤖 AI Slop" button under the video you're watching (and
  optionally on every thumbnail); one click hides the video or the whole
  channel instantly and forever, everywhere it appears.

## Privacy & why we collect anything at all

No accounts. No payments. No tracking. Your block list, settings, and stats
live in `chrome.storage.local` on your device — we never see your browsing,
your identity, or your watch history.

When you block a video or
channel, an anonymous report — `{videoId, channelId, scope}` plus a random
UUID generated at install (used only for rate limiting, tied to nothing) —
goes to our server.

**Why?** To build a curated community blocklist. Individual blocks from many
users get reviewed by a human, and the worst offenders are added to a public
list that every install syncs automatically — so instead of playing
whack-a-mole one video at a time, you instantly block a LOT of known AI slop
channels and videos out of the box. Think of it like the filter lists a good
ad blocker ships with: the community finds the junk, everyone benefits. The
list is public, auditable (every entry has a date and reason), and curated
manually to prevent abuse — see
[blocklist/CONTRIBUTING.md](blocklist/CONTRIBUTING.md).

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
3. **[/blocklist](blocklist/)** — the public community list: two JSON arrays
   of `{id, name, added, reason}` entries fetched directly by every install
   (the extension uses only `id`; the rest keeps the list auditable — what was
   added, when, and why). Curated **manually** from the
   stats feed via PRs — never auto-merged (that's the anti-brigading defense;
   see [blocklist/CONTRIBUTING.md](blocklist/CONTRIBUTING.md)). A GitHub
   Action validates the JSON on every PR.

Channel matching resolves blocked channels' public YouTube metadata without
cookies, caches their canonical `UC…` IDs and current handles for seven days,
and keeps existing personal/community blocks tied to the resolved creator.
Only channels already on a block list are looked up. Failed lookups preserve
the existing ID/handle match. Directly opened Shorts use the same block button
and playback protection; their next-video action uses Shorts navigation.

## Running the extension locally

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select the `extension/` folder.
2. Search anything on Google → the AI Overview box is gone.
3. Open any YouTube video → click **🤖 AI Slop** next to the channel row under
   the player → pick "Block this video" or "Block channel". Blocked videos
   vanish from feeds/search/sidebar and the counter ticks up. To also get the
   overlay button on every thumbnail, enable "Show block button on thumbnails"
   in settings (off by default).
4. The popup / options page (right-click the extension icon → Options) has the
   toggles, both block lists, and your slop counter.

The community blocklist syncs from this repo
(`raw.githubusercontent.com/raduvlad92/AI-Slop-Blocker/main/blocklist/…`).
Before shipping, replace the backend URL placeholder in
[extension/config.js](extension/config.js) and the matching `host_permissions`
entry in [extension/manifest.json](extension/manifest.json) with the deployed
Worker URL. Icons are also still TODO (the Web Store requires 16/48/128px
PNGs).

## Permissions rationale (Chrome Web Store review)

manifest.json is strict JSON so the justifications live here:

| Permission | Why |
|---|---|
| `storage` | Personal block list, settings, slop counter, cached community list — all local. |
| `alarms` | The 6-hour community blocklist re-sync. |
| `*://*.google.com/search*` | Content script that hides the AI Overview box. Scoped to search pages only. |
| `*://*.youtube.com/*` | Block button, filtering and anonymous public metadata lookups for blocked channels. |
| `https://raw.githubusercontent.com/*` | Fetching the public blocklist JSON (unauthenticated, public files). |
| `https://aislopblocker-api…workers.dev/*` | Fire-and-forget anonymous block submissions. |

## Non-goals

- No AI-detection heuristics for regular Google results — too unreliable.
- No accounts, logins, or payments, ever.
- No automatic promotion of submissions into the public blocklist.

## Development checks

With Node 22.13 or later, no dependency installation is needed:

```sh
npm test
npm run validate
npm run test:browser
```

Open `http://127.0.0.1:8766/` for browser regressions. If that port is busy,
use `ASB_TEST_PORT=8767 npm run test:browser`. The browser suite runs the actual
extension scripts against controlled DOM fixtures with mocked Chrome APIs and
network responses; it never sends reports. Node tests cover storage races,
Google safety, identity resolution and backend authentication/quotas, including
real in-memory SQLite for the SQL. These checks complement manual unpacked
extension testing on live Google/YouTube.

See [ROADMAP.md](ROADMAP.md) for the selected implementation batch and parked work.
