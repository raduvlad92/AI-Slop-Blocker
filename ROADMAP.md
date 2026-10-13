# Review implementation plan

Review items 1–5 are implemented. Release preparation now includes optional
reporting consent, privacy/retention materials, store artwork, and a Settings
screenshot. The production Worker, hosted policy, and release package are
verified, and the private review workflow completed its first successful run.
The user's real desktop Chrome test remains pending; nothing has been submitted
or published to the Web Store.

## Current batch

- [x] 1. Repair thumbnail actions and retry watch overlays for delayed/replaced players.
- [x] 2. Serialize personal blocks, counters, events and removals through the background worker.
- [x] 3. Hide only self-contained Google AI Overview content; preserve all organic results.
- [x] 4. Require administrator credentials for stats/review/digest and add independent reporting limits.
- [x] 5. Resolve channel IDs/handle aliases, anchor blocks to canonical creators, and protect Shorts playback.

Verification: 82 Node regressions, 12 real-browser fixtures using the actual
extension scripts, a Worker build dry run, production API/database smoke checks,
and release ZIP validation. Fixtures mock reports and channel requests; they do
not establish full live YouTube compatibility or an unpacked Chrome test.

## Release preparation

- [x] Optional future-report consent, off by default and separate from filter settings; no upload of existing local blocks on opt-in.
- [x] Exact reporting disclosure, packaged/public policy source, 90-day raw-report retention/cleanup, and privacy contact `contact@deletecookies.dev`.
- [x] Transparent PNG icons at 16/32/48/128px, SVG sources, and a 440×280 promotional PNG.
- [x] Store listing, permissions/data-handling declarations, and reviewer instructions.
- [x] `store/screenshot-settings-1280x800.png`: actual Options HTML/JavaScript captured with a fresh-install Chrome API fixture. This is not a live unpacked-extension test.
- [x] Production Worker at `https://aislopblocker-api.radu-vlad-92.workers.dev`: health/policy responses, byte-identical hosted/packaged policy, D1 report storage, duplicate prevention, protected admin endpoints, aggregate review output, and 06:00 UTC cleanup configuration verified. Smoke-test report removed.
- [x] First private GitHub Actions review run succeeded using `ASB_API_URL`, `ASB_STATS_KEY`, and read-only `GET /review`, with no persistent GitHub PAT in the Worker: [run 38476767542](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38476767542).
- [x] Release ZIP 0.1.1: 19 files / 45,892 bytes; CRC, resources, endpoint/permission/icon/policy contents, and secret exclusion verified. SHA-256 recorded in the accompanying checksum file.
- [ ] User tests the unpacked extension in desktop Chrome on live Google/YouTube.
- [ ] Owner completes developer-account verification and dashboard declarations, then authorizes store upload/submission/publication.

Both public community lists are currently empty. A reviewed starter list is an
optional later improvement, not completed release protection.

## Parked for later

- **6. Recovery from mistakes:** Undo, Watch once, Always allow, and clear personal/community blocking reasons. The existing behavior where blocking a channel also blocks its current video remains; removing that channel can leave the video blocked.
- **Starter community lists:** seed with manually reviewed entries; no automatic promotion.
- **List management:** export/import, search, readable video titles and links.
- **Sync status:** show failed updates and stale cached lists clearly.
- **Statistics:** distinguish manual block actions from hidden content and make estimated time savings explicit.
- **Accessibility:** menu focus, Escape dismissal and accessible toast feedback.
- **Broader automation:** CI for extension/backend changes and a larger live navigation/markup compatibility matrix. Focused regressions for this batch are included now.

Manual community curation, no accounts and no AI-detection heuristics remain the product boundaries.
