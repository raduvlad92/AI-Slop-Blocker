# AI Slop Blocker — Backend

A single Cloudflare Worker + D1 database that receives optional, pseudonymous
block reports from the extension. Reporting is off by default and requires
explicit opt-in. The extension creates a random installation UUID locally on
installation and repairs missing/invalid legacy IDs on update. It sends no
automatic install event or UUID on install/consent changes. Future opted-in
reports contain that UUID (`installId`),
video/channel identifiers, an optional channel name, scope, and receipt time.
The UUID links reports from one installation; it is not a verified person or
an account. Full browsing/search/watch histories and local statistics are not
uploaded. The Worker derives a SHA-256 contributor ID for private review/ignore
controls. Installation IDs are client-generated, not verified people; resets or
new IDs can evade ignores. Public policy: `GET /privacy`, updated October 14, 2026.

The contributor moderation upgrade is deployed for release **0.1.2**. Migration,
private legacy hash backfill, production endpoint/moderation checks, updated
policy equality, synthetic admin/security tests, and the release package are
verified. The real production read-only admin view and updated private GitHub
review run/output were also verified without changing real reports.

## Endpoints

### `GET /health`

Returns `{ "ok": true, "service": "ai-slop-blocker" }` without querying D1 or
exposing bindings, secrets, report counts, or installation identifiers. This
is a basic Worker response check; it does not certify database connectivity,
configured admin access, or successful digest execution.

### `GET /privacy`

Serves the public, self-contained HTML policy in `privacy.html`, including the
operator's public identity and privacy contact `contact@deletecookies.dev`.
Wrangler imports HTML as text automatically; no asset host or extra binding
is required. The release package copies this policy into
`extension/privacy.html` so the local and hosted copies match.

### `POST /submit`

Body: `{ videoId, channelId, channelName, scope: "video" | "channel", installId }`

- Validates shape strictly (11-char video IDs, `UC…` IDs or `@handles`, UUID installId).
- Dedupes: the same install can't submit the same video/channel again while
  the original report is retained (unique indexes + `INSERT OR IGNORE`).
- Derives a stable SHA-256 contributor identifier from `installId`. Ignored
  identifiers' past/future reports do not contribute to community review. This
  does not affect client-local blocking or public-list sync.
- Independent edge limits: 60 attempts/minute per connecting IP address and
  300 attempts/minute across the endpoint, before reading the body or querying
  D1. Rotating `installId` cannot reset these limits.
- The per-source key is a daily-changing hash of Cloudflare's `CF-Connecting-IP`
  header, used only for short-lived edge counters. Neither the address nor the
  hash is stored in D1 or sent to the review repo. Caller-supplied
  `X-Forwarded-For` is never trusted.
- Cloudflare's counters are approximate and per location, not a global quota.
  People on the same shared IP can share a limit. Adjust the conservative limits
  and unique account namespace IDs in `wrangler.toml` for observed traffic.
  See [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
  and [request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
- The existing limit of 50 accepted submissions per installId per rolling 24h
  is enforced in one conditional database insert, including concurrent requests.
- Throttled requests return a polite `429`; unavailable/missing edge bindings
  or a missing Cloudflare client-IP header return `503`, without a database
  write. The user's local blocks still work in either case.
- Request bodies are capped at 2,048 UTF-8 bytes while reading the stream.

An `installId` is a client-chosen identifier, not a verified person. These
limits reduce request abuse; rankings remain signals for **manual review**.

### `GET /stats`

Returns the top 100 submitted videos and channels by submission count.
Requires `Authorization: Bearer <STATS_KEY>`. Set a secret with
`wrangler secret put STATS_KEY`. An unset/empty secret disables this endpoint
(`503`); a missing/wrong credential returns `401` before querying D1.
Credentials in URL query parameters are not accepted.

### `GET /review`

Requires `Authorization: Bearer <STATS_KEY>` and has the same fail-closed
authentication as `/stats`. Returns exactly `{ digest, markdown }`:

- `digest` keeps the existing `generatedAt`, `totals`, and `categories` shape.
  Categories are `video`, `channel`, `domain`, and `page`. The last two are
  future placeholders. Video/channel entries include `id`, `name`, `blocks`,
  `firstSeen`, `lastSeen`, `url`, `listed`, and `isNew`.
- `markdown` contains the full human-readable `REVIEW.md` text.
- Contributor summary counts cover distinct active/eligible installation IDs
  within the 90-day report window and the persistent ignored-ID registry count.
  The registry count can remain nonzero after all associated reports expire.

This is a read-only endpoint. It queries active report aggregates and fetches
the public blocklists to flag already-listed items. It never deletes reports,
writes to D1, writes to GitHub, or returns raw installation UUIDs, contributor
hashes, individual histories, or moderation reasons. A Worker
`GITHUB_TOKEN` is not required, and any configured token is not used by this
endpoint. Responses are not cached.

### Private contributor moderation

Every endpoint below requires `Authorization: Bearer <STATS_KEY>`, fails closed
when the credential is missing/unconfigured, and is for the administrator only.
The public extension does not receive this credential.

| Endpoint | Purpose |
| --- | --- |
| `GET /contributors?limit=50&offset=0` | Paginated hashed contributor IDs with retained report counts/summary. |
| `GET /contributors/:64hex?limit=50&before=reportID` | One hashed contributor's retained report history, counts, and moderation state. `before` pages toward older report IDs. |
| `PUT /contributors/:64hex/moderation` | `{ignored: boolean, reason?: string}` — ignore or resume that identifier; optional reason is limited to 300 characters. |
| `PUT /reports/:positiveInt/review` | `{status: "pending" \| "useful" \| "false_positive"}` — manually classify one retained report. |

List/history defaults are 50 records, with a maximum of 100 per request. Reports
and their review statuses/history are visible only within the 90-day retention
window. Contributor IDs identify installations, not verified humans. A moderator
can ignore all that ID's past and future reports for community review or resume
eligibility; this never automatically edits the public curated lists.

The minimal ignore registry retains the SHA-256 contributor ID, optional reason,
and update time until manual resume/deletion. It does not retain the expired
report history, emails, IP addresses, or countries. The normal short-lived
IP-derived abuse counters remain separate from this registry.

For the maintainer, run `npm run review:admin` from the repository root and open
`http://127.0.0.1:8768/`. The Node launcher uses the previously configured private
administrator credential outside the repository. The credential stays in the
Node process and is never pasted into the browser, placed in a URL, or stored in
browser storage. The UI lists contributors/details, report counts/history and
pending/useful/false-positive controls, plus **Ignore reports**/**Resume reports**
with an optional reason. This tool is not packaged with the extension. Its
synthetic browser/security checks and real production read-only view passed.
The real view displayed contributor history with no browser Authorization header
or admin secret in the DOM, no console errors, and no changes to real reports.

Installation/country metrics come from the Chrome Web Store, if published there;
there is no new extension telemetry or email/IP/country report collection.

### Daily review digest → private GitHub repo (recommended)

Use a scheduled GitHub Actions workflow **inside the private**
`raduvlad92/AI-Slop-Review` repository to pull `/review` and commit two files:

- `REVIEW.md` — human-readable: one table per category (YouTube channels,
  YouTube videos; domain/page are placeholders for a future website-blocking
  feature), ranked by **distinct reported install identifiers**, with
  clickable links, first/last seen dates, and flags: 🆕 activity in the last
  24h, ✅ already on the public blocklist.
- `review.json` — the same data, machine-readable.

GitHub snapshots remain aggregate-only. Contributor summary counts do not export
raw UUIDs, hashes, individual report histories, or moderator reasons. Historical
aggregate snapshots can remain in private Git history after individual reports
expire or a contributor becomes ignored.

Configure the workflow with the Worker URL and an encrypted Actions secret
containing the Worker `STATS_KEY`. The workflow calls `GET /review`, saves
`markdown` as `REVIEW.md` and `digest` as `review.json`, then commits them using
its ephemeral, repository-scoped `GITHUB_TOKEN`. Give that job only
`permissions: contents: write` and serialize runs so commits do not race.
See [GitHub's workflow token documentation](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token).

Keep `GITHUB_TOKEN` **unset in the Worker** for this mode. No personal GitHub
token is required, and the local GitHub CLI's broader login token must not be
copied into the Worker. The Worker daily cron (06:00 UTC) still prunes expired
raw reports; with no repository token configured, it performs cleanup without
attempting a GitHub push or logging a missing-token error. `/review` excludes
expired reports independently, even if the Actions pull and cleanup overlap.

Review workflow: read REVIEW.md on GitHub → promote
entries by PR into `blocklist/*.json` in the public repo (they'll show ✅ in
the next digest).

### `POST /digest` (optional legacy Worker push)

For an existing installation that intentionally keeps repository writes in
the Worker, `POST /digest` with `Authorization: Bearer <STATS_KEY>` remains
supported. It prunes expired rows and pushes both files using a separately
configured Worker `GITHUB_TOKEN`. Without that token it returns `500` rather
than performing a GitHub write. `GET /digest` returns `405` and never writes.
A configured token also enables the existing daily cron push after cleanup.

### Report retention

Raw UUID-linked reports and their review statuses/history expire after **90 days**.
Contributor views, `/stats`, `/review`, and new digests exclude expired records
even if cleanup has been delayed. Ignored IDs' reports are excluded from eligible
community review. The minimal ignored-ID hash/reason/update registry remains
until a moderator manually resumes/deletes it, independently of report expiry.
The daily cron deletes expired reports and their review records and optionally
pushes a digest in legacy mode. A manual
`POST /digest` also prunes before generating its snapshot. A digest failure
does not undo a completed cleanup; a cleanup failure stops that digest run.

Daily cleanup normally removes expired rows on its next run, so service
interruptions can delay physical deletion. Cloudflare's recovery backups may
retain deleted records for up to 30 additional days, depending on the plan.
Historical private GitHub aggregate snapshots and public curated lists/Git
history can remain indefinitely. Review files contain no raw install UUIDs,
contributor hashes, individual histories, or reasons.

Turning off reporting stops future reports; it does not retract previously
received ones. Local block removal and uninstalling also do not delete server
reports. There is no public UUID lookup or client deletion endpoint. The
policy offers the maintainer's email for privacy requests and describes the
automatic expiry behavior.

**Optional legacy token setup:**

1. Create a **fine-grained PAT** at github.com → Settings → Developer settings
   → Fine-grained tokens: repository access = *only* `AI-Slop-Review`,
   permissions = Contents: Read and write. Nothing else.
2. `wrangler secret put GITHUB_TOKEN` and paste it.

## Deploy

The 0.1.2 contributor backend is deployed at
`https://aislopblocker-api.radu-vlad-92.workers.dev`. This checkout's Wrangler
configuration already identifies the production account/database and rate-limit
namespaces. For an update to this deployment, keep those bindings and run
`wrangler deploy`; do not create another database. Live checks and the verified
private review run are recorded in [store/RELEASE-CHECKS.md](../store/RELEASE-CHECKS.md).
The additive 0002 migration and private legacy hash backfill completed without
losing existing reports. Live tests confirmed administrator protection, status
changes, ignored historical votes and future submissions without insertion, and
resume behavior. Synthetic reports/rules were removed after testing. The updated
hosted policy is byte-identical to both source copies; ZIP 0.1.2 is verified.
The updated private GitHub review [run 38489277906](https://github.com/raduvlad92/AI-Slop-Review/actions/runs/38489277906)
succeeded. Its actual Markdown/JSON outputs were checked for aggregate contributor
counts and exclusion of UUIDs, hashes, and individual histories.

For a **fresh installation in another account**, replace the account/database
IDs and select unused rate-limit namespaces before following these steps:

```sh
cd backend
npm install -g wrangler   # version 4.36.0 or later for rate-limit bindings

# 1. Create the database and copy its id into wrangler.toml
wrangler d1 create aislopblocker

# 2. Apply the schema
wrangler d1 execute aislopblocker --remote --file=schema.sql

# 3. Required for /stats, /review, and legacy /digest access
wrangler secret put STATS_KEY

# Recommended: leave GITHUB_TOKEN unset in the Worker and use private-repo Actions.
# Legacy Worker push only: wrangler secret put GITHUB_TOKEN

# 4. Deploy
wrangler deploy
```

After deploying, put the Worker URL into `extension/config.js`
(`BACKEND_URL`) and the matching entry in `extension/manifest.json`
`host_permissions`.

Keep both `ratelimits` bindings in every deployed Wrangler environment;
bindings are not inherited by named environments. Before deploying, confirm
the namespace IDs are not used by another rate limiter on your account.

The recommended review workflow is provided in
[`review-workflow.yml`](review-workflow.yml). Install it as
`.github/workflows/review.yml` in a private review repository, set `ASB_API_URL`
and the encrypted `ASB_STATS_KEY`, then run it manually once. Its explicit
service User-Agent avoids rejection of Python's default client signature by
the deployed edge; redirects are rejected so the admin credential stays on the
configured origin.

For an existing database, apply the additive retention index migration:

```sh
wrangler d1 execute aislopblocker --remote --file=migrations/0001_report_retention.sql
```

The migration only adds a `createdAt` index. Cleanup occurs on the next daily
cron or authenticated manual digest; take any required recovery backup before
running cleanup against existing production data. New databases get the same
index from `schema.sql`.

The production 0.1.2 contributor migration is already applied. For another
existing deployment that has not applied it, the additive migration command is:

```sh
wrangler d1 execute aislopblocker --remote --file=migrations/0002_contributor_moderation.sql
```

Existing report UUIDs must also be backfilled privately to their contributor
hashes as part of an upgrade. This deployment's backfill completed with no legacy
NULL contributor hashes and preserved its real reports. Do not reapply a completed
migration merely to use the admin view.

## Smoke test

```sh
curl https://<your-worker>/health
curl https://<your-worker>/privacy

curl -X POST https://<your-worker>/submit \
  -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","channelId":"@example","channelName":"Example","scope":"video","installId":"123e4567-e89b-42d3-a456-426614174000"}'

curl https://<your-worker>/stats \
  -H "Authorization: Bearer $ASB_STATS_KEY"

# Read-only response for the private GitHub Actions workflow.
curl https://<your-worker>/review \
  -H "Authorization: Bearer $ASB_STATS_KEY"

# Legacy mode only: this prunes expired reports and commits a digest.
curl -X POST https://<your-worker>/digest \
  -H "Authorization: Bearer $ASB_STATS_KEY"
```

For a local `wrangler dev` submission, supply a test
`CF-Connecting-IP: 127.0.0.1` header because the Cloudflare edge is absent.
Never trust arbitrary client-IP headers when running this code outside
Cloudflare's public Worker ingress.

## Local regression tests

With Node 22.13 or later, run `node --test tests/backend.test.mjs` from the
repository root. Tests use mocked rate-limit/D1 bindings (with real in-memory
SQLite for the shipped SQL) and mocked GitHub fetches; they do not submit
reports or write to a live repository. Node 22 may print an experimental
SQLite warning. Deployment, real edge counters, and scheduled production
execution still require a separate smoke check.
