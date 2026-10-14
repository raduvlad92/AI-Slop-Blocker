import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest, createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewAdmin, requestBackend } from "../scripts/review-admin.mjs";

const KEY = "test-only-secret-that-must-stay-out-of-the-browser";
const ID = "a".repeat(64);
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
async function helper(t, transport) {
  const app = await startReviewAdmin({ backendUrl: "https://worker.test", statsKey: KEY, port: 0, transport });
  t.after(() => new Promise((resolve) => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return app;
}

test("private helper exposes no credential and rejects cross-site requests before privileged calls", async (t) => {
  let calls = 0;
  const app = await helper(t, async () => { calls++; return { status: 200, body: {} }; });
  assert.equal(app.server.address().address, "127.0.0.1");
  const page = await fetch(app.origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!html.includes(KEY));
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const headers of [
    {},
    { "x-asb-admin": "1", origin: "https://attacker.test" },
    { "x-asb-admin": "1", "sec-fetch-site": "cross-site" },
    { "x-asb-admin": "1", host: "attacker.test" },
  ]) {
    const response = await rawGet(`${app.origin}/api/contributors`, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.ok(!response.text.includes(KEY));
  }
  const form = await fetch(`${app.origin}/api/contributors/${ID}/moderation`, {
    method: "POST", headers: { origin: "https://attacker.test", "content-type": "application/x-www-form-urlencoded" }, body: "ignored=true",
  });
  assert.equal(form.status, 403);
  assert.equal(calls, 0);
});

test("same-origin admin changes are forwarded privately and arbitrary routes/queries cannot use the credential", async (t) => {
  const calls = [];
  const app = await helper(t, async (request) => { calls.push(request); return { status: 200, body: { ok: true, ignored: request.body.ignored } }; });
  const headers = { "x-asb-admin": "1", "content-type": "application/json", origin: app.origin };
  for (const path of ["/api/https://attacker.test", "/api/contributors?url=https://attacker.test", `/api/contributors/${ID}/moderation?key=anything`]) {
    const response = await fetch(app.origin + path, { headers });
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal(calls.length, 0);
  const response = await fetch(`${app.origin}/api/contributors/${ID}/moderation`, {
    method: "PUT", headers, body: JSON.stringify({ ignored: true, reason: "Manual review" }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(KEY));
  assert.deepEqual(JSON.parse(text), { ok: true, ignored: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].statsKey, KEY);
  assert.equal(calls[0].backendUrl, "https://worker.test");
  assert.equal(calls[0].path, `/contributors/${ID}/moderation`);
  assert.deepEqual(calls[0].body, { ignored: true, reason: "Manual review" });
});

test("private helper bounds mutation bodies and never exposes upstream exception details", async (t) => {
  let calls = 0;
  const app = await helper(t, async () => { calls++; throw new Error(`Private transport failure: ${KEY}`); });
  const headers = { "x-asb-admin": "1", "content-type": "application/json" };
  const oversized = await fetch(`${app.origin}/api/reports/1/review`, {
    method: "PUT", headers, body: JSON.stringify({ status: "pending", excess: "x".repeat(3000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
  const failed = await fetch(`${app.origin}/api/contributors`, { headers });
  assert.equal(failed.status, 502);
  const body = await failed.text();
  assert.ok(!body.includes(KEY));
  assert.equal(calls, 1);
});

test("admin helper rejects credential-bearing and insecure service URLs", async () => {
  for (const backendUrl of ["http://worker.test", "https://user:password@worker.test", "https://worker.test/?key=secret", "https://worker.test/path"]) {
    await assert.rejects(startReviewAdmin({ backendUrl, statsKey: KEY, port: 0 }), /HTTPS base URL/);
  }
});

test("privileged transport ignores curl defaults that would forward its credential on redirects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "asb-curl-config-"));
  await writeFile(join(directory, ".curlrc"), "location-trusted\n");
  const previous = process.env.CURL_HOME;
  process.env.CURL_HOME = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.CURL_HOME; else process.env.CURL_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  let forwarded = 0;
  const receiver = createServer((_request, response) => { forwarded++; response.end("{}"); });
  await new Promise((ready) => receiver.listen(0, "127.0.0.1", ready));
  const redirect = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    response.writeHead(302, { location: `http://127.0.0.1:${receiver.address().port}/stolen` }).end("{}");
  });
  await new Promise((ready) => redirect.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((ready) => receiver.close(ready)));
  t.after(() => new Promise((ready) => redirect.close(ready)));
  // HTTP loopback fixtures contain only the fake test credential. The actual
  // helper validates an HTTPS base URL before calling this transport.
  await assert.rejects(requestBackend({ backendUrl: `http://127.0.0.1:${redirect.address().port}`, statsKey: KEY, path: "/contributors", method: "GET" }), /unexpected response/);
  assert.equal(forwarded, 0);
});
