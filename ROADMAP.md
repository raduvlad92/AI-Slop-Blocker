# Review implementation plan

Review items 1–5 and release 0.1.2's contributor backend, migration, disclosures,
tests, screenshot, package, real private admin view, and updated GitHub review
run/output are verified. The user's live unpacked desktop Chrome 0.1.2 retest is
pending. Nothing has been submitted or published to the Web Store.

## Current batch

- [x] 1. Repair thumbnail actions and retry watch overlays for delayed/replaced players.
- [x] 2. Serialize personal blocks, counters, events and removals through the background worker.
- [x] 3. Hide only self-contained Google AI Overview content; preserve all organic results.
- [x] 4. Require administrator credentials for stats/review/digest and add independent reporting limits.
- [x] 5. Resolve channel IDs/handle aliases, anchor blocks to canonical creators, and protect Shorts playback.

Release 0.1.2 passed 118 Node tests, 12 actual-extension browser fixtures, eight
private admin synthetic browser checks, and five helper security checks, plus
production migration/API moderation checks and ZIP validation. Controlled fixtures
do not establish full live YouTube compatibility or an unpacked Chrome test.

## Release 0.1.2 contributor review

- [x] Updated disclosure/policy source: ID generated locally on install, opt-in future reports only, private retained contributor histories, and no new email/IP/country report fields or install telemetry.
- [x] Retention documented: reports and review status/history expire after 90 days; minimal hashed ignored-ID records remain until manual resume/deletion; GitHub snapshots remain aggregate-only.
- [x] Installation-ID initialization/default-OFF/no-replay regressions pass.
- [x] Additive 0002 migration/private hash backfill completed without losing real reports; report status, ignored past votes, rejected future insertion, resume, pagination/retention regressions and admin access checks pass.
- [x] Private admin synthetic UI/security checks pass with the credential held only in the Node process, including failed selection, safe text rendering, status/ignore/resume, expired resume, CSRF/Host and no-redirect checks.
- [x] Real production read-only `npm run review:admin` view at `127.0.0.1:8768` opened contributor/report history with no exposed admin credential/browser Authorization header or console errors; real reports untouched.
- [x] Updated production policy is byte-identical to local copies; migration/admin/moderation smoke checks verified and synthetic records/rules removed.
- [x] Updated private Actions [run 38489277906](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38489277906) succeeded; actual Markdown/JSON snapshots show aggregate active/eligible/ignored counts without UUIDs, contributor hashes, individual histories, or reasons.
- [x] Actual 1280×800 Settings fixture screenshot regenerated and viewed, with sharing off.
- [x] Release ZIP 0.1.2 verified: 19 files / 47,020 bytes; SHA-256 `46a6a977d37a691632e1ed0b437dcdf0ef1bf231e417f05f06e48e3470f497ed`; admin/backend/scripts/tests/secrets excluded.

Ignoring a contributor's reports does not disable local blocking/list sync or
automatically remove published community entries. Installation IDs are not
verified people; resetting or changing them can evade an ignore.

## Verified 0.1.1 baseline

- [x] Optional future-report consent, off by default and separate from filter settings; no upload of existing local blocks on opt-in.
- [x] Exact reporting disclosure, packaged/public policy source, 90-day raw-report retention/cleanup, and privacy contact `contact@deletecookies.dev`.
- [x] Transparent PNG icons at 16/32/48/128px, SVG sources, and a 440×280 promotional PNG.
- [x] Store listing, permissions/data-handling declarations, and reviewer instructions.
- [x] `store/screenshot-settings-1280x800.png`: actual Options HTML/JavaScript captured with a fresh-install Chrome API fixture. This is not a live unpacked-extension test.
- [x] Production Worker at `https://aislopblocker-api.radu-vlad-92.workers.dev`: health/policy responses, byte-identical hosted/packaged policy, D1 report storage, duplicate prevention, protected admin endpoints, aggregate review output, and 06:00 UTC cleanup configuration verified. Smoke-test report removed.
- [x] First private GitHub Actions review run succeeded using `ASB_API_URL`, `ASB_STATS_KEY`, and read-only `GET /review`, with no persistent GitHub PAT in the Worker: [run 38476767542](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38476767542).
- [x] Release ZIP 0.1.1: 19 files / 45,892 bytes; CRC, resources, endpoint/permission/icon/policy contents, and secret exclusion verified. SHA-256 recorded in the accompanying checksum file.
- [ ] User retests unpacked extension 0.1.2 in desktop Chrome on live Google/YouTube.
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
