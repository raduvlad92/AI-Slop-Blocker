import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, mock } from "node:test";

const source = readFileSync(new URL("../backend/src/index.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../backend/schema.sql", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const ADMIN_KEY = "test-only-long-admin-credential";
const installId = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const payload = (overrides = {}) => ({
  videoId: "dQw4w9WgXcQ", scope: "video", installId: installId(), ...overrides,
});

function d1(t) {
  // D1's API is mocked, but the shipped SQL runs against real in-memory SQLite.
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  const DB = {
    prepare: mock.fn((sql) => ({
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

const adminEndpoints = [{ path: "/stats", method: "GET" }, { path: "/digest", method: "POST" }];
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
