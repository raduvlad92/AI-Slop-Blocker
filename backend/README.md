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
- Rate limit: 50 submissions per installId per rolling 24h; over the cap it
  returns a polite `429` — the extension never surfaces this to the user.

### `GET /stats`

Returns the top 100 submitted videos and channels by submission count.
Optionally protected: set a secret with `wrangler secret put STATS_KEY`, then
call `/stats?key=<value>`.

### Daily review digest → private GitHub repo

A cron trigger (06:00 UTC, see `wrangler.toml`) builds a full ranked snapshot
of the review queue and commits two files to the **private** repo
`raduvlad92/AI-Slop-Review`:

- `REVIEW.md` — human-readable: one table per category (YouTube channels,
  YouTube videos; domain/page are placeholders for a future website-blocking
  feature), ranked by **distinct installs** that blocked each item, with
  clickable links, first/last seen dates, and flags: 🆕 activity in the last
  24h, ✅ already on the public blocklist.
- `review.json` — the same data, machine-readable.

`GET /digest?key=<STATS_KEY>` runs the same push on demand (for testing or an
impatient review). Review workflow: read REVIEW.md on GitHub → promote
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
npm install -g wrangler   # if you don't have it

# 1. Create the database and copy its id into wrangler.toml
wrangler d1 create aislopblocker

# 2. Apply the schema
wrangler d1 execute aislopblocker --remote --file=schema.sql

# 3. (Optional) protect /stats and /digest
wrangler secret put STATS_KEY

# 3b. For the daily review digest (see above)
wrangler secret put GITHUB_TOKEN

# 4. Deploy
wrangler deploy
```

After deploying, put the Worker URL into `extension/config.js`
(`BACKEND_URL`) and the matching entry in `extension/manifest.json`
`host_permissions`.

## Smoke test

```sh
curl -X POST https://<your-worker>/submit \
  -H 'content-type: application/json' \
  -d '{"videoId":"dQw4w9WgXcQ","channelId":"@example","channelName":"Example","scope":"video","installId":"123e4567-e89b-42d3-a456-426614174000"}'

curl https://<your-worker>/stats
```
