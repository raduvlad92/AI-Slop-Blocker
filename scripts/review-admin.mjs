import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;

// The credential is piped through stdin, never a command argument or browser
// response. curl does not follow redirects and PUT operations are idempotent.
export function requestBackend({ backendUrl, statsKey, path, method, body }) {
  const lines = [
    `url = ${JSON.stringify(backendUrl + path)}`,
    `request = ${JSON.stringify(method)}`,
    `header = ${JSON.stringify(`Authorization: Bearer ${statsKey}`)}`,
    'header = "Accept: application/json"',
    'user-agent = "AI-Slop-Review-Admin/0.1.2"',
  ];
  if (body !== undefined) {
    lines.push('header = "Content-Type: application/json"');
    lines.push(`data = ${JSON.stringify(JSON.stringify(body))}`);
  }
  return new Promise((resolveRequest, reject) => {
    const child = spawn("curl", ["--disable", "--config", "-", "--silent", "--show-error",
      "--connect-timeout", "8", "--max-time", "20", "--retry", "1",
      "--retry-all-errors", "--write-out", "\n%{http_code}"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The reporting service took too long to respond."));
    }, 45000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        child.kill();
        reject(new Error("The reporting service returned too much data."));
      } else chunks.push(chunk);
    });
    // Drain error output without exposing request details or credentials.
    child.stderr.on("data", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new Error("Could not start curl. Install curl and try again.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Could not contact the reporting service. Please retry."));
      const output = Buffer.concat(chunks).toString("utf8");
      const split = output.lastIndexOf("\n");
      const status = Number(output.slice(split + 1));
      // A redirect must not be followed with the administrator credential.
      if (!Number.isInteger(status) || status < 200 || status >= 600 || (status >= 300 && status < 400)) {
        return reject(new Error("The reporting service returned an unexpected response."));
      }
      try { resolveRequest({ status, body: JSON.parse(output.slice(0, split)) }); }
      catch { reject(new Error("The reporting service returned an invalid response.")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(lines.join("\n") + "\n");
  });
}

export async function startReviewAdmin({ backendUrl, statsKey, port = 8768, transport = requestBackend }) {
  const target = new URL(backendUrl);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || !["", "/"].includes(target.pathname)) {
    throw new Error("The reporting service must be an HTTPS base URL.");
  }
  if (typeof statsKey !== "string" || !statsKey.trim() || /[\r\n]/.test(statsKey)) throw new Error("A valid administrator credential is required.");
  backendUrl = target.origin;
  const assets = new Map([
    ["/", ["admin/index.html", "text/html; charset=utf-8"]],
    ["/admin.js", ["admin/admin.js", "text/javascript; charset=utf-8"]],
    ["/admin.css", ["admin/admin.css", "text/css; charset=utf-8"]],
  ]);
  let origin;
  const server = createServer(async (request, response) => {
    const headers = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    };
    const json = (value, status = 200) => response.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify(value));
    try {
      // Host and Origin checks prevent DNS rebinding and cross-site access to
      // this passwordless loopback helper. API requests also need a custom
      // header, so another website cannot submit forms to the admin proxy.
      if (request.headers.host !== new URL(origin).host) return json({ error: "Use the local review URL shown in the terminal." }, 403);
      if ((request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
        return json({ error: "Cross-site requests are not allowed." }, 403);
      }
      const url = new URL(request.url, origin);
      const asset = assets.get(url.pathname);
      if (asset && request.method === "GET") {
        response.writeHead(200, { ...headers, "content-type": asset[1] }).end(await readFile(resolve(directory, asset[0])));
        return;
      }
      if (!url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
      if (request.headers["x-asb-admin"] !== "1") return json({ error: "Open the local review page to use these controls." }, 403);
      if (url.pathname === "/api/config" && request.method === "GET") return json({ backendUrl });
      const path = url.pathname.slice(4);
      const list = path === "/contributors" && request.method === "GET";
      const detail = /^\/contributors\/[0-9a-f]{64}$/.test(path) && request.method === "GET";
      const moderation = /^\/contributors\/[0-9a-f]{64}\/moderation$/.test(path) && request.method === "PUT";
      const review = /^\/reports\/[1-9][0-9]*\/review$/.test(path) && request.method === "PUT";
      if (!list && !detail && !moderation && !review) return json({ error: "Unsupported review operation." }, 404);
      const allowed = list ? ["limit", "offset"] : detail ? ["limit", "before"] : [];
      if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) return json({ error: "Unsupported query parameter." }, 400);
      let body;
      if (moderation || review) {
        if (!request.headers["content-type"]?.startsWith("application/json")) return json({ error: "Use a JSON request." }, 400);
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 2048) return json({ error: "Request too large." }, 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return json({ error: "Invalid JSON." }, 400); }
      }
      const result = await transport({ backendUrl, statsKey, path: path + url.search, method: request.method, body });
      json(result.body, result.status);
    } catch {
      // Do not include backend credential/header values in browser responses.
      json({ error: "Could not load the review. Check the reporting service and retry." }, 502);
    }
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", ready);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const credentialPath = process.env.ASB_ADMIN_CREDENTIAL_FILE || resolve(homedir(), ".local/share/ai-slop-blocker/release-admin.json");
    const credential = process.env.ASB_STATS_KEY ? {} : JSON.parse(await readFile(credentialPath, "utf8"));
    const app = await startReviewAdmin({
      backendUrl: process.env.ASB_API_URL || credential.backendUrl || "https://aislopblocker-api.radu-vlad-92.workers.dev",
      statsKey: process.env.ASB_STATS_KEY || credential.statsKey,
      port: Number(process.env.ASB_ADMIN_PORT || 8768),
    });
    console.log(`Private community review: ${app.origin}`);
    console.log("Administrator credential stays in this local process. Press Ctrl+C to stop.");
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.server.close(() => process.exit(0)));
  } catch {
    console.error("Could not start private review. Check the local admin credential and whether port 8768 is available. Set ASB_ADMIN_CREDENTIAL_FILE or ASB_STATS_KEY locally if needed; never put credentials in chat or Git.");
    process.exitCode = 1;
  }
}
