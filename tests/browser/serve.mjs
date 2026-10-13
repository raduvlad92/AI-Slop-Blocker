import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const port = Number(process.env.ASB_TEST_PORT || 8766);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/release-preview/options") {
    const source = await readFile(resolve(root, "extension/options/options.html"), "utf8");
    const html = source
      .replace('href="options.css"', 'href="/extension/options/options.css"')
      .replace('src="options.js"', 'src="/extension/options/options.js"')
      .replace('href="../privacy.html"', 'href="/extension/privacy.html"')
      .replace("</head>", '<script src="/tests/browser/store-preview.js"></script></head>');
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    return;
  }
  if (path === "/fixture") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    return;
  }
  const file = resolve(root, `.${path === "/" ? "/tests/browser/index.html" : path}`);
  if (!file.startsWith(root + sep) || !["/extension/", "/tests/browser/"].some((prefix) => path.startsWith(prefix) || path === "/")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Browser regressions: http://127.0.0.1:${port}/ (all reports and channel requests mocked)`));
