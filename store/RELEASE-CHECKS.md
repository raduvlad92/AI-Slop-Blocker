# Release checks — 0.1.2

## Contributor moderation update

Verified on October 14, 2026 (Europe/Berlin). Backend version
`b314e62b-28b7-457c-ab7b-519f85befad1` is deployed. Worker preview URLs remain
disabled; the public API and 06:00 UTC cleanup schedule remain enabled.

- Fresh installation creates a local random UUID. Valid existing IDs survive
  updates, worker restarts, and consent toggles. No installation ping or new
  IP/country/email collection was added; reports still require opt-in.
- Applied additive migration `0002_contributor_moderation.sql` once. Preserved
  the five existing reports and privately backfilled their contributor hashes.
  After deployment and verification: **five reports, one contributor, no legacy
  NULL identifiers, zero ignored contributors**.
- Protected contributor/history/review/moderation endpoints reject anonymous
  calls with 401. Histories expose derived contributor IDs and retained report
  metadata, with no raw installation UUIDs.
- Live tests used only synthetic new reports. Marking a report false positive
  excluded its vote from rankings; useful/reset controls worked. Ignoring its
  contributor removed earlier votes, and a later submission returned a neutral
  success response without a database insert. Resuming allowed submission again.
  Deleted all three synthetic reports and removed their temporary ignore rule.
  The real five reports were not moderated or removed.
- The private local admin tool (`npm run review:admin`) loaded the production
  counts and five retained histories. Its administrator credential remained in
  the local process; browser requests and DOM contained no credential. The UI
  had no console errors. It binds only `127.0.0.1` and rejects cross-site/Host
  attacks. Transport ignores user curl defaults and rejects redirects.
- **118/118 automated Node tests passed**, including real SQLite migration,
  backfill, pagination, review, ignore/resume, retention, and atomic ignore
  checks; installation races; and five private-admin security tests.
- **12/12 extension browser fixtures** and **8 moderation browser checks**
  passed. Moderation checks used synthetic data and covered failed selection,
  text-safe rendering, judgment changes, ignore/resume, and an expired ignored
  ID. Isolated Chromium was used after the collaborative preview timed out and
  Chrome automation blocked the local URL.
- Updated Settings screenshot uses the actual current Options UI with a
  fresh-install Chrome API fixture at 1280×800. Viewed the screenshot; optional
  sharing remains unchecked and its updated disclosure is legible.
- The new hosted policy is byte-identical to both local source copies. It
  discloses 90-day report/review history and the persistent minimal hashed ignore
  registry, which remains until manually resumed/deleted.
- [Private workflow run 38489277906](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38489277906)
  succeeded. Fetched its actual `REVIEW.md`/`review.json`: contributor summary
  counts are active 1 / eligible 1 / ignored 0, with five channel candidates.
  No raw UUIDs, contributor hashes, individual histories, or moderator notes are
  archived in GitHub.
- ZIP `releases/AI-Slop-Blocker-0.1.2.zip`: **19 files, 47,020 bytes**, CRC/content
  checks passed; manifest at root, current policy and matching production host.
  Backend/admin/test files and administrator credentials are excluded.
  SHA-256: `46a6a977d37a691632e1ed0b437dcdf0ef1bf231e417f05f06e48e3470f497ed`.

The owner previously tested 0.1.1 successfully. Reload/retest the updated 0.1.2
unpacked extension before Chrome Web Store submission. Public-list promotion
remains a manual PR; ignoring a contributor does not automatically remove any
already published entry. Installation IDs are not verified people and can be
reset by reinstalling/clearing local data or deliberately rotated by a client.

## Previous release — 0.1.1 baseline

Verified on October 14, 2026 (Europe/Berlin). The release is prepared for the
owner's live unpacked Chrome test. It has not been uploaded to the Chrome Web
Store, submitted for review, or published.

### Production service

- Worker: https://aislopblocker-api.radu-vlad-92.workers.dev
- Public policy: https://aislopblocker-api.radu-vlad-92.workers.dev/privacy
- New D1 database: `aislopblocker`, `1233bb19-fb79-47f7-beed-ed3bd8209ede`.
- New rate-limit namespaces: `80741001` and `80741002`. Existing unrelated
  Workers and databases were preserved.
- Schema and all four indexes applied successfully. Remote binding inspection
  confirmed D1, both edge limiters, public-list variables, and `STATS_KEY`.
  No `GITHUB_TOKEN` is configured in the Worker.

| Live check | Result |
| --- | --- |
| `GET /health` | 200, expected service identity |
| `GET /privacy` | 200, byte-identical to the packaged policy |
| Unauthenticated `GET /stats` and `/review` | 401 |
| `GET /digest` | 405; no write |
| `OPTIONS /submit` | Empty 204 |
| Synthetic `POST /submit` | 200, accepted; D1 row confirmed |
| Repeat of the same report | Rejected as duplicate |
| Authenticated `GET /review` | 200; aggregate included the test item and excluded its raw installation UUID |
| Test-data cleanup | Synthetic row removed; zero reports remained |
| Authenticated `GET /stats` after cleanup | 200, empty results |
| Public GitHub video/channel JSON | Both 200, both empty arrays |

Daily cleanup is configured at **06:00 UTC**. The 90-day expiry and cleanup SQL
are covered by the automated backend tests. A scheduled production cleanup has
not yet been observed; configured scheduling and actual execution are separate.

### Private review

The private `raduvlad92/AI-Slop-Review` repository has the daily workflow,
`ASB_API_URL` variable, and encrypted `ASB_STATS_KEY` secret configured.
The job uses an ephemeral repository-scoped token with `contents: write`.
Its committed workflow matches [the template](../backend/review-workflow.yml).

The [verified manual run](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38476767542)
succeeded and committed `REVIEW.md` and `review.json`. The output files were
fetched and checked for the expected aggregate structure, empty categories
after cleanup, and absence of raw UUIDs or the administrator secret.
The verified snapshot commit is `986fc9d4f13a1010602cd1f39144b554665d9d67`,
authored by `github-actions[bot]`.

An initial run was rejected with Cloudflare error 1010 when using Python's
default User-Agent. The workflow now sends an explicit service User-Agent.
Redirects are rejected, and the bearer credential is not forwarded to another
origin. The corrected run succeeded.

### Source, assets, and package

- **82/82 Node tests passed**, including real in-memory SQLite SQL checks.
- **12/12 browser fixture checks passed**, running the actual extension scripts
  with mocked Chrome/network APIs. These are not live Google/YouTube tests.
- Public blocklist validation and the Worker 4.150.0 build dry run passed.
- Icons and promotional artwork were visually checked; PNG dimensions and
  transparency match the submission draft. The Settings screenshot is actual
  Options HTML/JavaScript with a fresh-install Chrome API fixture at 1280×800.
- Consent is off by default. Opt-in reports contain the disclosed fields; old
  blocks are not replayed and opt-out stops future reports/retries.
- `npm run package` produced `releases/AI-Slop-Blocker-0.1.1.zip`:
  **19 files, 45,892 bytes**. Manifest is at the ZIP root. CRC checks passed,
  every packaged file matches its source, production host permissions match,
  policy copies match, and backend/test files and the admin secret are excluded.
- SHA-256: `7be53ce03e657defa7389afc5e994395a3e546186dacf3585aaaf0e76505b8b8`.

### Remaining owner checks at that release

1. Load `extension/` through `chrome://extensions` → Developer mode → Load unpacked.
2. Test live English Google AI Overviews, YouTube cards/watch pages/Shorts,
   playback preferences, persistence, block removal, and default-off reporting.
   Enable reporting only when intentionally testing report submission.
3. After that test, complete developer-account verification and the exact
   dashboard privacy/listing/distribution fields before store submission.

Live Chrome testing and marketplace approval remain pending. Deferred product
work stays in [ROADMAP.md](../ROADMAP.md).
