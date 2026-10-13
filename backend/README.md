# AI Slop Blocker — Backend

A single Cloudflare Worker + D1 database that collects anonymous block
submissions from the extension. No accounts, no PII — the only identifier is a
random client-side UUID (`installId`) used for rate limiting and dedupe.

## Endpoints

### `POST /submit`

Body: `{ videoId, channelId, channelName, scope: "video" | "channel", installId }`

- Validates shape strictly (11-char video IDs, `UC…` IDs or `@handles`, UUID installId).
- Dedupes: the same install can't submit the same video/channel twice (unique
  indexes + `INSERT OR IGNORE`).
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

### Daily review digest → private GitHub repo

A cron trigger (06:00 UTC, see `wrangler.toml`) builds a full ranked snapshot
of the review queue and commits two files to the **private** repo
`raduvlad92/AI-Slop-Review`:

- `REVIEW.md` — human-readable: one table per category (YouTube channels,
  YouTube videos; domain/page are placeholders for a future website-blocking
  feature), ranked by **distinct reported install identifiers**, with
  clickable links, first/last seen dates, and flags: 🆕 activity in the last
  24h, ✅ already on the public blocklist.
- `review.json` — the same data, machine-readable.

`POST /digest` with `Authorization: Bearer <STATS_KEY>` runs the same push on
demand. It has the same fail-closed authentication as `/stats`.
`GET /digest` returns `405` and never writes to GitHub. The daily cron uses its
server-side configuration directly and does not need a caller credential.
Review workflow: read REVIEW.md on GitHub → promote
entries by PR into `blocklist/*.json` in the public repo (they'll show ✅ in
the next digest).

**Setup (one-time):**

1. Create a **fine-grained PAT** at github.com → Settings → Developer settings
   → Fine-grained tokens: repository access = *only* `AI-Slop-Review`,
   permissions = Contents: Read and write. Nothing else.
2. `wrangler secret put GITHUB_TOKEN` and paste it.

## Deploy

```sh
cd backend
npm install -g wrangler   # version 4.36.0 or later for rate-limit bindings

# 1. Create the database and copy its id into wrangler.toml
wrangler d1 create aislopblocker

# 2. Apply the schema
wrangler d1 execute aislopblocker --remote --file=schema.sql

# 3. Required for manual /stats and /digest access
wrangler secret put STATS_KEY

# 3b. For the daily review digest (see above)
wrangler secret put GITHUB_TOKEN

# 4. Deploy
wrangler deploy
```

After deploying, put the Worker URL into `extension/config.js`
(`BACKEND_URL`) and the matching entry in `extension/manifest.json`
`host_permissions`.

Keep both `ratelimits` bindings in every deployed Wrangler environment;
bindings are not inherited by named environments. No schema migration is
needed for the conditional insert. Before deploying, confirm the namespace IDs
are not used by another rate limiter on your Cloudflare account.

## Smoke test

```sh
curl -X POST https://<your-worker>/submit \
  -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","channelId":"@example","channelName":"Example","scope":"video","installId":"123e4567-e89b-42d3-a456-426614174000"}'

curl https://<your-worker>/stats \
  -H "Authorization: Bearer $ASB_STATS_KEY"

# This intentionally commits a digest to the configured review repo.
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
