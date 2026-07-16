// AI Slop Blocker — submission collector.
// Cloudflare Worker + D1. No auth, no PII: installId is a random client-side
// UUID used only for rate limiting and dedupe.

const DAILY_LIMIT = 50; // submissions per installId per rolling 24h
const MAX_BODY_BYTES = 2048;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// UC… canonical channel id, or an @handle (the extension sends whichever the
// card exposed).
const CHANNEL_ID_RE = /^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{1,50})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // The extension's background worker fetches with host_permissions so
      // CORS isn't strictly needed, but being permissive here costs nothing
      // for a write-only, no-credentials endpoint.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json(null, 204);
    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(url, env);
    }
    return json({ error: "not found" }, 404);
  },
};

async function handleSubmit(request, env) {
  // --- Parse + validate (reject malformed payloads cheaply, before D1) ---
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const { videoId, channelId, channelName, scope, installId } = body ?? {};

  if (scope !== "video" && scope !== "channel") {
    return json({ ok: false, error: "invalid scope" }, 400);
  }
  if (typeof installId !== "string" || !UUID_RE.test(installId)) {
    return json({ ok: false, error: "invalid installId" }, 400);
  }
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) {
    return json({ ok: false, error: "invalid videoId" }, 400);
  }
  if (scope === "channel" && (typeof channelId !== "string" || !CHANNEL_ID_RE.test(channelId))) {
    return json({ ok: false, error: "invalid channelId" }, 400);
  }
  const cleanChannelId =
    typeof channelId === "string" && CHANNEL_ID_RE.test(channelId) ? channelId : null;
  const cleanChannelName =
    typeof channelName === "string"
      ? channelName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || null
      : null;

  // --- Rate limit: polite rejection over the daily cap ---
  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM submissions WHERE installId = ?1 AND createdAt > datetime('now', '-1 day')"
  )
    .bind(installId)
    .first();

  if (count >= DAILY_LIMIT) {
    return json(
      { ok: true, accepted: false, reason: "daily limit reached — your local blocks still work!" },
      429
    );
  }

  // --- Insert; partial unique indexes make repeats a no-op (dedupe) ---
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO submissions (videoId, channelId, channelName, scope, installId)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(videoId, cleanChannelId, cleanChannelName, scope, installId)
    .run();

  const accepted = result.meta.changes > 0;
  return json({ ok: true, accepted, ...(accepted ? {} : { reason: "duplicate" }) });
}

// Manual-review helper: top submitted videos/channels by distinct submitters.
// If a STATS_KEY secret is configured (wrangler secret put STATS_KEY), the
// endpoint requires ?key=<value>; otherwise it's open (fine for MVP — the
// data is anonymous aggregates).
async function handleStats(url, env) {
  if (env.STATS_KEY && url.searchParams.get("key") !== env.STATS_KEY) {
    return json({ error: "unauthorized" }, 401);
  }

  const [videos, channels] = await Promise.all([
    env.DB.prepare(
      `SELECT videoId, MAX(channelName) AS channelName, COUNT(*) AS submissions
       FROM submissions WHERE scope = 'video'
       GROUP BY videoId ORDER BY submissions DESC LIMIT 100`
    ).all(),
    env.DB.prepare(
      `SELECT channelId, MAX(channelName) AS channelName, COUNT(*) AS submissions
       FROM submissions WHERE scope = 'channel'
       GROUP BY channelId ORDER BY submissions DESC LIMIT 100`
    ).all(),
  ]);

  return json({ videos: videos.results, channels: channels.results });
}
