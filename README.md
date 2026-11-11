# 🤖🚫 AI Slop Blocker

A free, local-first desktop extension for **Chrome, Firefox and Zen**. Version
**0.2.0** adds Firefox/Zen support, portable backups, recovery controls and
community exceptions. Store signing, submission and publication are still pending.

- **Google Search:** hide positively identified English-labelled AI Overviews
  while keeping ordinary search results visible.
- **YouTube:** manually block videos or channels from watch pages and Shorts,
  with optional thumbnail controls for feeds, search and recommendations.
- **Recovery:** Undo a recent block, Watch once for the current visit, or Always
  allow a video/channel across personal and community matches.
- **Playback:** show a blocking overlay, redirect home, skip to the next video,
  or play a sidebar recommendation. The overlay explains the block's source.
- **Settings:** search/open list entries, export/import personal blocks,
  exceptions and settings, and inspect community sync failures or overdue updates.

There is no AI detector or automatic classification of ordinary content. Google
and YouTube layout changes can affect compatibility. The public community lists
are currently empty; personal blocking and Google filtering work independently.

## Install for development

Use Node 22.13+ and Python 3.9+:

```sh
npm ci
npm run package
```

The package command generates validated ZIPs, checksums and unpacked directories:

- `releases/AI-Slop-Blocker-0.2.0-chrome.zip` and `releases/chrome/`
- `releases/AI-Slop-Blocker-0.2.0-firefox.zip` and `releases/firefox/`

In Chrome, enable Developer mode in `chrome://extensions`, select **Load
unpacked**, and choose `releases/chrome/` (or the source `extension/` folder).

In Firefox or Zen **142+**, open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on**, and select `releases/firefox/manifest.json`. The same
Firefox build works in Zen. Temporary installs end when the browser restarts;
normal persistent Firefox installation requires Mozilla signing, including for
self-distribution. See [Firefox release preparation](store/FIREFOX.md).

The source manifest targets Chrome. Packaging creates Firefox's background event
page and Mozilla-specific manifest fields from the same source; do not load the
Chrome-only source manifest directly into Firefox.

## Blocking, recovery and backups

Open an English Google Search with an AI Overview, or use the **🤖 AI Slop**
button under a YouTube video/on a Short. Thumbnail buttons are optional in
Settings. A blocked player explains whether its video or channel matched your
personal list or the community list, including a community review reason when
available.

**Undo** appears in the block confirmation for eight seconds; its token lasts up
to five minutes. It restores that action without overwriting subsequent edits.
Undo and local removal do not retract any report already sent. **Watch once**
applies only in that tab for the current visit, ending on navigation/reload.
**Always allow** saves a permanent local exception, manageable in Settings, and
applies to both personal and community blocks. Explicitly blocking again clears matching video and channel exceptions.

New channel blocks track the companion video they create. Removing the channel
also removes its companion videos, while keeping independently blocked videos.
Older blocks lack this relationship metadata; remove surviving legacy video
entries separately.

**Export backup** creates a versioned JSON file with personal blocks, exceptions
and filter/playback settings. **Import backup** validates the complete file and
merges new entries, keeping existing entries and applying imported settings.
Imports are limited to 2 MB and 5,000 entries per list. Installation IDs,
reporting consent, statistics, cached community data and Undo history are never
transferred. Importing does not send reports. Backups stay in the file you save;
protect them like your other personal files.

## Privacy and optional reporting

No accounts or payments are required. Personal lists, exceptions, settings,
statistics, identity mappings and cached community lists use local extension
storage. **Share my future block reports** is off by default. Enabling it never
uploads existing blocks or sends installation telemetry. Disabling it stops
future reports and pending retries.

Opted-in reports contain `{videoId, channelId, channelName, scope, installId}`
when available; channel reports also identify their current video. A random UUID
is generated locally on installation, retained on update, and sent only with
opted-in future reports. The server derives a contributor hash for deduplication,
limits and private moderation. IDs represent installations, not verified people.

Firefox/Zen additionally require the native optional report-data permission.
Granting that permission alone does not enable sharing. Revocation disables
sharing, and every submission attempt checks permission again.

There is no upload of full browsing/search/watch histories or local statistics.
Public GitHub list downloads and credential-free YouTube metadata lookups for
already blocked or allowed channels can still occur with sharing off. Downloaded data is
never executed as remote code.

Raw reports and moderation history expire after 90 days. A minimal hashed ignore
registry can remain until resumed/deleted. GitHub review snapshots contain only
aggregates; curated public history can remain. See the [packaged policy](extension/privacy.html)
and [backend documentation](backend/README.md). The November 11 policy sources
also document Firefox and backups; the updated public policy was deployed and byte-verified on November 11. Privacy/support: **contact@deletecookies.dev**.

## Community curation

1. Optional reports are retained in the Cloudflare Worker/D1 backend.
2. The private `raduvlad92/AI-Slop-Review` repository's daily Actions workflow
   requests administrator-protected `GET /review` and commits aggregate
   `REVIEW.md`/`review.json` using its ephemeral repository token.
3. A maintainer reviews candidates and proposes public entries by PR to
   `blocklist/videos.json` or `blocklist/channels.json`. Marking a report useful
   does not publish it; there is no automatic promotion.
4. Installs fetch the public lists every six hours, or through **Sync now**.
   Failed updates preserve the previous valid cache and display an error.

See [CONTRIBUTING.md](blocklist/CONTRIBUTING.md). Maintainer report moderation is
available separately through `npm run review:admin` at `127.0.0.1:8768`; its
credential stays in the local Node process and is never packaged in the extension.

## Verification

```sh
npm test                       # Node, including backend SQLite and consent/storage regressions
npm run validate               # public blocklist structure
npx playwright install chromium firefox
npm run test:browser:ci         # controlled DOM regressions in Chromium and Firefox
npm run package                # both archives; manifest/resource/policy/CRC checks
npm run lint:firefox            # Mozilla manifest and source lint; warnings fail
npm run test:extension          # actual installed extension, isolated profiles, local fixtures
```

The installed-extension smoke suite checks real APIs, installation defaults,
message round trips, import/export, Undo, Google filtering and YouTube recovery
without production reports. It tests Chromium and Firefox; it also tests native
Zen when available at `/Applications/Zen.app/Contents/MacOS/zen` or
`ASB_ZEN_BINARY`. `ASB_FIREFOX_BINARY` can override the Firefox executable.

PR CI runs the Node/backend tests, blocklist validation, both DOM engines,
packaging, Firefox lint and installed Chromium/Firefox checks. Zen's native smoke
is local when its binary is available. Controlled fixtures do not establish live
Google/YouTube compatibility, restart behavior of signed packages, or store
approval. See [release evidence](store/RELEASE-CHECKS.md),
[submission preparation](store/SUBMISSION.md) and [ROADMAP.md](ROADMAP.md).
