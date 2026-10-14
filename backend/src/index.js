// AI Slop Blocker — submission collector.
// Cloudflare Worker + D1. Public submissions, protected admin endpoints.
// installId is a client-side UUID used for rate limiting and dedupe.

import privacyPolicy from "../privacy.html";

const DAILY_LIMIT = 50; // submissions per installId per rolling 24h
const MAX_BODY_BYTES = 2048;
const REPORT_RETENTION_DAYS = 90;
const ACTIVE_REPORTS_SQL = `createdAt > datetime('now', '-${REPORT_RETENTION_DAYS} day')`;
// A NULL legacy contributorId is still eligible until the private backfill.
const NOT_IGNORED_SQL = `NOT EXISTS (SELECT 1 FROM ignored_contributors
  WHERE ignored_contributors.contributorId = submissions.contributorId)`;
const ELIGIBLE_REPORTS_SQL = `reviewStatus != 'false_positive' AND ${NOT_IGNORED_SQL}`;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// UC… canonical channel id, or an @handle (the extension sends whichever the
// card exposed).
const CHANNEL_ID_RE = /^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{1,50})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTRIBUTOR_ID_RE = /^[0-9a-f]{64}$/i;
const REVIEW_STATUSES = new Set(["pending", "useful", "false_positive"]);

function json(body, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      // Admin endpoints still require an explicit bearer credential.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      ...headers,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json(null, 204);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "ai-slop-blocker" });
    }
    if (request.method === "GET" && url.pathname === "/privacy") {
      return new Response(privacyPolicy, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/submit") {
      return handleSubmit(request, env);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(request, env);
    }
    if (url.pathname === "/contributors") {
      return runAdminRoute(request, env, "GET", () => listContributors(url, env));
    }
    const moderation = /^\/contributors\/([^/]+)\/moderation$/.exec(url.pathname);
    if (moderation) {
      return runAdminRoute(request, env, "PUT", () => moderateContributor(request, moderation[1], env));
    }
    const contributor = /^\/contributors\/([^/]+)$/.exec(url.pathname);
    if (contributor) {
      return runAdminRoute(request, env, "GET", () => contributorDetail(url, contributor[1], env));
    }
    const reportReview = /^\/reports\/([^/]+)\/review$/.exec(url.pathname);
    if (reportReview) {
      return runAdminRoute(request, env, "PUT", () => reviewReport(request, reportReview[1], env));
    }
    if (url.pathname === "/review") {
      if (request.method !== "GET") {
        return json({ error: "use GET /review" }, 405, { allow: "GET" });
      }
      return handleReview(request, env);
    }
    if (url.pathname === "/digest") {
      if (request.method !== "POST") {
        return json({ error: "use POST /digest" }, 405, { allow: "POST" });
      }
      return handleDigest(request, env);
    }
    return json({ error: "not found" }, 404);
  },

  // Daily cron always prunes raw reports. The recommended GitHub Actions mode
  // pulls GET /review and needs no repository token in the Worker. A configured
  // GITHUB_TOKEN enables the legacy server-side push after cleanup.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      pruneExpiredReports(env)
        .then(() => env.GITHUB_TOKEN ? buildAndPushDigest(env) : undefined)
        .catch((err) => console.error("daily review maintenance failed:", err.message))
    );
  },
};

async function requireAdmin(request, env) {
  if (typeof env.STATS_KEY !== "string" || !env.STATS_KEY.trim()) {
    return json({ error: "admin access is not configured" }, 503);
  }
  const credential = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") || "");
  if (credential) {
    // Compare fixed-length hashes without stopping at the first differing byte.
    const hashes = await Promise.all(
      [credential[1], env.STATS_KEY].map((s) =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
      )
    );
    const [actual, expected] = hashes.map((h) => new Uint8Array(h));
    let different = 0;
    for (let i = 0; i < actual.length; i++) different |= actual[i] ^ expected[i];
    if (!different) return null;
  }
  return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
}

class AdminProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function runAdminRoute(request, env, method, operation) {
  if (request.method !== method) {
    return json({ error: `use ${method} for this endpoint` }, 405, { allow: method });
  }
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  try {
    return await operation();
  } catch (err) {
    if (err instanceof AdminProblem) return json({ error: err.message }, err.status);
    // Database errors may contain private values; neither log nor return them.
    console.error("contributor administration temporarily unavailable");
    return json({ error: "operation temporarily unavailable" }, 500);
  }
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new AdminProblem(400, `invalid ${name}`);
  }
  return Number(value);
}

function pageLimit(url) {
  const value = url.searchParams.get("limit");
  return value === null ? 50 : Math.min(positiveInteger(value, "limit"), 100);
}

function contributorId(value) {
  if (!CONTRIBUTOR_ID_RE.test(value)) throw new AdminProblem(400, "invalid contributor id");
  return value.toLowerCase();
}

async function readAdminObject(request, keys) {
  let raw;
  try {
    raw = await readLimitedBody(request);
  } catch {
    throw new AdminProblem(400, "invalid request body");
  }
  if (raw === null) throw new AdminProblem(413, "payload too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AdminProblem(400, "invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !keys.includes(key))) {
    throw new AdminProblem(400, "invalid request fields");
  }
  return body;
}

async function requireContributorBackfill(env) {
  const legacy = await env.DB.prepare(
    `SELECT 1 AS pending FROM submissions
     WHERE contributorId IS NULL AND ${ACTIVE_REPORTS_SQL} LIMIT 1`
  ).first();
  if (legacy) throw new AdminProblem(503, "contributor data is initializing");
}

async function contributorSummary(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT installId) AS active,
            COUNT(DISTINCT CASE WHEN ${NOT_IGNORED_SQL} THEN installId END) AS eligible,
            (SELECT COUNT(*) FROM ignored_contributors) AS ignored
     FROM submissions WHERE ${ACTIVE_REPORTS_SQL}`
  ).first();
  return { active: row.active, eligible: row.eligible, ignored: row.ignored };
}

function contributorRowsSql(single = false) {
  const filter = single ? " AND contributorId = ?1" : "";
  return `WITH recent AS (
    SELECT contributorId AS id, COUNT(*) AS reports,
           SUM(reviewStatus = 'useful') AS useful,
           SUM(reviewStatus = 'false_positive') AS falsePositive,
           SUM(reviewStatus = 'pending') AS pending,
           MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
    FROM submissions WHERE ${ACTIVE_REPORTS_SQL} AND contributorId IS NOT NULL${filter}
    GROUP BY contributorId
  ), ids AS (
    SELECT id FROM recent UNION
    SELECT contributorId AS id FROM ignored_contributors${single ? " WHERE contributorId = ?1" : ""}
  )
  SELECT ids.id, COALESCE(recent.reports, 0) AS reports,
         COALESCE(recent.useful, 0) AS useful,
         COALESCE(recent.falsePositive, 0) AS falsePositive,
         COALESCE(recent.pending, 0) AS pending,
         recent.firstSeen, recent.lastSeen,
         (ignored_contributors.contributorId IS NOT NULL) AS ignored,
         COALESCE(ignored_contributors.reason, '') AS reason
  FROM ids LEFT JOIN recent ON recent.id = ids.id
  LEFT JOIN ignored_contributors ON ignored_contributors.contributorId = ids.id`;
}

function decorateContributor(row) {
  return {
    id: row.id, label: `Contributor ${row.id.slice(0, 12)}`,
    reports: row.reports, useful: row.useful, falsePositive: row.falsePositive,
    pending: row.pending, firstSeen: row.firstSeen ?? null, lastSeen: row.lastSeen ?? null,
    ignored: Boolean(row.ignored), reason: row.reason,
  };
}

async function listContributors(url, env) {
  const limit = pageLimit(url);
  const value = url.searchParams.get("offset") ?? "0";
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AdminProblem(400, "invalid offset");
  }
  const offset = Number(value);
  await requireContributorBackfill(env);
  const [summary, count, rows] = await Promise.all([
    contributorSummary(env),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM (
      SELECT DISTINCT contributorId FROM submissions
      WHERE ${ACTIVE_REPORTS_SQL} AND contributorId IS NOT NULL
      UNION SELECT contributorId FROM ignored_contributors
    )`).first(),
    env.DB.prepare(`${contributorRowsSql()} ORDER BY lastSeen DESC, ids.id ASC LIMIT ?1 OFFSET ?2`)
      .bind(limit, offset).all(),
  ]);
  return json({ summary, contributors: rows.results.map(decorateContributor), total: count.total, limit, offset });
}

async function contributorDetail(url, value, env) {
  const id = contributorId(value);
  const limit = pageLimit(url);
  const beforeValue = url.searchParams.get("before");
  const before = beforeValue === null ? null : positiveInteger(beforeValue, "before");
  await requireContributorBackfill(env);
  const row = await env.DB.prepare(`${contributorRowsSql(true)} WHERE ids.id = ?1`).bind(id).first();
  if (!row) throw new AdminProblem(404, "contributor not found");
  const result = await env.DB.prepare(
    `SELECT id, scope, videoId, channelId, channelName, createdAt, reviewStatus
     FROM submissions WHERE contributorId = ?1 AND ${ACTIVE_REPORTS_SQL}
       AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3`
  ).bind(id, before, limit + 1).all();
  const more = result.results.length > limit;
  const reports = result.results.slice(0, limit);
  return json({
    contributor: decorateContributor(row), reports,
    nextBefore: more ? reports[reports.length - 1].id : null,
  });
}

async function moderateContributor(request, value, env) {
  const id = contributorId(value);
  const body = await readAdminObject(request, ["ignored", "reason"]);
  if (typeof body.ignored !== "boolean" ||
      (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 300))) {
    throw new AdminProblem(400, "invalid moderation choice");
  }
  await requireContributorBackfill(env);
  if (!body.ignored) {
    // Resuming an expired contributor removes the only registry row. A retry
    // must still succeed without retaining a tombstone or raw report history.
    await env.DB.prepare("DELETE FROM ignored_contributors WHERE contributorId = ?1").bind(id).run();
    return json({ ok: true, ignored: false });
  }
  const reason = body.reason === undefined ? null : body.reason.trim();
  // The known-contributor check is part of the same write statement. Pruning
  // or another moderation request cannot create a new unknown registry entry.
  const result = await env.DB.prepare(
    `INSERT INTO ignored_contributors (contributorId, reason)
     SELECT ?1, COALESCE(?2, '')
     WHERE EXISTS (SELECT 1 FROM submissions WHERE contributorId = ?1 AND ${ACTIVE_REPORTS_SQL})
        OR EXISTS (SELECT 1 FROM ignored_contributors WHERE contributorId = ?1)
     ON CONFLICT(contributorId) DO UPDATE SET
       reason = CASE WHEN ?2 IS NULL THEN ignored_contributors.reason ELSE excluded.reason END,
       updatedAt = datetime('now')`
  ).bind(id, reason).run();
  if (!result.meta.changes) throw new AdminProblem(404, "contributor not found");
  return json({ ok: true, ignored: true });
}

async function reviewReport(request, value, env) {
  const id = positiveInteger(value, "report id");
  const body = await readAdminObject(request, ["status"]);
  if (!REVIEW_STATUSES.has(body.status)) throw new AdminProblem(400, "invalid review status");
  const result = await env.DB.prepare(
    `UPDATE submissions SET reviewStatus = ?2 WHERE id = ?1 AND ${ACTIVE_REPORTS_SQL}`
  ).bind(id, body.status).run();
  if (!result.meta.changes) throw new AdminProblem(404, "report not found");
  return json({ ok: true, status: body.status });
}

async function deriveContributorId(installId) {
  const hash = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`asb-contributor-v1:${installId.toLowerCase()}`)
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function limitSubmissions(request, env) {
  const network = request.headers.get("cf-connecting-ip");
  // This header is supplied by Cloudflare on public Worker requests. Never
  // substitute caller-controlled X-Forwarded-For or the client installId.
  if (
    !network ||
    typeof env.SUBMISSION_NETWORK_LIMITER?.limit !== "function" ||
    typeof env.SUBMISSION_BUDGET?.limit !== "function"
  ) {
    return json({ ok: false, error: "submissions temporarily unavailable" }, 503);
  }
  try {
    // Only a daily-changing hash reaches the short-lived edge counter. The
    // address and this counter key are never written to D1 or the review repo.
    const day = new Date().toISOString().slice(0, 10);
    const hash = await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`asb-submit:${day}:${network}`)
    );
    const key = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    const networkLimit = await env.SUBMISSION_NETWORK_LIMITER.limit({ key });
    // Reject a noisy source before it can consume the shared request budget.
    if (!networkLimit.success) return submissionThrottled();
    const budget = await env.SUBMISSION_BUDGET.limit({ key: "asb-submit" });
    if (!budget.success) return submissionThrottled();
    return null;
  } catch {
    console.error("submission rate limiter unavailable");
    return json({ ok: false, error: "submissions temporarily unavailable" }, 503);
  }
}

function submissionThrottled() {
  return json(
    { ok: true, accepted: false, reason: "too many reports — your local blocks still work!" },
    429,
    { "retry-after": "60" }
  );
}

async function readLimitedBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleSubmit(request, env) {
  const throttled = await limitSubmissions(request, env);
  if (throttled) return throttled;
  // --- Parse + validate (reject malformed payloads cheaply, before D1) ---
  let raw;
  try {
    raw = await readLimitedBody(request);
  } catch {
    return json({ ok: false, error: "invalid request body" }, 400);
  }
  if (raw === null) return json({ ok: false, error: "payload too large" }, 413);

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
  const contributor = await deriveContributorId(installId);

  // Count and conditional insert run as one SQLite statement, so concurrent
  // requests cannot both spend the last daily slot. Partial unique indexes
  // still make repeated video/channel reports a no-op.
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO submissions (videoId, channelId, channelName, scope, installId, contributorId)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE (SELECT COUNT(*) FROM submissions
            WHERE installId = ?5 AND createdAt > datetime('now', '-1 day')) < ?7
       AND NOT EXISTS (SELECT 1 FROM ignored_contributors WHERE contributorId = ?6)`
  )
    .bind(videoId, cleanChannelId, cleanChannelName, scope, installId.toLowerCase(), contributor, DAILY_LIMIT)
    .run();

  const accepted = result.meta.changes > 0;
  if (!accepted) {
    const ignored = await env.DB.prepare(
      "SELECT 1 AS ignored FROM ignored_contributors WHERE contributorId = ?1"
    ).bind(contributor).first();
    if (ignored) return json({ ok: true, accepted: false });
    // This follow-up only explains a rejected write; it does not enforce the
    // quota, which was checked atomically inside the INSERT above.
    const { count } = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions WHERE installId = ?1 AND createdAt > datetime('now', '-1 day')"
    ).bind(installId.toLowerCase()).first();
    if (count >= DAILY_LIMIT) {
      return json(
        { ok: true, accepted: false, reason: "daily limit reached — your local blocks still work!" },
        429
      );
    }
  }
  return json({ ok: true, accepted, ...(accepted ? {} : { reason: "duplicate" }) });
}

// Manual-review helper: top submitted videos/channels by distinct submitters.
async function handleStats(request, env) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const [videos, channels] = await Promise.all([
    env.DB.prepare(
      `SELECT videoId, MAX(channelName) AS channelName, COUNT(*) AS submissions
       FROM submissions WHERE scope = 'video' AND ${ACTIVE_REPORTS_SQL} AND ${ELIGIBLE_REPORTS_SQL}
       GROUP BY videoId ORDER BY submissions DESC LIMIT 100`
    ).all(),
    env.DB.prepare(
      `SELECT channelId, MAX(channelName) AS channelName, COUNT(*) AS submissions
       FROM submissions WHERE scope = 'channel' AND ${ACTIVE_REPORTS_SQL} AND ${ELIGIBLE_REPORTS_SQL}
       GROUP BY channelId ORDER BY submissions DESC LIMIT 100`
    ).all(),
  ]);

  return json({ videos: videos.results, channels: channels.results });
}

// ---------------------------------------------------------------------------
// Review digest — ranked aggregates read by GitHub Actions or pushed by the
// optional legacy Worker mode. Read-only generation never prunes reports.
// Categories are future-proofed: domain/page stay empty until the extension
// grows website blocking.
// ---------------------------------------------------------------------------

async function handleDigest(request, env) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  try {
    await pruneExpiredReports(env);
    return json({ ok: true, ...(await buildAndPushDigest(env)) });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

async function handleReview(request, env) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  try {
    const digest = await buildReviewDigest(env);
    return json({ digest, markdown: buildMarkdown(digest) });
  } catch (err) {
    console.error("review generation failed:", err.message);
    return json({ error: "review temporarily unavailable" }, 500);
  }
}

async function pruneExpiredReports(env) {
  await env.DB.prepare(
    `DELETE FROM submissions WHERE createdAt <= datetime('now', '-${REPORT_RETENTION_DAYS} day')`
  ).run();
}

async function buildReviewDigest(env) {
  const [videos, channels, summary] = await Promise.all([
    env.DB.prepare(
      `SELECT videoId AS id, MAX(channelName) AS name,
              COUNT(DISTINCT installId) AS blocks,
              MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM submissions WHERE scope = 'video' AND ${ACTIVE_REPORTS_SQL} AND ${ELIGIBLE_REPORTS_SQL}
       GROUP BY videoId ORDER BY blocks DESC, lastSeen DESC LIMIT 500`
    ).all(),
    env.DB.prepare(
      `SELECT channelId AS id, MAX(channelName) AS name,
              COUNT(DISTINCT installId) AS blocks,
              MIN(createdAt) AS firstSeen, MAX(createdAt) AS lastSeen
       FROM submissions WHERE scope = 'channel' AND ${ACTIVE_REPORTS_SQL} AND ${ELIGIBLE_REPORTS_SQL}
       GROUP BY channelId ORDER BY blocks DESC, lastSeen DESC LIMIT 500`
    ).all(),
    contributorSummary(env),
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

  return {
    generatedAt: new Date().toISOString(),
    contributorSummary: summary,
    totals: { video: videos.results.length, channel: channels.results.length, domain: 0, page: 0 },
    categories: {
      video: decorate(videos.results, "video"),
      channel: decorate(channels.results, "channel"),
      domain: [], // future: website domains
      page: [], // future: specific website pages
    },
  };

}

async function buildAndPushDigest(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");
  const digest = await buildReviewDigest(env);
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
  const contributors = digest.contributorSummary;

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
    `Generated ${digest.generatedAt} — full snapshot, ranked by distinct submitted install identifiers for each item.`,
    "",
    `Contributor counts: ${contributors.active} with retained reports · ${contributors.eligible} eligible (not ignored) · ${contributors.ignored} in the ignored registry.`,
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
