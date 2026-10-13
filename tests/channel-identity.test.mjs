import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/content/channel-identity.js", import.meta.url), "utf8");
const context = vm.createContext({ URL, Date });
vm.runInContext(source, context);
const channels = context.ASBChannels;
const ID = "UCabcdefghijklmnopqrstuv";
const OTHER_ID = "UCABCDEFGHIJKLMNOPQRSTUV";
const THIRD_ID = "UC1234567890123456789012";
const NOW = 20 * 864e5;
const plain = (value) => value === null ? null : JSON.parse(JSON.stringify(value));
const page = (id = ID, handle = "@creator") =>
  `<meta itemprop="channelId" content="${id}"><link rel="canonical" href="https://www.youtube.com/${handle}">`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture(initial = {}, fetchPage = async () => page()) {
  let state = structuredClone({ channelAliases: {}, personal: { videos: {}, channels: {} }, community: { channels: [] }, ...initial });
  let tail = Promise.resolve();
  const requests = [];
  const writes = [];
  const storage = {
    async get(defaults) {
      return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, structuredClone(state[key] ?? fallback)]));
    },
    async set(data) { state = { ...state, ...structuredClone(data) }; writes.push(structuredClone(data)); },
  };
  const mutate = (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
  const resolve = channels.createResolver({
    storage, mutate, now: () => NOW,
    fetchPage: async (url) => { requests.push(url); return fetchPage(url); },
  });
  return { resolve, storage, mutate, requests, writes, state: () => structuredClone(state) };
}

test("normalizes canonical IDs without changing their case", () => {
  for (const value of [ID, ` ${ID} `, `https://www.youtube.com/channel/${ID}`, `/channel/${ID}/videos`]) {
    assert.equal(channels.normalize(value), ID);
  }
  assert.equal(channels.normalize(ID.toLowerCase()), null);
});

test("normalizes encoded, Unicode, decomposed and case-varied handles", () => {
  for (const value of ["@CAFÉ", "@Cafe\u0301", "@CAF%C3%89", "https://m.youtube.com/@CAF%C3%89/videos", "/@CAF%C3%89"]) {
    assert.equal(channels.normalize(value), "@café");
  }
  assert.equal(channels.normalize("@中文·频道"), "@中文·频道");
  assert.equal(channels.normalize("@Mixed.Name-1_"), "@mixed.name-1_");
});

test("rejects malformed, foreign-host and non-channel identifiers", () => {
  for (const value of [null, {}, "@", "@bad name", "@bad/slash", "@bad%ZZ", "UCshort", "https://example.com/@creator", "https://www.youtube.com.evil.com/@creator", "/watch?v=video", "/user/creator", "//evil.com/@creator"]) {
    assert.equal(channels.normalize(value), null, String(value));
  }
});

test("canonical mapping accepts only valid canonical IDs", () => {
  assert.equal(channels.canonical("@CREATOR", { "@creator": ID }), ID);
  assert.equal(channels.canonical("@CREATOR", { "@creator": { id: ID, resolvedAt: NOW } }, NOW), ID);
  assert.equal(channels.canonical("@creator", { "@creator": { id: "bad" } }), "@creator");
  assert.equal(channels.canonical("bad", {}), null);
  assert.equal(channels.canonical("@creator", { "@creator": { id: ID, resolvedAt: NOW - channels.CACHE_MS } }, NOW), "@creator");
});

test("refreshing a renamed channel removes its old handle alias", async () => {
  const f = fixture({ personal: { videos: {}, channels: { [ID]: {} } }, channelAliases: {
    [ID]: { id: ID, resolvedAt: NOW - channels.CACHE_MS },
    "@old": { id: ID, resolvedAt: NOW - channels.CACHE_MS },
    "@other": { id: OTHER_ID, resolvedAt: NOW },
  } }, async () => page(ID, "@new"));
  await f.resolve([ID]);
  assert.equal(f.state().channelAliases["@old"], undefined);
  assert.equal(f.state().channelAliases["@new"].id, ID);
  assert.equal(f.state().channelAliases["@other"].id, OTHER_ID);
});

test("community handles become canonical entries with a retained source binding", async () => {
  const f = fixture({ community: { videos: ["AAAAAAAAAAA"], channels: ["@creator", OTHER_ID], syncedAt: 123 } });
  await f.resolve(["@creator"]);
  assert.deepEqual(f.state().community.channels, [ID, OTHER_ID]);
  assert.equal(f.state().communityChannelBindings["@creator"], ID);
  assert.equal(f.state().community.syncedAt, 123);
  assert.deepEqual(f.state().community.videos, ["AAAAAAAAAAA"]);
});

test("lookup concurrency stays bounded across multiple callers", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `UC${String(i).padStart(22, "0")}`);
  let active = 0, peak = 0;
  const f = fixture({ community: { channels: ids } }, async (url) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const id = url.split("/").at(-1);
    return page(id, `@channel${ids.indexOf(id)}`);
  });
  await Promise.all([f.resolve(ids.slice(0, 4)), f.resolve(ids.slice(4))]);
  assert.equal(f.requests.length, 8);
  assert.ok(peak <= 4);
});

test("parses quoted metadata attributes and canonical handles", () => {
  const html = `<meta content='${ID}' itemprop='channelId'><link href='https://www.youtube.com/@CAF%C3%89' rel='canonical'>`;
  assert.deepEqual(plain(channels.parsePage(html, "@café")), { id: ID, aliases: ["@café"] });
  assert.deepEqual(plain(channels.parsePage(`<link rel="canonical" href="https://www.youtube.com/channel/${ID}">`, ID)), { id: ID, aliases: [] });
});

test("initialData scanner tolerates braces and escaped quotes inside JSON strings", () => {
  const metadata = { metadata: { channelMetadataRenderer: { externalId: ID, vanityChannelUrl: "https://www.youtube.com/@CAF%C3%89", channelUrl: `https://www.youtube.com/channel/${ID}`, title: 'A } brace and "quoted" name \\' } } };
  for (const assignment of ["var ytInitialData = ", 'window["ytInitialData"] = ', "ytInitialData = "]) {
    const html = `<script>${assignment}${JSON.stringify(metadata)}; unrelatedFunction({ trailing: true });</script>`;
    assert.deepEqual(plain(channels.parsePage(html, ID)), { id: ID, aliases: ["@café"] });
  }
});

test("rejects wrong canonical channels, malformed data and consent pages", () => {
  assert.equal(channels.parsePage(page(OTHER_ID), ID), null);
  assert.equal(channels.parsePage(page(ID, "@other"), "@creator"), null);
  assert.equal(channels.parsePage('<script>var ytInitialData = {"metadata": broken;</script>', ID), null);
  assert.equal(channels.parsePage('<html><title>Before you continue to YouTube</title><form action="https://consent.youtube.com/save">Consent</form></html>', ID), null);
  assert.equal(channels.parsePage('<link rel="canonical" href="https://example.com/channel/UCabcdefghijklmnopqrstuv">', ID), null);
});

test("rejects contradictory canonical and metadata channel identities", () => {
  const html = `<meta itemprop="channelId" content="${ID}"><link rel="canonical" href="https://www.youtube.com/channel/${OTHER_ID}">`;
  assert.equal(channels.parsePage(html, "@creator"), null);
});

test("rejects a channelUrl that conflicts with initialData externalId", () => {
  const metadata = { metadata: { channelMetadataRenderer: { externalId: ID, channelUrl: `https://www.youtube.com/channel/${OTHER_ID}` } } };
  assert.equal(channels.parsePage(`<script>var ytInitialData=${JSON.stringify(metadata)};</script>`, ID), null);
});

test("rejects a foreign canonical link even beside valid channel metadata", () => {
  const html = `<meta itemprop="channelId" content="${ID}"><link rel="canonical" href="https://example.com/@creator">`;
  assert.equal(channels.parsePage(html, "@creator"), null);
});

test("does not treat data-* lookalike attributes as identity metadata", () => {
  const html = `<meta data-itemprop="channelId" data-content="${ID}"><link data-rel="canonical" data-href="https://www.youtube.com/@creator">`;
  assert.equal(channels.parsePage(html, "@creator"), null);
});

test("resolver fetches only blocked channels, deduping normalized requests", async () => {
  const f = fixture({ personal: { videos: {}, channels: { "@CREATOR": { name: "Creator" } } }, community: { channels: [OTHER_ID] } }, async (url) => url.includes(OTHER_ID) ? page(OTHER_ID, "@other") : page());
  await f.resolve(["@unblocked", "@creator", "@CREATOR", OTHER_ID, THIRD_ID, "garbage"]);
  assert.deepEqual(f.requests.sort(), [`https://www.youtube.com/@creator`, `https://www.youtube.com/channel/${OTHER_ID}`].sort());
  assert.equal(f.state().channelAliases["@creator"].id, ID);
  assert.equal(f.state().channelAliases[OTHER_ID].id, OTHER_ID);
});

test("fresh successful resolutions are cached and stale ones are refreshed", async () => {
  const f = fixture({ personal: { videos: {}, channels: { ID: {}, "@creator": {} } }, channelAliases: { "@creator": { id: ID, resolvedAt: NOW - channels.CACHE_MS + 1 } } });
  await f.resolve(["@creator"]);
  assert.equal(f.requests.length, 0);
  await f.storage.set({ channelAliases: { "@creator": { id: ID, resolvedAt: NOW - channels.CACHE_MS } } });
  await f.resolve(["@creator"]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state().channelAliases["@creator"].resolvedAt, NOW);
});

test("a malformed recent cache record does not prevent identity repair", async () => {
  const f = fixture({ personal: { videos: {}, channels: { "@creator": {} } }, channelAliases: { "@creator": { id: "not-a-channel", resolvedAt: NOW } } });
  await f.resolve(["@creator"]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.state().channelAliases["@creator"].id, ID);
});

test("lookup failures and invalid pages preserve all existing state", async () => {
  for (const fetchPage of [async () => { throw new Error("network unavailable"); }, async () => "<html>Consent</html>"]) {
    const f = fixture({ personal: { videos: { video: { name: "Keep" } }, channels: { "@creator": { name: "Keep creator" } } }, channelAliases: { "@unrelated": { id: OTHER_ID, resolvedAt: 1 } } }, fetchPage);
    const before = f.state();
    await f.resolve(["@creator"]);
    assert.deepEqual(f.state(), before);
    assert.equal(f.writes.length, 0);
  }
});

test("concurrent resolution requests share one in-flight fetch", async () => {
  const response = deferred();
  const f = fixture({ personal: { videos: {}, channels: { "@creator": {} } } }, () => response.promise);
  const first = f.resolve(["@creator"]);
  const second = f.resolve(["@CREATOR"]);
  await new Promise(setImmediate);
  assert.equal(f.requests.length, 1);
  response.resolve(page());
  await Promise.all([first, second]);
  assert.equal(f.writes.length, 1);
});

test("handle migration preserves concurrent block writes and unrelated entries", async () => {
  const response = deferred();
  const blockGate = deferred();
  const f = fixture({ personal: { videos: { original: { name: "Original" } }, channels: { "@creator": { name: "Creator", addedAt: 1 }, [OTHER_ID]: { name: "Other" } } }, channelAliases: { "@other": { id: OTHER_ID, resolvedAt: NOW } } }, () => response.promise);
  const resolving = f.resolve(["@creator"]);
  await new Promise(setImmediate);
  const blocking = f.mutate(async () => {
    const { personal } = await f.storage.get({ personal: {} });
    personal.channels[THIRD_ID] = { name: "New simultaneous block" };
    personal.videos.concurrent = { name: "Simultaneous video" };
    await blockGate.promise;
    await f.storage.set({ personal });
  });
  response.resolve(page());
  await new Promise(setImmediate);
  blockGate.resolve();
  await Promise.all([resolving, blocking]);
  const saved = f.state();
  assert.equal(saved.personal.channels["@creator"], undefined);
  assert.deepEqual(saved.personal.channels[ID], { name: "Creator", addedAt: 1 });
  assert.deepEqual(saved.personal.channels[OTHER_ID], { name: "Other" });
  assert.deepEqual(saved.personal.channels[THIRD_ID], { name: "New simultaneous block" });
  assert.deepEqual(saved.personal.videos, { original: { name: "Original" }, concurrent: { name: "Simultaneous video" } });
  assert.equal(saved.channelAliases["@other"].id, OTHER_ID);
});

test("migration merges case/encoded aliases and preserves an existing canonical block", async () => {
  const existing = { name: "Canonical creator", addedAt: 10 };
  const f = fixture({ personal: { videos: {}, channels: { "@CAF%C3%89": { name: "Encoded" }, "@Cafe\u0301": { name: "Decomposed" }, [ID]: existing, [OTHER_ID]: { name: "Other" } } } }, async () => page(ID, "@CAF%C3%89"));
  await f.resolve(["@café"]);
  assert.deepEqual(f.requests, ["https://www.youtube.com/@caf%C3%A9"]);
  assert.deepEqual(f.state().personal.channels, { [ID]: existing, [OTHER_ID]: { name: "Other" } });
});
