# AI Slop Blocker — Backend

A single Cloudflare Worker + D1 database that receives optional, pseudonymous
block reports from the extension. Reporting is off by default and requires
explicit opt-in. Reports contain a random installation UUID (`installId`),
video/channel identifiers, an optional channel name, scope, and receipt time.
The UUID links reports from one installation; it is not a verified person or
an account. Full browsing/search/watch histories and local statistics are not
uploaded. Public policy: `GET /privacy`.

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

This is a read-only endpoint. It queries active report aggregates and fetches
the public blocklists to flag already-listed items. It never deletes reports,
writes to D1, writes to GitHub, or returns raw installation UUIDs. A Worker
`GITHUB_TOKEN` is not required, and any configured token is not used by this
endpoint. Responses are not cached.

### Daily review digest → private GitHub repo (recommended)

Use a scheduled GitHub Actions workflow **inside the private**
`raduvlad92/AI-Slop-Review` repository to pull `/review` and commit two files:

- `REVIEW.md` — human-readable: one table per category (YouTube channels,
  YouTube videos; domain/page are placeholders for a future website-blocking
  feature), ranked by **distinct reported install identifiers**, with
  clickable links, first/last seen dates, and flags: 🆕 activity in the last
  24h, ✅ already on the public blocklist.
- `review.json` — the same data, machine-readable.

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

Raw UUID-linked reports expire after **90 days**. `/stats`, `/review`, and new
digests exclude expired rows even if cleanup has been delayed. The daily cron
deletes expired rows and optionally pushes a digest in legacy mode. A manual
`POST /digest` also prunes before generating its snapshot. A digest failure
does not undo a completed cleanup; a cleanup failure stops that digest run.

Daily cleanup normally removes expired rows on its next run, so service
interruptions can delay physical deletion. Cloudflare's recovery backups may
retain deleted records for up to 30 additional days, depending on the plan.
Historical private GitHub aggregate snapshots and public curated lists/Git
history can remain indefinitely. Review files contain no raw install UUIDs.

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

The 0.1.1 release is deployed at
`https://aislopblocker-api.radu-vlad-92.workers.dev`. This checkout's Wrangler
configuration already identifies the production account/database and rate-limit
namespaces. For an update to this deployment, keep those bindings and run
`wrangler deploy`; do not create another database. Live checks and the verified
private review run are recorded in [store/RELEASE-CHECKS.md](../store/RELEASE-CHECKS.md).

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
