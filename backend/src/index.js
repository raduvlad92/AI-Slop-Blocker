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
    if (request.method === "GET" && url.pathname === "/digest") {
      return handleDigest(url, env);
    }
    return json({ error: "not found" }, 404);
  },

  // Daily cron (see wrangler.toml [triggers]): push the review digest to the
  // private GitHub repo. A failed run just waits for tomorrow (or a manual
  // GET /digest) — never throws.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      buildAndPushDigest(env).catch((err) => console.error("digest failed:", err.message))
    );
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

// ---------------------------------------------------------------------------
// Daily review digest — full ranked snapshot committed to a private repo.
// Categories are future-proofed: domain/page stay empty until the extension
// grows website blocking.
// ---------------------------------------------------------------------------

async function handleDigest(url, env) {
  if (env.STATS_KEY && url.searchParams.get("key") !== env.STATS_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    return json({ ok: true, ...(await buildAndPushDigest(env)) });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

async function buildAndPushDigest(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");

  const [videos, channels] = await Promise.all([
    env.DB.prepare(
      `SELECT videoId AS id, MAX(channelName) AS name,
              COUNT(DISTINCT installId) AS blocks,
              MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM submissions WHERE scope = 'video'
       GROUP BY videoId ORDER BY blocks DESC, lastSeen DESC LIMIT 500`
    ).all(),
    env.DB.prepare(
      `SELECT channelId AS id, MAX(channelName) AS name,
              COUNT(DISTINCT installId) AS blocks,
              MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM submissions WHERE scope = 'channel'
       GROUP BY channelId ORDER BY blocks DESC, lastSeen DESC LIMIT 500`
    ).all(),
  ]);

  const listed = await fetchListedIds(env);
  const dayAgo = Date.now() - 864e5;
  // D1's datetime('now') is UTC "YYYY-MM-DD HH:MM:SS".
  const toEpoch = (s) => Date.parse(String(s).replace(" ", "T") + "Z") || 0;

  const decorate = (rows, kind) =>
    rows.map((r) => ({
      ...r,
      url:
        kind === "video"
          ? `https://www.youtube.com/watch?v=${r.id}`
          : r.id.startsWith("@")
            ? `https://www.youtube.com/${r.id}`
            : `https://www.youtube.com/channel/${r.id}`,
      listed: (kind === "video" ? listed.videos : listed.channels).has(r.id),
      isNew: toEpoch(r.lastSeen) >= dayAgo,
    }));

  const digest = {
    generatedAt: new Date().toISOString(),
    totals: { video: videos.results.length, channel: channels.results.length, domain: 0, page: 0 },
    categories: {
      video: decorate(videos.results, "video"),
      channel: decorate(channels.results, "channel"),
      domain: [], // future: website domains
      page: [], // future: specific website pages
    },
  };

  const date = digest.generatedAt.slice(0, 10);
  // Sequential PUTs — concurrent contents-API commits race on the branch head.
  await putGithubFile(env, "REVIEW.md", buildMarkdown(digest), `Review digest ${date}`);
  await putGithubFile(
    env,
    "review.json",
    JSON.stringify(digest, null, 2),
    `Review digest ${date} (data)`
  );

  return { pushed: `github.com/${env.REVIEW_REPO}`, totals: digest.totals };
}

// Which ids are already promoted to the public blocklist (entries there are
// {id, ...} objects; bare strings tolerated). Failure -> empty sets, the
// digest still ships without ✅ flags.
async function fetchListedIds(env) {
  const load = async (file) => {
    try {
      const res = await fetch(`${env.PUBLIC_RAW_BASE}/${file}`);
      const data = await res.json();
      return new Set(
        (Array.isArray(data) ? data : []).map((x) => (typeof x === "string" ? x : x?.id))
      );
    } catch {
      return new Set();
    }
  };
  return { videos: await load("videos.json"), channels: await load("channels.json") };
}

function buildMarkdown(digest) {
  const esc = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const day = (s) => String(s ?? "").slice(0, 10);

  const section = (title, rows) => {
    if (!rows.length) return `## ${title}\n\n_None yet._\n`;
    const lines = [
      `## ${title} (${rows.length})`,
      "",
      "| # | Blocks | Item | Name | First seen | Last seen | Flags |",
      "|---|---|---|---|---|---|---|",
    ];
    rows.forEach((r, i) => {
      const flags = [r.isNew ? "🆕" : "", r.listed ? "✅" : ""].filter(Boolean).join(" ");
      lines.push(
        `| ${i + 1} | **${r.blocks}** | [\`${r.id}\`](${r.url}) | ${esc(r.name)} ` +
          `| ${day(r.firstSeen)} | ${day(r.lastSeen)} | ${flags} |`
      );
    });
    return lines.join("\n") + "\n";
  };

  return [
    "# AI Slop review queue",
    "",
    `Generated ${digest.generatedAt} — full snapshot, ranked by distinct installs that blocked each item.`,
    "",
    "Legend: 🆕 activity in the last 24h · ✅ already on the public blocklist.",
    "",
    "To promote an entry: add it to `blocklist/videos.json` / `channels.json` in",
    "[AI-Slop-Blocker](https://github.com/raduvlad92/AI-Slop-Blocker) via PR",
    '(`{id, name, added: "YYYY-MM-DD", reason}` — see CONTRIBUTING.md there).',
    "",
    section("YouTube channels", digest.categories.channel),
    section("YouTube videos", digest.categories.video),
    section("Website domains", digest.categories.domain),
    section("Website pages", digest.categories.page),
  ].join("\n");
}

// Create-or-update a file via the GitHub contents API.
async function putGithubFile(env, path, content, message) {
  const api = `https://api.github.com/repos/${env.REVIEW_REPO}/contents/${path}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "aislopblocker-digest",
    "x-github-api-version": "2022-11-28",
  };

  let sha;
  const current = await fetch(api, { headers });
  if (current.ok) sha = (await current.json()).sha;
  else if (current.status !== 404) {
    throw new Error(`GitHub GET ${path}: HTTP ${current.status}`);
  }

  const res = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({ message, content: base64Utf8(content), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path}: HTTP ${res.status} ${await res.text()}`);
}

// btoa can't take raw UTF-8; encode bytes chunk-wise (names can be non-ASCII).
function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
