// Validates blocklist/*.json so a malformed merge can never break the
// extension's fetch/parse. Run by .github/workflows/validate-blocklist.yml.
const fs = require("fs");

const ID_RES = {
  "blocklist/videos.json": /^[A-Za-z0-9_-]{11}$/,
  "blocklist/channels.json": /^(UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{1,50})$/,
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let failed = false;
const fail = (msg) => {
  console.error(`ERROR: ${msg}`);
  failed = true;
};

for (const [file, idRe] of Object.entries(ID_RES)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${file}: not valid JSON — ${e.message}`);
    continue;
  }
  if (!Array.isArray(data)) {
    fail(`${file}: must be a flat JSON array`);
    continue;
  }

  const seen = new Set();
  data.forEach((entry, i) => {
    const where = `${file}[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return fail(`${where}: must be an object {id, name?, added, reason?}`);
    }
    const { id, name, added, reason, ...rest } = entry;
    if (typeof id !== "string" || !idRe.test(id)) {
      fail(`${where}: invalid id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) fail(`${where}: duplicate id ${id}`);
    seen.add(id);
    if (typeof added !== "string" || !DATE_RE.test(added)) {
      fail(`${where}: "added" must be YYYY-MM-DD, got ${JSON.stringify(added)}`);
    }
    if (name !== undefined && (typeof name !== "string" || name.length > 100)) {
      fail(`${where}: "name" must be a string of at most 100 chars`);
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 300)) {
      fail(`${where}: "reason" must be a string of at most 300 chars`);
    }
    for (const key of Object.keys(rest)) fail(`${where}: unknown field "${key}"`);
  });
  console.log(`${file}: ${data.length} entries OK`);
}

process.exit(failed ? 1 : 0);
