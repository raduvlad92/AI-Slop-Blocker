# 🤖🚫 AI Slop Blocker

> **Release 0.1.2 verified** — the contributor backend/migration, updated privacy
> policy, tests, Settings screenshot, ZIP, private admin view, and GitHub review
> workflow are verified. The user's unpacked Chrome 0.1.2 retest,
> developer-account checks, and Web Store submission are not completed.

A free, local-first extension for desktop Chrome that lets you choose what to
hide on Google Search and YouTube:

- **Google Search** — hides positively identified, English-labelled AI Overview
  answer boxes while preserving ordinary results. The filter can be toggled off.
- **YouTube** — a "🤖 AI Slop" button on watch pages and Shorts lets you manually
  block a video or channel. An optional thumbnail button makes blocking available
  on supported feeds, searches, and recommendations.
- **Playback choices** — a blocked overlay, redirect to the YouTube homepage,
  skip to the next video, or play a sidebar recommendation.

The extension does not automatically classify ordinary content or run an AI
detector. Google and YouTube can change their layouts, so compatibility can
change. **The public community lists are currently empty**; personal blocking
and Google filtering work independently.

## Privacy and optional community reports

No accounts or payments are required. Personal block lists, settings, statistics,
and cached lists live in `chrome.storage.local` on your device. **Sharing reports
is off by default.** In Settings, **Share my future block reports** explicitly
enables future reports; changing filter settings does not grant consent. Enabling
sharing does not upload existing local blocks, and turning it off stops future
reports and pending retries.

When you opt in, a report contains `{videoId, channelId, channelName, scope,
installId}` when available; a channel block also includes its current video.
The random installation UUID is generated locally on installation; updates keep
a valid ID and repair a missing/invalid one. It stays on the device while sharing
is off. There is no automatic installation telemetry, separate install event, or
UUID upload when consent is enabled. With opted-in future reports it supports
deduplication, limits, and contributor review. The backend derives a stable
SHA-256 contributor ID from it. These identifiers are not verified people;
reinstalling, resetting local data, or choosing a new client ID can evade ignores.
The server adds a receipt time. Full search, browsing and watch histories,
accounts, email addresses, and local statistics are not uploaded.

The reporting service uses Cloudflare's connection information for short-lived,
IP-derived abuse counters without storing raw IP addresses in D1. Raw UUID-linked
reports and their review statuses/history expire after 90 days, are excluded from
review aggregates, and are removed by daily cleanup. A minimal ignored-ID registry
keeps the contributor hash, optional moderator reason, and update time until a
moderator resumes or deletes it. Historical private aggregate snapshots and public
curated Git history can remain. Turning off sharing or removing a local block does not retract
earlier reports. See the [packaged privacy policy](extension/privacy.html) and
the [public policy](https://aislopblocker-api.radu-vlad-92.workers.dev/privacy).
The October 14 policy update is live and byte-identical to both local policy copies.

GitHub list downloads and public YouTube channel-metadata requests can still
occur with reporting off. Channel lookups only concern already blocked channels
and omit browser credentials. They do not carry the installation UUID or personal
block list. These public downloads are parsed as data; remote scripts are not
executed.

Reports help a human review candidates for a public community blocklist. Every
addition is a manually reviewed PR; reports never automatically become public
blocks. See [blocklist/CONTRIBUTING.md](blocklist/CONTRIBUTING.md). Privacy and
support contact: **contact@deletecookies.dev**.

The private contributor view lets a moderator inspect retained report history
and counts, mark reports pending/useful/false positive, and choose **Ignore
reports** or **Resume reports** for an installation-derived contributor ID.
Ignoring excludes its past and future reports from community review; local
blocking and list sync keep working. It does not automatically remove published
community entries. GitHub review files contain aggregate counts only, never raw
UUIDs, contributor hashes, individual histories, or moderator reasons.

Installation/country statistics come from Chrome Web Store metrics if the
extension is published there. The extension adds no installation analytics beacon
or email/IP/country fields to reports; normal hosting connection information is
handled as described in the policy.

## How the pieces connect

1. **[/extension](extension/)** — the Manifest V3 extension. Hides Google's AI
   Overview, adds manual YouTube block controls, stores personal blocks locally,
   and syncs the community lists from GitHub raw every six hours. A block is
   submitted to the reporting API only after explicit opt-in.
2. **[/backend](backend/)** — a single Cloudflare Worker with a D1 database.
   `POST /submit` receives optional reports with per-install and independent
   abuse limits. `GET /privacy` serves the public policy. `GET /stats` and
   read-only `GET /review` require a Bearer administrator credential.
   The private contributor/report moderation endpoints require the same admin
   credential; the extension never receives it.
3. **Private review repository** — a GitHub Actions workflow in
   `raduvlad92/AI-Slop-Review` uses the `ASB_API_URL` repository variable and
   `ASB_STATS_KEY` Actions secret to read `GET /review`. It commits aggregate
   `REVIEW.md` and `review.json` snapshots using the job's ephemeral,
   repository-scoped `GITHUB_TOKEN`. This release mode does not keep a persistent
   GitHub personal access token in the Worker. Human review promotes candidates
   through PRs. The updated workflow completed
   [run 38489277906](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38489277906)
   successfully; the run is accessible to authorized private-repository users.
   Updated aggregate snapshots include active/eligible installation-ID counts
   within 90 days and a persistent ignored-registry count, without contributor
   hashes or histories. The actual Markdown/JSON snapshot format was verified.
4. **[/blocklist](blocklist/)** — the public community list: two JSON arrays
   of `{id, name, added, reason}` entries fetched directly by every install
   (the extension uses only `id`; the rest keeps the list auditable — what was
   added, when, and why). Curated **manually** from the
   review feed via PRs — never auto-merged (that's the anti-brigading defense;
   see [blocklist/CONTRIBUTING.md](blocklist/CONTRIBUTING.md)). A GitHub
   Action validates the JSON on every PR.

See [backend/README.md](backend/README.md) for deployment, admin authentication,
retention, and the private Actions review workflow.

For the maintainer's private contributor view, run `npm run review:admin` and
open `http://127.0.0.1:8768/`. The local Node server uses the already configured
private administrator credential outside the repository. The key stays in that
process; it is not pasted into the browser or put in URLs/browser storage. This
administration tool is separate from the packaged extension. Synthetic UI/helper
security checks and the real production read-only view passed verification. The
actual contributor history opened without exposing the admin secret or browser
Authorization headers, with no console errors and no changes to real reports.

Channel matching resolves blocked channels' public YouTube metadata without
cookies, caches their canonical `UC…` IDs and current handles for seven days,
and keeps existing personal/community blocks tied to the resolved creator.
Only channels already on a block list are looked up. Failed lookups preserve
the existing ID/handle match. Directly opened Shorts use the same block button
and playback protection; their next-video action uses Shorts navigation.

## Running the extension locally

1. `chrome://extensions` → enable Developer mode → **Load unpacked** →
   select the `extension/` folder.
2. Open an English Google Search page that contains an AI Overview → the filter
   hides the identified answer box. A search without an AI Overview has nothing
   to hide.
3. Open any YouTube video → click **🤖 AI Slop** next to the channel row under
   the player → pick "Block this video" or "Block channel". Blocked videos
   vanish from feeds/search/sidebar and the counter ticks up. To also get the
   overlay button on every thumbnail, enable "Show block button on thumbnails"
   in settings (off by default).
4. The popup / options page (right-click the extension icon → Options) has filter
   controls, personal lists, community sync status, estimated statistics, and the
   optional reporting choice. Keep sharing off for local-only block reports.
5. Remove personal entries in Options to restore content. A channel block also
   records its current video, so restoring that video can require removing both
   the channel entry and video entry. Undo, Watch once and community allowlists
   remain deferred.

The community blocklist syncs from this repo
(`raw.githubusercontent.com/raduvlad92/AI-Slop-Blocker/main/blocklist/…`).
The production service is `https://aislopblocker-api.radu-vlad-92.workers.dev`.
Live 0.1.2 checks confirmed protected contributor/moderation endpoints, preserved
existing reports through migration/private hash backfill, and exercised report
status changes, ignored past votes, ignored future submissions without insertion,
and resumed eligibility. Synthetic test reports and ignore rules were removed;
the existing real reports were retained. Daily cleanup is scheduled
for 06:00 UTC; only the administrator secret is stored in the Worker, with no
GitHub token. Both public GitHub raw lists returned successfully and are empty.
PNG icons at 16/32/48/128px, a 440×280 promotional tile,
listing/declaration drafts, and a 1280×800 Settings screenshot are prepared in
[store/](store/). The screenshot captures the actual Options HTML/JavaScript with
a fresh-install Chrome API fixture; it is not evidence of an installed extension
running on live Google or YouTube. See [store/SUBMISSION.md](store/SUBMISSION.md)
for the remaining store checklist. The Settings screenshot was regenerated and
visually checked for the updated 0.1.2 disclosure, with sharing clearly off.

## Permissions rationale (Chrome Web Store review)

manifest.json is strict JSON so the justifications live here:

| Permission | Why |
|---|---|
| `storage` | A local random installation ID, personal block lists, explicit reporting consent, settings, local counters/events, cached lists and channel mappings. |
| `alarms` | Six-hour community list refresh and daily badge updates. |
| `*://*.google.com/search*` | Content script that hides the AI Overview box. Scoped to search pages only. |
| `*://*.youtube.com/*` | Block button, filtering and credential-free public metadata lookups for blocked channels. |
| `https://raw.githubusercontent.com/*` | Fetching the public blocklist JSON (unauthenticated, public files). |
| Reporting Worker host in the release manifest | Best-effort block reports over HTTPS, only after explicit opt-in. |

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
extension testing on live Google/YouTube; the user's 0.1.2 retest remains pending.

`npm run package` builds the release ZIP and checks its assets/configuration.
The locally generated `releases/AI-Slop-Blocker-0.1.2.zip` is verified:
19 extension files, 47,020 bytes, archive CRC/resource checks, matching policy,
production endpoints, and exclusion of admin tools, backend/scripts/tests and
secrets. SHA-256:
`46a6a977d37a691632e1ed0b437dcdf0ef1bf231e417f05f06e48e3470f497ed`.
Generated ZIP/checksum files are excluded from Git; regenerate them with the
package command. See [the release checks](store/RELEASE-CHECKS.md) for live evidence.

Release checks passed 118 Node tests, 12 extension browser fixtures, eight private
admin synthetic browser checks, five helper security checks, the real admin
read-only UI check, and the updated private GitHub review run/output inspection.
Controlled fixtures do not replace the user's live unpacked
desktop Chrome 0.1.2 retest, which remains pending. A verified package is not an accepted
store submission or a published extension.

See [ROADMAP.md](ROADMAP.md) for the selected implementation batch and parked work.
