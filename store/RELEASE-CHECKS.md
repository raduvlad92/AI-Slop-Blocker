# Release checks — 0.1.1

Verified on October 14, 2026 (Europe/Berlin). The release is prepared for the
owner's live unpacked Chrome test. It has not been uploaded to the Chrome Web
Store, submitted for review, or published.

## Production service

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

## Private review

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

## Source, assets, and package

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

## Remaining owner checks

1. Load `extension/` through `chrome://extensions` → Developer mode → Load unpacked.
2. Test live English Google AI Overviews, YouTube cards/watch pages/Shorts,
   playback preferences, persistence, block removal, and default-off reporting.
   Enable reporting only when intentionally testing report submission.
3. After that test, complete developer-account verification and the exact
   dashboard privacy/listing/distribution fields before store submission.

Live Chrome testing and marketplace approval remain pending. Deferred product
work stays in [ROADMAP.md](../ROADMAP.md).
