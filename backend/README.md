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

Returns the top 100 submitted videos and channels by submission count — this is
the manual-review feed used to decide what gets merged into `/blocklist`.
Optionally protected: set a secret with `wrangler secret put STATS_KEY`, then
call `/stats?key=<value>`.

## Deploy

```sh
cd backend
npm install -g wrangler   # if you don't have it

# 1. Create the database and copy its id into wrangler.toml
wrangler d1 create aislopblocker

# 2. Apply the schema
wrangler d1 execute aislopblocker --remote --file=schema.sql

# 3. (Optional) protect /stats
wrangler secret put STATS_KEY

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
