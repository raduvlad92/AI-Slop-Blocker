import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, mock } from "node:test";

const sourceURL = new URL("../backend/src/index.js", import.meta.url);
const workerSource = readFileSync(sourceURL, "utf8");
const policyImport = /^import privacyPolicy from "([^"]+)";$/m.exec(workerSource);
assert.ok(policyImport, "the Worker must import its canonical policy");
const privacyPolicy = readFileSync(new URL(policyImport[1], sourceURL), "utf8");
// Wrangler imports HTML as a string. Inject the identical file for Node's
// data-URL module loader, which does not support Worker text imports.
const source = workerSource.replace(policyImport[0], `const privacyPolicy = ${JSON.stringify(privacyPolicy)};`);
const schema = readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const ADMIN_KEY = "test-only-long-admin-credential";
const installId = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contributorHash = (id) => createHash("sha256").update(`asb-contributor-v1:${id.toLowerCase()}`).digest("hex");
const payload = (overrides = {}) => ({
  videoId: "dQw4w9WgXcQ", scope: "video", installId: installId(), ...overrides,
});

function d1(t, schemaSql = schema) {
  // D1's API is mocked, but the shipped SQL runs against real in-memory SQLite.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schemaSql);
  t.after(() => sqlite.close());
  const DB = {
    prepare: mock.fn((sql) => ({
      async first() { return sqlite.prepare(sql).get(); },
      async run() {
        const result = sqlite.prepare(sql).run();
        return { meta: { changes: result.changes } };
      },
      bind(...args) {
        return {
          async run() {
            const result = sqlite.prepare(sql).run(...args);
            return { meta: { changes: result.changes } };
          },
          async first() { return sqlite.prepare(sql).get(...args); },
          async all() {
            return { results: sqlite.prepare(sql).all(...args).map((row) => ({ ...row })) };
          },
        };
      },
      async all() {
        return { results: sqlite.prepare(sql).all().map((row) => ({ ...row })) };
      },
    })),
  };
  return { DB, sqlite };
}

function limiter(limit = Infinity) {
  const counts = new Map();
  return {
    limit: mock.fn(async ({ key }) => {
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    }),
  };
}

function environment(t, overrides = {}) {
  const { DB, sqlite } = d1(t);
  return {
    sqlite,
    env: {
      DB,
      SUBMISSION_NETWORK_LIMITER: limiter(),
      SUBMISSION_BUDGET: limiter(),
      ...overrides,
    },
  };
}

function submission(body = payload(), headers = {}) {
  return new Request("https://worker.test/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function noNetwork(t) {
  return t.mock.method(globalThis, "fetch", async () => {
    assert.fail("this request must not make an outbound network call");
  });
}

function github(t) {
  return t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).startsWith("https://raw.test/")) return new Response("[]");
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/test\/review\/contents\//);
    assert.equal(options.headers.authorization, "Bearer fake-github-token");
    if (options.method === "PUT") return new Response("{}");
    return new Response("{}", { status: 404 });
  });
}

const adminEndpoints = [
  { path: "/stats", method: "GET" },
  { path: "/digest", method: "POST" },
  { path: "/review", method: "GET" },
  { path: "/contributors", method: "GET" },
  { path: `/contributors/${contributorHash(installId())}`, method: "GET" },
  { path: `/contributors/${contributorHash(installId())}/moderation`, method: "PUT" },
  { path: "/reports/1/review", method: "PUT" },
];
for (const { path, method } of adminEndpoints) {
  test(`${method} ${path} fails closed with an unset or empty admin key`, async (t) => {
    const outbound = noNetwork(t);
    for (const STATS_KEY of [undefined, "", "   "]) {
      const { env } = environment(t, { STATS_KEY, GITHUB_TOKEN: "fake-github-token" });
      const response = await worker.fetch(new Request(`https://worker.test${path}`, { method }), env);
      assert.equal(response.status, 503);
      assert.equal(env.DB.prepare.mock.callCount(), 0);
    }
    assert.equal(outbound.mock.callCount(), 0);
  });

  test(`${method} ${path} rejects missing, wrong, and URL-only credentials before side effects`, async (t) => {
    const outbound = noNetwork(t);
    for (const authorization of [undefined, "Bearer incorrect", `Basic ${ADMIN_KEY}`]) {
      const { env } = environment(t, { STATS_KEY: ADMIN_KEY, GITHUB_TOKEN: "fake-github-token" });
      const response = await worker.fetch(new Request(`https://worker.test${path}?key=${ADMIN_KEY}`, {
        method, headers: authorization ? { authorization } : {},
      }), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal(env.DB.prepare.mock.callCount(), 0);
    }
    assert.equal(outbound.mock.callCount(), 0);
  });
}

test("GET /digest never writes, including with a valid credential", async (t) => {
  const outbound = noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY, GITHUB_TOKEN: "fake-github-token" });
  const response = await worker.fetch(new Request("https://worker.test/digest", {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(env.DB.prepare.mock.callCount(), 0);
  assert.equal(outbound.mock.callCount(), 0);
});

test("a valid bearer credential permits stats and disables response caching", async (t) => {
  const outbound = noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const response = await worker.fetch(new Request("https://worker.test/stats", {
    headers: { authorization: `bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { videos: [], channels: [] });
  assert.equal(env.DB.prepare.mock.callCount(), 2);
  assert.equal(outbound.mock.callCount(), 0);
});

test("authenticated POST /digest pushes both review files and preserves manual promotion", async (t) => {
  const outbound = github(t);
  const { env } = environment(t, {
    STATS_KEY: ADMIN_KEY, GITHUB_TOKEN: "fake-github-token", REVIEW_REPO: "test/review", PUBLIC_RAW_BASE: "https://raw.test",
  });
  const response = await worker.fetch(new Request("https://worker.test/digest", {
    method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 200);
  const writes = outbound.mock.calls.filter(({ arguments: [, options] }) => options?.method === "PUT");
  assert.equal(writes.length, 2);
  assert.match(writes[0].arguments[0], /\/REVIEW\.md$/);
  assert.match(writes[1].arguments[0], /\/review\.json$/);
  const markdown = Buffer.from(JSON.parse(writes[0].arguments[1].body).content, "base64").toString("utf8");
  assert.match(markdown, /via PR/);
});

test("the scheduled digest still runs without a caller admin credential", async (t) => {
  const outbound = github(t);
  const { env } = environment(t, {
    GITHUB_TOKEN: "fake-github-token", REVIEW_REPO: "test/review", PUBLIC_RAW_BASE: "https://raw.test",
  });
  const pending = [];
  await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(outbound.mock.calls.filter(({ arguments: [, options] }) => options?.method === "PUT").length, 2);
});

test("OPTIONS returns an empty 204 with bearer-header support and no side effects", async (t) => {
  const outbound = noNetwork(t);
  const { env } = environment(t);
  const response = await worker.fetch(new Request("https://worker.test/digest", { method: "OPTIONS" }), env);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);
  assert.match(response.headers.get("access-control-allow-methods"), /\bPUT\b/);
  assert.equal(env.DB.prepare.mock.callCount(), 0);
  assert.equal(outbound.mock.callCount(), 0);
});

test("missing edge bindings or a missing trusted IP header disable submissions before D1", async (t) => {
  noNetwork(t);
  for (const missing of ["SUBMISSION_NETWORK_LIMITER", "SUBMISSION_BUDGET", "ip"]) {
    const { env } = environment(t);
    const request = submission();
    if (missing === "ip") {
      request.headers.delete("cf-connecting-ip");
      request.headers.set("x-forwarded-for", "203.0.113.10");
    } else delete env[missing];
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 503);
    assert.equal(env.DB.prepare.mock.callCount(), 0);
  }
});

test("an unavailable limiter fails closed without reading the body or touching D1", async (t) => {
  noNetwork(t);
  t.mock.method(console, "error", () => {});
  const { env } = environment(t, { SUBMISSION_NETWORK_LIMITER: { limit: async () => { throw new Error("unavailable"); } } });
  const request = submission();
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 503);
  assert.equal(request.bodyUsed, false);
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("rotating install IDs and forwarded headers does not reset the per-network budget", async (t) => {
  noNetwork(t);
  const network = limiter(3);
  const { env, sqlite } = environment(t, { SUBMISSION_NETWORK_LIMITER: network });
  for (let n = 1; n <= 4; n++) {
    const response = await worker.fetch(submission(payload({ installId: installId(n) }), {
      "x-forwarded-for": `198.51.100.${n}`,
    }), env);
    assert.equal(response.status, n <= 3 ? 200 : 429);
    if (n === 4) assert.equal(response.headers.get("retry-after"), "60");
  }
  const keys = network.limit.mock.calls.map(({ arguments: [arg] }) => arg.key);
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.equal(env.SUBMISSION_BUDGET.limit.mock.callCount(), 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 3);
  const bound = env.DB.prepare.mock.calls.map(({ arguments: [sql] }) => sql).join(" ");
  assert.doesNotMatch(bound, /203\.0\.113\.10/);
});

test("the endpoint budget also applies across different connecting IPs and install IDs", async (t) => {
  noNetwork(t);
  const budget = limiter(2);
  const { env, sqlite } = environment(t, { SUBMISSION_BUDGET: budget });
  for (let n = 1; n <= 3; n++) {
    const response = await worker.fetch(submission(payload({ installId: installId(n) }), {
      "cf-connecting-ip": `203.0.113.${n}`,
    }), env);
    assert.equal(response.status, n <= 2 ? 200 : 429);
  }
  assert.deepEqual(budget.limit.mock.calls.map(({ arguments: [arg] }) => arg.key), ["asb-submit", "asb-submit", "asb-submit"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 2);
});

test("invalid JSON and IDs are rejected without querying D1", async (t) => {
  noNetwork(t);
  const { env } = environment(t);
  for (const body of ["{", payload({ videoId: "invalid" }), payload({ installId: "invalid" }), payload({ scope: "channel", channelId: "invalid" })]) {
    const response = await worker.fetch(submission(body), env);
    assert.equal(response.status, 400);
  }
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("the request limit counts UTF-8 bytes rather than string characters", async (t) => {
  noNetwork(t);
  const { env } = environment(t);
  const body = JSON.stringify(payload({ extra: "€".repeat(1000) }));
  assert.ok(body.length < 2048);
  assert.ok(Buffer.byteLength(body) > 2048);
  const response = await worker.fetch(submission(body, { "content-length": "1" }), env);
  assert.equal(response.status, 413);
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("an oversized stream is cancelled without draining later chunks", async (t) => {
  noNetwork(t);
  const { env } = environment(t);
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1025)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("https://worker.test/submit", {
    method: "POST", headers: { "cf-connecting-ip": "203.0.113.10" }, body: stream, duplex: "half",
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(reads, 2);
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("video and channel duplicates remain no-ops", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  for (const scope of ["video", "channel"]) {
    const first = await worker.fetch(submission(payload({ scope, channelId: "@example" })), env);
    const repeat = await worker.fetch(submission(payload({
      scope, channelId: "@example", ...(scope === "channel" ? { videoId: "abcdefghijk" } : {}),
    })), env);
    assert.equal((await first.json()).accepted, true);
    assert.deepEqual(await repeat.json(), { ok: true, accepted: false, reason: "duplicate" });
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 2);
});

test("only one concurrent request can consume the fiftieth daily submission", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  const seed = sqlite.prepare("INSERT INTO submissions (videoId, scope, installId) VALUES (?, 'video', ?)");
  for (let n = 0; n < 49; n++) seed.run(String(n).padStart(11, "0"), installId());
  const responses = await Promise.all([
    worker.fetch(submission(payload({ videoId: "AAAAAAAAAAA" })), env),
    worker.fetch(submission(payload({ videoId: "BBBBBBBBBBB" })), env),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 50);
});

test("expired reports do not consume the rolling daily quota", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  const seed = sqlite.prepare("INSERT INTO submissions (videoId, scope, installId, createdAt) VALUES (?, 'video', ?, datetime('now', '-2 day'))");
  for (let n = 0; n < 50; n++) seed.run(String(n).padStart(11, "0"), installId());
  const response = await worker.fetch(submission(), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
});

test("changing UUID letter casing does not create a second installation identity", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  const id = "123e4567-e89b-42d3-a456-426614174000";
  await worker.fetch(submission(payload({ installId: id })), env);
  const response = await worker.fetch(submission(payload({ installId: id.toUpperCase() })), env);
  assert.equal((await response.json()).reason, "duplicate");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 1);
});

function seedRetentionRows(sqlite) {
  const insert = sqlite.prepare(`INSERT INTO submissions
    (videoId, channelId, channelName, scope, installId, createdAt)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?))`);
  insert.run("aaaaaaaaaaa", "@expired", "Expired", "video", installId(91), "-91 day");
  insert.run("aaaaaaaaaaa", "@expired", "Expired", "channel", installId(91), "-91 day");
  insert.run("bbbbbbbbbbb", "@current", "Current", "video", installId(1), "-1 day");
  insert.run("bbbbbbbbbbb", "@current", "Current", "channel", installId(1), "-1 day");
}

test("public health exposes no data and works without database or secret configuration", async (t) => {
  const outbound = noNetwork(t);
  const response = await worker.fetch(new Request("https://worker.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "ai-slop-blocker" });
  assert.equal(outbound.mock.callCount(), 0);
});

test("public privacy serves the complete standalone policy without database or network access", async (t) => {
  const outbound = noNetwork(t);
  const response = await worker.fetch(new Request("https://worker.test/privacy"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await response.text();
  assert.equal(html, privacyPolicy);
  assert.match(html, /mailto:contact@deletecookies\.dev/);
  assert.match(html, /disabled by default/);
  assert.match(html, /pseudonymous reports/);
  assert.match(html, /90 days/);
  assert.match(html, /may be kept indefinitely/);
  assert.doesNotMatch(html, /<script|<iframe|<img|<link\b/i);
  assert.equal(outbound.mock.callCount(), 0);
});

test("stats excludes expired reports even before physical cleanup runs", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  seedRetentionRows(sqlite);
  const response = await worker.fetch(new Request("https://worker.test/stats", {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.videos.map((row) => row.videoId), ["bbbbbbbbbbb"]);
  assert.deepEqual(body.channels.map((row) => row.channelId), ["@current"]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 4);
});

test("authenticated manual digest deletes expired raw reports and exports only aggregates", async (t) => {
  const outbound = github(t);
  const { env, sqlite } = environment(t, {
    STATS_KEY: ADMIN_KEY, GITHUB_TOKEN: "fake-github-token", REVIEW_REPO: "test/review", PUBLIC_RAW_BASE: "https://raw.test",
  });
  seedRetentionRows(sqlite);
  const response = await worker.fetch(new Request("https://worker.test/digest", {
    method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 2);
  const write = outbound.mock.calls.find(({ arguments: [url, options] }) => /review\.json$/.test(url) && options?.method === "PUT");
  const text = Buffer.from(JSON.parse(write.arguments[1].body).content, "base64").toString("utf8");
  const digest = JSON.parse(text);
  assert.deepEqual(digest.categories.video.map((row) => row.id), ["bbbbbbbbbbb"]);
  assert.deepEqual(digest.categories.channel.map((row) => row.id), ["@current"]);
  assert.doesNotMatch(text, /installId/);
  assert.equal(text.includes(installId(1)), false);
  assert.equal(text.includes(installId(91)), false);
});

test("daily cleanup expires reports at the ninety-day boundary even when GitHub is unconfigured", async (t) => {
  const outbound = noNetwork(t);
  const errors = t.mock.method(console, "error", () => {});
  const { env, sqlite } = environment(t);
  sqlite.prepare(`INSERT INTO submissions (videoId, scope, installId, createdAt)
    VALUES ('aaaaaaaaaaa', 'video', ?, datetime('now', '-90 day'))`).run(installId());
  const pending = [];
  await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 0);
  assert.equal(env.DB.prepare.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 0);
  assert.equal(outbound.mock.callCount(), 0);
});

test("cleanup failure prevents an authenticated digest from writing to GitHub", async (t) => {
  const outbound = noNetwork(t);
  const env = {
    STATS_KEY: ADMIN_KEY, GITHUB_TOKEN: "fake-github-token",
    DB: { prepare: () => ({ run: async () => { throw new Error("cleanup unavailable"); } }) },
  };
  const response = await worker.fetch(new Request("https://worker.test/digest", {
    method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 500);
  assert.equal(outbound.mock.callCount(), 0);
});

test("the additive retention migration can be applied repeatedly without removing reports", (t) => {
  const { sqlite } = d1(t);
  seedRetentionRows(sqlite);
  sqlite.exec("DROP INDEX idx_submission_created");
  const migration = readFileSync(new URL("../backend/migrations/0001_report_retention.sql", import.meta.url), "utf8");
  sqlite.exec(migration);
  sqlite.exec(migration);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 4);
  assert.deepEqual(sqlite.prepare("PRAGMA index_info('idx_submission_created')").all().map((row) => row.name), ["createdAt"]);
});

test("authenticated review returns the existing aggregate digest and markdown without writes or raw UUIDs", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async (url) => new Response(
    JSON.stringify([{ id: String(url).endsWith("videos.json") ? "bbbbbbbbbbb" : "@current" }])
  ));
  for (const GITHUB_TOKEN of [undefined, "legacy-token-that-must-not-be-used"]) {
    const { env, sqlite } = environment(t, {
      STATS_KEY: ADMIN_KEY, GITHUB_TOKEN, PUBLIC_RAW_BASE: "https://raw.test",
    });
    seedRetentionRows(sqlite);
    const response = await worker.fetch(new Request("https://worker.test/review", {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["digest", "markdown"]);
    assert.deepEqual(body.digest.totals, { video: 1, channel: 1, domain: 0, page: 0 });
    assert.deepEqual(body.digest.contributorSummary, { active: 1, eligible: 1, ignored: 0 });
    assert.deepEqual(body.digest.categories.video.map((row) => row.id), ["bbbbbbbbbbb"]);
    assert.deepEqual(body.digest.categories.channel.map((row) => row.id), ["@current"]);
    assert.equal(body.digest.categories.video[0].listed, true);
    assert.equal(body.digest.categories.channel[0].listed, true);
    assert.equal(body.digest.categories.video[0].blocks, 1);
    assert.ok(Number.isFinite(Date.parse(body.digest.generatedAt)));
    assert.match(body.markdown, /# AI Slop review queue/);
    assert.match(body.markdown, /bbbbbbbbbbb/);
    assert.match(body.markdown, /via PR/);
    const text = JSON.stringify(body);
    assert.equal(text.includes(installId(1)), false);
    assert.equal(text.includes(installId(91)), false);
    assert.doesNotMatch(text, /installId/);
    // Expired rows remain stored, proving the GET does not run retention deletion.
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 4);
    assert.equal(env.DB.prepare.mock.callCount(), 3);
    for (const { arguments: [sql] } of env.DB.prepare.mock.calls) assert.match(sql, /^SELECT\b/);
  }
  assert.equal(outbound.mock.callCount(), 4);
  for (const { arguments: [url, options] } of outbound.mock.calls) {
    assert.match(url, /^https:\/\/raw\.test\/(videos|channels)\.json$/);
    assert.equal(options?.method || "GET", "GET");
    assert.equal(options?.headers, undefined);
  }
});

test("POST /review is rejected without database or outbound operations", async (t) => {
  const outbound = noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const response = await worker.fetch(new Request("https://worker.test/review", {
    method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(env.DB.prepare.mock.callCount(), 0);
  assert.equal(outbound.mock.callCount(), 0);
});

test("review generation failures return a generic error without leaking database details", async (t) => {
  const outbound = noNetwork(t);
  t.mock.method(console, "error", () => {});
  const response = await worker.fetch(new Request("https://worker.test/review", {
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), {
    STATS_KEY: ADMIN_KEY,
    DB: { prepare: () => { throw new Error("private database details"); } },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "review temporarily unavailable" });
  assert.equal(outbound.mock.callCount(), 0);
});

test("legacy POST /digest still requires a separately configured GitHub token", async (t) => {
  const outbound = noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const response = await worker.fetch(new Request("https://worker.test/digest", {
    method: "POST", headers: { authorization: `Bearer ${ADMIN_KEY}` },
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "GITHUB_TOKEN secret is not set");
  assert.equal(outbound.mock.callCount(), 0);
});

function adminRequest(path, method = "GET", body) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

let fixtureVideo = 1000;
function seedContributorReport(sqlite, options = {}) {
  const uuid = options.installId ?? installId();
  const result = sqlite.prepare(`INSERT INTO submissions
    (videoId, channelId, channelName, scope, installId, contributorId, reviewStatus, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`).run(
    options.videoId ?? String(fixtureVideo++).padStart(11, "0"),
    options.channelId ?? "@example", options.channelName ?? "Example",
    options.scope ?? "video", uuid,
    options.contributorId === null ? null : contributorHash(uuid),
    options.status ?? "pending", options.age ?? "-1 hour",
  );
  return Number(result.lastInsertRowid);
}

test("new reports derive the exact stable contributor hash and start pending", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  await worker.fetch(submission(payload({ installId: uuid.toUpperCase() })), env);
  const row = sqlite.prepare("SELECT installId, contributorId, reviewStatus FROM submissions").get();
  assert.equal(row.installId, uuid);
  assert.equal(row.contributorId, contributorHash(uuid));
  assert.match(row.contributorId, /^[0-9a-f]{64}$/);
  assert.equal(row.reviewStatus, "pending");
});

test("contributor list paginates active and ignored IDs with exact counts and no UUIDs", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  const a = contributorHash(installId(1)), b = contributorHash(installId(2)), c = contributorHash(installId(3));
  seedContributorReport(sqlite, { installId: installId(1), status: "useful", age: "-2 hour" });
  seedContributorReport(sqlite, { installId: installId(1), age: "-1 hour" });
  seedContributorReport(sqlite, { installId: installId(2), status: "false_positive", age: "-10 minute" });
  seedContributorReport(sqlite, { installId: installId(3), age: "-91 day" });
  const ignore = sqlite.prepare("INSERT INTO ignored_contributors (contributorId, reason) VALUES (?, ?)");
  ignore.run(b, "Repeated noise");
  ignore.run(c, "Expired reports");
  const bodies = [];
  for (let offset = 0; offset < 3; offset++) {
    const response = await worker.fetch(adminRequest(`/contributors?limit=1&offset=${offset}`), env);
    assert.equal(response.status, 200);
    bodies.push(await response.json());
  }
  for (const [offset, body] of bodies.entries()) {
    assert.deepEqual(body.summary, { active: 2, eligible: 1, ignored: 2 });
    assert.equal(body.total, 3);
    assert.equal(body.limit, 1);
    assert.equal(body.offset, offset);
  }
  assert.deepEqual(bodies.map((body) => body.contributors[0].id), [b, a, c]);
  assert.deepEqual(bodies[0].contributors[0], {
    id: b, label: `Contributor ${b.slice(0, 12)}`, reports: 1, useful: 0, falsePositive: 1, pending: 0,
    firstSeen: bodies[0].contributors[0].firstSeen, lastSeen: bodies[0].contributors[0].lastSeen,
    ignored: true, reason: "Repeated noise",
  });
  assert.equal(bodies[1].contributors[0].reports, 2);
  assert.equal(bodies[1].contributors[0].useful, 1);
  assert.equal(bodies[1].contributors[0].pending, 1);
  assert.deepEqual(bodies[2].contributors[0], {
    id: c, label: `Contributor ${c.slice(0, 12)}`, reports: 0, useful: 0, falsePositive: 0, pending: 0,
    firstSeen: null, lastSeen: null, ignored: true, reason: "Expired reports",
  });
  for (const uuid of [installId(1), installId(2), installId(3)]) {
    assert.equal(JSON.stringify(bodies).includes(uuid), false);
  }
});

test("contributor detail uses descending report IDs and a nonoverlapping nextBefore cursor", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  const hash = contributorHash(installId());
  seedContributorReport(sqlite, { age: "-91 day" });
  const one = seedContributorReport(sqlite);
  const two = seedContributorReport(sqlite, { status: "false_positive" });
  const three = seedContributorReport(sqlite, { scope: "channel", status: "useful" });
  const first = await worker.fetch(adminRequest(`/contributors/${hash.toUpperCase()}?limit=2`), env);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.contributor.id, hash);
  assert.deepEqual(body.reports.map((report) => report.id), [three, two]);
  assert.equal(body.nextBefore, two);
  assert.deepEqual(Object.keys(body.reports[0]).sort(), ["id", "scope", "videoId", "channelId", "channelName", "createdAt", "reviewStatus"].sort());
  const second = await worker.fetch(adminRequest(`/contributors/${hash}?limit=2&before=${body.nextBefore}`), env);
  const next = await second.json();
  assert.deepEqual(next.reports.map((report) => report.id), [one]);
  assert.equal(next.nextBefore, null);
  assert.equal(JSON.stringify([body, next]).includes(installId()), false);
});

test("pagination is bounded and rejects malformed cursors before querying D1", async (t) => {
  noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const hash = contributorHash(installId());
  const invalid = ["/contributors?limit=0", "/contributors?limit=1.5", "/contributors?limit=999999999999999999999",
    "/contributors?offset=-1", "/contributors?offset=abc", `/contributors/${hash}?before=0`,
    `/contributors/${hash}?before=2.1`, "/contributors/not-a-hash"];
  for (const path of invalid) {
    assert.equal((await worker.fetch(adminRequest(path), env)).status, 400);
  }
  assert.equal(env.DB.prepare.mock.callCount(), 0);
  const response = await worker.fetch(adminRequest("/contributors?limit=999&offset=0"), env);
  const body = await response.json();
  assert.equal(body.limit, 100);
  assert.equal(body.offset, 0);
});

test("moderation validates fields and body bytes before a database operation", async (t) => {
  noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const path = `/contributors/${contributorHash(installId())}/moderation`;
  const cases = [
    ["{", 400], [null, 400], [{ ignored: "true" }, 400], [{ ignored: true, reason: 1 }, 400],
    [{ ignored: true, reason: "a".repeat(301) }, 400], [{ ignored: true, extra: "field" }, 400],
    [{ ignored: true, reason: "€".repeat(1000) }, 413],
  ];
  for (const [body, status] of cases) {
    assert.equal((await worker.fetch(adminRequest(path, "PUT", body), env)).status, status);
  }
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("ignoring and resuming a known contributor is idempotent and preserves an omitted reason", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  seedContributorReport(sqlite);
  const hash = contributorHash(installId());
  const path = `/contributors/${hash}/moderation`;
  for (const body of [{ ignored: true, reason: "  Noisy reports  " }, { ignored: true }, { ignored: true }]) {
    const response = await worker.fetch(adminRequest(path, "PUT", body), env);
    assert.deepEqual(await response.json(), { ok: true, ignored: true });
  }
  const registry = sqlite.prepare("SELECT * FROM ignored_contributors").all();
  assert.equal(registry.length, 1);
  assert.equal(registry[0].reason, "Noisy reports");
  assert.match(registry[0].updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await (await worker.fetch(adminRequest(path, "PUT", { ignored: false }), env)).json(), { ok: true, ignored: false });
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ignored_contributors").get().count, 0);
});

test("unknown IDs cannot be ignored but resume is a safe no-op for a valid ID", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  const hash = contributorHash(installId());
  assert.equal((await worker.fetch(adminRequest(`/contributors/${hash}`), env)).status, 404);
  assert.equal((await worker.fetch(adminRequest(`/contributors/${hash}/moderation`, "PUT", { ignored: true }), env)).status, 404);
  assert.deepEqual(await (await worker.fetch(adminRequest(`/contributors/${hash}/moderation`, "PUT", { ignored: false }), env)).json(), { ok: true, ignored: false });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ignored_contributors").get().count, 0);
});

test("an ignored contributor's new reports are neutrally rejected without database writes", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  seedContributorReport(sqlite);
  const hash = contributorHash(installId());
  await worker.fetch(adminRequest(`/contributors/${hash}/moderation`, "PUT", { ignored: true }), env);
  const before = sqlite.prepare("SELECT total_changes() AS changes").get().changes;
  const responses = await Promise.all([
    worker.fetch(submission(payload({ videoId: "AAAAAAAAAAA" })), env),
    worker.fetch(submission(payload({ videoId: "BBBBBBBBBBB" })), env),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: false });
  }
  assert.equal(sqlite.prepare("SELECT total_changes() AS changes").get().changes, before);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 1);
  await worker.fetch(adminRequest(`/contributors/${hash}/moderation`, "PUT", { ignored: false }), env);
  assert.equal((await (await worker.fetch(submission(payload({ videoId: "AAAAAAAAAAA" })), env)).json()).accepted, true);
});

test("the atomic insert sees an ignore decision committed immediately before the write", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t);
  seedContributorReport(sqlite);
  const original = env.DB.prepare;
  env.DB.prepare = mock.fn((sql) => {
    const statement = original(sql);
    if (!sql.startsWith("INSERT OR IGNORE INTO submissions")) return statement;
    return { bind(...args) {
      const bound = statement.bind(...args);
      return { async run() {
        sqlite.prepare("INSERT INTO ignored_contributors (contributorId) VALUES (?)").run(contributorHash(installId()));
        return bound.run();
      } };
    } };
  });
  const response = await worker.fetch(submission(payload({ videoId: "CCCCCCCCCCC" })), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, accepted: false });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 1);
});

test("report review status is idempotent and only updates retained report IDs", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  const active = seedContributorReport(sqlite);
  const expired = seedContributorReport(sqlite, { age: "-91 day" });
  for (const status of ["useful", "useful", "false_positive", "pending"]) {
    const response = await worker.fetch(adminRequest(`/reports/${active}/review`, "PUT", { status }), env);
    assert.deepEqual(await response.json(), { ok: true, status });
    assert.equal(sqlite.prepare("SELECT reviewStatus FROM submissions WHERE id = ?").get(active).reviewStatus, status);
  }
  assert.equal((await worker.fetch(adminRequest(`/reports/${expired}/review`, "PUT", { status: "useful" }), env)).status, 404);
  assert.equal((await worker.fetch(adminRequest("/reports/999999/review", "PUT", { status: "useful" }), env)).status, 404);
  assert.equal(sqlite.prepare("SELECT reviewStatus FROM submissions WHERE id = ?").get(expired).reviewStatus, "pending");
});

test("report review rejects invalid IDs, statuses, and fields without any D1 calls", async (t) => {
  noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  for (const path of ["/reports/0/review", "/reports/-1/review", "/reports/1.5/review", "/reports/not-a-number/review"]) {
    assert.equal((await worker.fetch(adminRequest(path, "PUT", { status: "useful" }), env)).status, 400);
  }
  for (const body of [{ status: "good" }, { status: 1 }, { status: "pending", installId: "extra" }, {}]) {
    assert.equal((await worker.fetch(adminRequest("/reports/1/review", "PUT", body), env)).status, 400);
  }
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("ignored and false-positive reports are removed from rankings retroactively while histories remain", async (t) => {
  github(t);
  const { env, sqlite } = environment(t, {
    STATS_KEY: ADMIN_KEY, PUBLIC_RAW_BASE: "https://raw.test", GITHUB_TOKEN: "fake-github-token", REVIEW_REPO: "test/review",
  });
  const good = seedContributorReport(sqlite, { installId: installId(1), videoId: "ddddddddddd", status: "useful" });
  seedContributorReport(sqlite, { installId: installId(2), videoId: "ddddddddddd" });
  const falseVideo = seedContributorReport(sqlite, { installId: installId(1), videoId: "eeeeeeeeeee" });
  const falseChannel = seedContributorReport(sqlite, { installId: installId(1), scope: "channel", channelId: "@false" });
  seedContributorReport(sqlite, { installId: installId(2), scope: "channel", channelId: "@ignored" });
  await worker.fetch(adminRequest(`/contributors/${contributorHash(installId(2))}/moderation`, "PUT", { ignored: true, reason: "noise" }), env);
  for (const id of [falseVideo, falseChannel]) {
    await worker.fetch(adminRequest(`/reports/${id}/review`, "PUT", { status: "false_positive" }), env);
  }
  const stats = await (await worker.fetch(adminRequest("/stats"), env)).json();
  assert.deepEqual(stats.videos.map((row) => [row.videoId, row.submissions]), [["ddddddddddd", 1]]);
  assert.deepEqual(stats.channels, []);
  const review = await (await worker.fetch(adminRequest("/review"), env)).json();
  assert.deepEqual(review.digest.contributorSummary, { active: 2, eligible: 1, ignored: 1 });
  assert.deepEqual(review.digest.categories.video.map((row) => [row.id, row.blocks]), [["ddddddddddd", 1]]);
  assert.deepEqual(review.digest.categories.channel, []);
  for (const uuid of [installId(1), installId(2)]) {
    assert.equal(JSON.stringify(review).includes(uuid), false);
    assert.equal(JSON.stringify(review).includes(contributorHash(uuid)), false);
  }
  assert.doesNotMatch(review.markdown, /noise/);
  const details = await (await worker.fetch(adminRequest(`/contributors/${contributorHash(installId(1))}`), env)).json();
  assert.equal(details.contributor.reports, 3);
  assert.equal(details.contributor.falsePositive, 2);
  assert.equal(details.contributor.useful, 1);
  assert.equal(details.reports.some((report) => report.id === good), true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 5);
  await worker.fetch(adminRequest(`/contributors/${contributorHash(installId(2))}/moderation`, "PUT", { ignored: false }), env);
  await worker.fetch(adminRequest(`/reports/${falseVideo}/review`, "PUT", { status: "pending" }), env);
  const restored = await (await worker.fetch(adminRequest("/stats"), env)).json();
  assert.equal(restored.videos.find((row) => row.videoId === "ddddddddddd").submissions, 2);
  assert.equal(restored.videos.some((row) => row.videoId === "eeeeeeeeeee"), true);
  assert.equal(restored.channels.some((row) => row.channelId === "@ignored"), true);
  assert.equal(restored.channels.some((row) => row.channelId === "@false"), false);
});

test("retention preserves ignored registry rows and repeated resume after expiry safely removes them", async (t) => {
  noNetwork(t);
  const { env, sqlite } = environment(t, { STATS_KEY: ADMIN_KEY });
  const hash = contributorHash(installId());
  seedContributorReport(sqlite, { age: "-91 day" });
  sqlite.prepare("INSERT INTO ignored_contributors (contributorId, reason) VALUES (?, 'Historical ignore')").run(hash);
  const pending = [];
  await worker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions").get().count, 0);
  const list = await (await worker.fetch(adminRequest("/contributors"), env)).json();
  assert.deepEqual(list.summary, { active: 0, eligible: 0, ignored: 1 });
  assert.equal(list.contributors[0].reports, 0);
  assert.equal(list.contributors[0].lastSeen, null);
  const detail = await (await worker.fetch(adminRequest(`/contributors/${hash}`), env)).json();
  assert.deepEqual(detail.reports, []);
  assert.equal(detail.nextBefore, null);
  for (let n = 0; n < 2; n++) {
    const resumed = await worker.fetch(adminRequest(`/contributors/${hash}/moderation`, "PUT", { ignored: false }), env);
    assert.deepEqual(await resumed.json(), { ok: true, ignored: false });
  }
  assert.equal((await (await worker.fetch(adminRequest("/contributors"), env)).json()).total, 0);
});

test("all contributor administration methods reject unsupported verbs before side effects", async (t) => {
  noNetwork(t);
  const { env } = environment(t, { STATS_KEY: ADMIN_KEY });
  const id = contributorHash(installId());
  for (const [path, method, allow] of [["/contributors", "POST", "GET"], [`/contributors/${id}`, "PUT", "GET"],
    [`/contributors/${id}/moderation`, "GET", "PUT"], ["/reports/1/review", "GET", "PUT"]]) {
    const response = await worker.fetch(adminRequest(path, method), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), allow);
  }
  assert.equal(env.DB.prepare.mock.callCount(), 0);
});

test("contributor administration failures do not leak values in responses or diagnostics", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  noNetwork(t);
  const response = await worker.fetch(adminRequest("/contributors"), {
    STATS_KEY: ADMIN_KEY, DB: { prepare() { throw new Error(`private UUID ${installId()} and secret`); } },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "operation temporarily unavailable" });
  assert.equal(JSON.stringify(errors.mock.calls).includes(installId()), false);
});

test("additive contributor migration preserves legacy rows and signals backfill without hiding rankings", async (t) => {
  github(t);
  const oldSchema = `CREATE TABLE submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, videoId TEXT, channelId TEXT, channelName TEXT,
    scope TEXT NOT NULL CHECK(scope IN ('video', 'channel')), installId TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT(datetime('now'))
  );
  CREATE UNIQUE INDEX uniq_video_per_install ON submissions(installId, videoId) WHERE scope='video';
  CREATE UNIQUE INDEX uniq_channel_per_install ON submissions(installId, channelId) WHERE scope='channel';
  CREATE INDEX idx_install_created ON submissions(installId, createdAt);
  CREATE INDEX idx_submission_created ON submissions(createdAt);`;
  const { DB, sqlite } = d1(t, oldSchema);
  for (let n = 1; n <= 5; n++) {
    sqlite.prepare("INSERT INTO submissions(videoId, scope, installId) VALUES (?, 'video', ?)")
      .run(String(n).padStart(11, "0"), installId(n));
  }
  sqlite.exec(readFileSync(new URL("../backend/migrations/0002_contributor_moderation.sql", import.meta.url), "utf8"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM submissions WHERE reviewStatus='pending' AND contributorId IS NULL").get().count, 5);
  const env = { DB, STATS_KEY: ADMIN_KEY, PUBLIC_RAW_BASE: "https://raw.test" };
  const stats = await (await worker.fetch(adminRequest("/stats"), env)).json();
  assert.equal(stats.videos.length, 5);
  const review = await (await worker.fetch(adminRequest("/review"), env)).json();
  assert.deepEqual(review.digest.contributorSummary, { active: 5, eligible: 5, ignored: 0 });
  assert.equal((await worker.fetch(adminRequest("/contributors"), env)).status, 503);
  assert.equal((await worker.fetch(adminRequest(`/contributors/${contributorHash(installId())}`), env)).status, 503);
  const update = sqlite.prepare("UPDATE submissions SET contributorId=? WHERE id=?");
  for (const row of sqlite.prepare("SELECT id, installId FROM submissions").all()) {
    update.run(contributorHash(row.installId), row.id);
  }
  const list = await (await worker.fetch(adminRequest("/contributors"), env)).json();
  assert.equal(list.total, 5);
  assert.deepEqual(list.summary, { active: 5, eligible: 5, ignored: 0 });
  for (let n = 1; n <= 5; n++) assert.equal(JSON.stringify(list).includes(installId(n)), false);
  // The old Worker can still insert by its original named columns during rollout.
  sqlite.prepare("INSERT INTO submissions(videoId, scope, installId) VALUES ('rollout0001', 'video', ?)").run(installId(6));
  assert.equal((await worker.fetch(adminRequest("/contributors"), env)).status, 503);
  update.run(contributorHash(installId(6)), 6);
  assert.equal((await (await worker.fetch(adminRequest("/contributors"), env)).json()).total, 6);
});
