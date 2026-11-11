import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?\} from "\.\/config\.js";\n/m, "")
  .replace(/^import "[^\"]+";\n/gm, "");
const commonSource = await readFile(new URL("../extension/content/common.js", import.meta.url), "utf8");
const identityContext = vm.createContext({ URL, Date });
vm.runInContext(await readFile(new URL("../extension/content/channel-identity.js", import.meta.url), "utf8"), identityContext);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const videoId = (index) => `v${String(index).padStart(10, "0")}`;

function harness(initial = {}, extraGlobals = {}) {
  const state = structuredClone(initial);
  const reports = [];
  let listener;
  let failNextWrite = false;
  const noOpEvent = { addListener() {} };
  const chrome = {
    runtime: {
      id: "asb-test-extension",
      getURL: (path) => `chrome-extension://asb-test-extension/${path}`,
      onInstalled: noOpEvent,
      onStartup: noOpEvent,
      onMessage: { addListener(callback) { listener = callback; } },
    },
    storage: {
      local: {
        onChanged: noOpEvent,
        async get(keys) {
          let result;
          if (typeof keys === "string") result = { [keys]: state[keys] };
          else if (Array.isArray(keys)) result = Object.fromEntries(keys.map((key) => [key, state[key]]));
          else result = { ...keys, ...Object.fromEntries(Object.keys(keys).filter((key) => key in state).map((key) => [key, state[key]])) };
          // Capture a snapshot before yielding, as independent extension
          // contexts do. Without serialization, concurrent writes lose data.
          result = structuredClone(result);
          await tick();
          return result;
        },
        async set(change) {
          await tick();
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("simulated storage failure");
          }
          Object.assign(state, structuredClone(change));
        },
      },
    },
    alarms: { create() {}, onAlarm: noOpEvent },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {} },
  };
  vm.runInNewContext(backgroundSource, {
    chrome, console, setTimeout, crypto, TextEncoder,
    ASBChannels: identityContext.ASBChannels,
    BACKEND_URL: "https://example.invalid",
    BLOCKLIST_VIDEOS_URL: "https://example.invalid/videos",
    BLOCKLIST_CHANNELS_URL: "https://example.invalid/channels",
    SYNC_INTERVAL_MINUTES: 360,
    async fetch(url, options) {
      reports.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
    ...extraGlobals,
  });

  function send(message, sender = { id: chrome.runtime.id }) {
    return new Promise((resolve) => {
      let replied = false;
      const keepOpen = listener(message, sender, (response) => {
        replied = true;
        resolve(structuredClone(response));
      });
      if (!keepOpen && !replied) resolve(undefined);
    });
  }

  function contentHelpers() {
    const context = { chrome: { runtime: { sendMessage: send } } };
    vm.createContext(context);
    vm.runInContext(`${commonSource}\nglobalThis.helpers = ASB;`, context);
    return context.helpers;
  }

  return {
    state, reports, send, contentHelpers,
    failWrite() { failNextWrite = true; },
  };
}

const blockMessage = (index, overrides = {}) => ({
  type: "asb-block",
  scope: "video",
  info: { videoId: videoId(index), channelId: "@example", channelName: "Example" },
  mins: index + 1,
  ...overrides,
});

test("concurrent content tabs preserve every block, counter increment, and event", async () => {
  const app = harness({ installId: "install-for-test", reportingConsent: { enabled: true, updatedAt: Date.now() } });
  const tabs = Array.from({ length: 12 }, () => app.contentHelpers());
  await Promise.all(tabs.flatMap((helpers, index) => [
    helpers.block("video", blockMessage(index).info, index + 1),
    helpers.logEvent("overview"),
  ]));
  await tick();

  assert.deepEqual(Object.keys(app.state.personal.videos).sort(), tabs.map((_, index) => videoId(index)).sort());
  assert.equal(app.state.blockedCount, 12);
  assert.equal(app.state.events.filter((event) => event.kind === "video").length, 12);
  assert.equal(app.state.events.filter((event) => event.kind === "overview").length, 12);
  assert.deepEqual(app.state.events.filter((event) => event.kind === "video").map((event) => event.mins).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(app.reports.length, 12);
  assert.equal(app.reports[0].body.installId, "install-for-test");
});

test("options removal and a simultaneous block do not resurrect or drop unrelated entries", async () => {
  const app = harness({
    personal: { videos: { [videoId(0)]: {}, [videoId(2)]: {} }, channels: {} },
    blockedCount: 2,
  });
  const results = await Promise.all([
    app.send(blockMessage(1)),
    app.send({ type: "asb-remove-block", storageKey: "videos", id: videoId(0) }),
    app.send({ type: "asb-log-event", kind: "overview" }),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(Object.keys(app.state.personal.videos).sort(), [videoId(1), videoId(2)]);
  assert.equal(app.state.blockedCount, 3);
  assert.equal(app.state.events.length, 2);
});

test("removing a channel also removes the companion video created by that block", async () => {
  const app = harness();
  const response = await app.send(blockMessage(0, { scope: "channel" }));
  assert.equal(response.ok, true);
  assert.equal(response.personal.channels["@example"].name, "Example");
  assert.equal(response.personal.videos[videoId(0)].channelName, "Example");
  assert.equal(response.events.length, 1);
  await app.send({ type: "asb-remove-block", storageKey: "channels", id: "@example" });
  assert.deepEqual(app.state.personal.channels, {});
  assert.equal(app.state.personal.videos[videoId(0)], undefined);
  assert.equal(app.state.blockedCount, 1);
});

test("failed writes report failure and the queue continues with the next request", async () => {
  const app = harness({ installId: "install-for-test", reportingConsent: { enabled: true, updatedAt: Date.now() } });
  app.failWrite();
  await assert.rejects(app.contentHelpers().block("video", blockMessage(0).info, 8), /simulated storage failure/);
  const response = await app.send(blockMessage(1));
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(app.state.personal.videos), [videoId(1)]);
  assert.equal(app.state.blockedCount, 1);
  assert.equal(app.state.events.length, 1);
  await tick();
  assert.equal(app.reports.length, 1);
});

test("events retain the 90-day and 5000-entry limits", async () => {
  const now = Date.now();
  const app = harness({ events: [
    { t: now - 91 * 864e5, kind: "overview" },
    ...Array.from({ length: 5000 }, (_, index) => ({ t: now - 5000 + index, kind: "video" })),
  ] });
  await app.send({ type: "asb-log-event", kind: "overview" });
  assert.equal(app.state.events.length, 5000);
  assert.ok(app.state.events.every((event) => event.t >= now - 90 * 864e5));
  assert.equal(app.state.events.at(-1).kind, "overview");
});

test("mutations reject other extensions and invalid scopes without changing storage", async () => {
  const app = harness();
  assert.equal(await app.send(blockMessage(0), { id: "another-extension" }), undefined);
  const responses = await Promise.all([
    app.send(blockMessage(0, { scope: "unknown" })),
    app.send({ type: "asb-log-event", kind: "unknown" }),
    app.send({ type: "asb-remove-block", storageKey: "settings", id: "@example" }),
    app.send({ type: "asb-remove-block", storageKey: "channels", id: "__proto__" }),
  ]);
  assert.ok(responses.every((response) => response.ok === false));
  assert.deepEqual(app.state, {});
  assert.equal(app.reports.length, 0);
});

test("channel blocks use aliases when the identity module is available", async () => {
  const canonical = "UCabcdefghijklmnopqrstuv";
  const app = harness({ channelAliases: { "@example": canonical }, installId: "install-for-test", reportingConsent: { enabled: true, updatedAt: Date.now() } }, {
    ASBChannels: { canonical: (id, aliases) => aliases[id] || id },
  });
  const response = await app.send(blockMessage(0, { scope: "channel" }));
  assert.ok(response.personal.channels[canonical]);
  assert.equal(response.personal.channels["@example"], undefined);
  await tick();
  assert.equal(app.reports[0].body.channelId, canonical);
});

test("removing a stale handle key also removes its migrated canonical block", async () => {
  const canonical = "UCabcdefghijklmnopqrstuv";
  const app = harness({
    channelAliases: { "@example": canonical },
    personal: { videos: { [videoId(0)]: {} }, channels: { [canonical]: {}, "@unrelated": {} } },
  }, { ASBChannels: { canonical: (id, aliases) => aliases[id] || id } });
  const response = await app.send({ type: "asb-remove-block", storageKey: "channels", id: "@example" });
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(app.state.personal.channels), ["@unrelated"]);
  assert.ok(app.state.personal.videos[videoId(0)]);
});

test("older malformed stored IDs remain removable", async () => {
  const app = harness({ personal: { videos: {}, channels: { "@example?view=0": {} } } });
  const response = await app.send({ type: "asb-remove-block", storageKey: "channels", id: "@example?view=0" });
  assert.equal(response.ok, true);
  assert.deepEqual(app.state.personal.channels, {});
});

test("community sync retains canonical bindings and drops them when an entry is removed", async () => {
  const canonical = "UCabcdefghijklmnopqrstuv";
  let channels = [{ id: "@old" }];
  const app = harness({
    community: { videos: [], channels: [canonical], syncedAt: 1 },
    communityChannelBindings: { "@old": canonical },
  }, {
    async fetch(url) { return { ok: true, json: async () => url.endsWith("/channels") ? channels : [] }; },
  });
  let response = await app.send({ type: "asb-sync-now" });
  assert.equal(response.ok, true);
  assert.deepEqual(app.state.community.channels, [canonical]);
  assert.equal(app.state.communityChannelBindings["@old"], canonical);
  channels = [];
  response = await app.send({ type: "asb-sync-now" });
  assert.equal(response.ok, true);
  assert.deepEqual(app.state.community.channels, []);
  assert.deepEqual(app.state.communityChannelBindings, {});
  channels = [{ id: "@old" }];
  await app.send({ type: "asb-sync-now" });
  assert.deepEqual(app.state.community.channels, ["@old"]);
});

const settingsSender = { id: 'asb-test-extension', url: 'chrome-extension://asb-test-extension/options/options.html' };
const backup = (personal = { videos: {}, channels: {} }, extra = {}) => JSON.stringify({
  format: 'ai-slop-blocker', version: 1, personal, settings: { hideYouTube: true }, ...extra,
});

test('export includes only portable data and strips action and installation identities', async () => {
  const app = harness({ installId: 'private-identity', reportingConsent: { enabled: true }, events: [{ kind: 'video' }],
    personal: { videos: { [videoId(0)]: { channelName: 'Creator', actionId: 'local-action', addedAt: 1 } }, channels: {} } });
  const result = await app.send({ type: 'asb-export' }, settingsSender);
  assert.equal(result.ok, true);
  assert.equal(result.data.personal.videos[videoId(0)].channelName, 'Creator');
  const text = JSON.stringify(result.data);
  for (const forbidden of ['private-identity', 'reportingConsent', 'events', 'local-action', 'undoBlocks']) assert.ok(!text.includes(forbidden));
  assert.equal(app.reports.length, 0);
});

test('import merges safely, retains local identity and consent, and never submits reports', async () => {
  const app = harness({ installId: 'local-identity', reportingConsent: { enabled: true, updatedAt: 1 }, blockedCount: 4,
    personal: { videos: { [videoId(0)]: { channelName: 'Keep me' } }, channels: {} } });
  const text = backup({ videos: { [videoId(0)]: { channelName: 'Overwrite' }, [videoId(1)]: { channelName: 'Imported' } }, channels: {} },
    { installId: 'foreign-identity', reportingConsent: { enabled: false }, blockedCount: 1000 });
  const results = await Promise.all([
    app.send({ type: 'asb-import', text }, settingsSender),
    app.send(blockMessage(2)),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(app.state.personal.videos[videoId(0)].channelName, 'Keep me');
  assert.equal(Object.keys(app.state.personal.videos).length, 3);
  assert.equal(app.state.installId, 'local-identity');
  assert.equal(app.state.reportingConsent.enabled, true);
  assert.equal(app.state.blockedCount, 5);
  await tick();
  assert.equal(app.reports.length, 1, 'only the new explicit block reports');
});

test('invalid and oversized imports leave all state untouched', async () => {
  for (const text of ['not-json', '{}', backup({ videos: { invalid: {} }, channels: {} }),
    backup(undefined, { settings: { hideYouTube: 'false' } }), ' '.repeat(2 * 1024 * 1024 + 1),
    backup(undefined, { version: 999 })]) {
    const app = harness({ installId: 'unchanged' });
    const response = await app.send({ type: 'asb-import', text }, settingsSender);
    assert.equal(response.ok, false);
    assert.deepEqual(app.state, { installId: 'unchanged' });
  }
});

test('content scripts cannot import, export or change settings', async () => {
  const app = harness();
  for (const type of ['asb-import', 'asb-export', 'asb-settings']) {
    const result = await app.send({ type, text: backup(), settings: { hideYouTube: false } },
      { id: settingsSender.id, url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(app.state, {});
});

test('Undo restores replaced data and preserves a later block of the same video', async () => {
  const app = harness({ personal: { videos: { [videoId(0)]: { channelName: 'Original' } }, channels: {} } });
  const first = await app.send(blockMessage(0));
  const second = await app.send(blockMessage(0, { info: { ...blockMessage(0).info, channelName: 'Latest' } }));
  assert.equal((await app.send({ type: 'asb-undo', token: first.undoToken })).ok, true);
  assert.equal(app.state.personal.videos[videoId(0)].channelName, 'Latest');
  assert.equal(app.state.blockedCount, 1);
  assert.equal((await app.send({ type: 'asb-undo', token: second.undoToken })).ok, true);
  assert.equal(app.state.blockedCount, 0);
  assert.equal(app.state.personal.videos[videoId(0)].channelName, 'Original');
  assert.equal(app.state.events.length, 0);
  assert.equal((await app.send({ type: 'asb-undo', token: second.undoToken })).ok, false);
});

test('Undo does not resurrect a block that was removed after the action', async () => {
  const app = harness();
  const first = await app.send(blockMessage(0));
  await app.send({ type: 'asb-remove-block', storageKey: 'videos', id: videoId(0) });
  await app.send({ type: 'asb-undo', token: first.undoToken });
  assert.equal(app.state.personal.videos[videoId(0)], undefined);
});

test('channel removal preserves a video independently blocked before or after the channel action', async () => {
  const app = harness();
  await app.send(blockMessage(0));
  await app.send(blockMessage(0, { scope: 'channel' }));
  await app.send({ type: 'asb-remove-block', storageKey: 'channels', id: '@example' });
  assert.ok(app.state.personal.videos[videoId(0)]);
  await app.send(blockMessage(1, { scope: 'channel' }));
  await app.send(blockMessage(1));
  await app.send({ type: 'asb-remove-block', storageKey: 'channels', id: '@example' });
  assert.ok(app.state.personal.videos[videoId(1)]);
});

test('always allow removes the corresponding personal block and explicit blocking clears that exception', async () => {
  const app = harness();
  await app.send(blockMessage(0, { scope: 'channel' }));
  assert.equal((await app.send({ type: 'asb-allow', kind: 'channels', id: '@example', allowed: true })).ok, true);
  assert.equal(app.state.personal.channels['@example'], undefined);
  assert.equal(app.state.personal.videos[videoId(0)], undefined);
  assert.ok(app.state.allowlist.channels['@example']);
  await app.send(blockMessage(1));
  assert.equal(app.state.allowlist.channels['@example'], undefined);
});

test('failed community sync preserves cache and records a readable error, next success clears it', async () => {
  let failed = true;
  const original = { videos: [videoId(0)], channels: [], syncedAt: 123 };
  const app = harness({ community: original }, { async fetch() {
    return { ok: !failed, status: 503, json: async () => [] };
  } });
  assert.equal((await app.send({ type: 'asb-sync-now' })).ok, false);
  assert.deepEqual(app.state.community, original);
  assert.ok(app.state.communitySync.error);
  failed = false;
  assert.equal((await app.send({ type: 'asb-sync-now' })).ok, true);
  assert.equal(app.state.communitySync.error, null);
  assert.deepEqual(app.state.community.videos, []);
});

test('malformed community data cannot overwrite a valid cache', async () => {
  const app = harness({ community: { videos: [videoId(0)], channels: [], syncedAt: 1 } }, {
    async fetch() { return { ok: true, json: async () => [{ id: 'bad-id' }] }; },
  });
  assert.equal((await app.send({ type: 'asb-sync-now' })).ok, false);
  assert.deepEqual(app.state.community.videos, [videoId(0)]);
});

test('Undo restores an exception displaced by explicit blocking', async () => {
  const app = harness({ allowlist: { videos: { [videoId(0)]: { name: 'Allowed before' } }, channels: {} } });
  const blocked = await app.send(blockMessage(0));
  assert.equal(app.state.allowlist.videos[videoId(0)], undefined);
  await app.send({ type: 'asb-undo', token: blocked.undoToken });
  assert.equal(app.state.allowlist.videos[videoId(0)].name, 'Allowed before');
});

test('Undo and channel removal keep working after a handle becomes a canonical channel ID', async () => {
  for (const operation of ['undo', 'remove']) {
    const app = harness();
    const blocked = await app.send(blockMessage(0, { scope: 'channel' }));
    const canonical = 'UCabcdefghijklmnopqrstuv';
    app.state.channelAliases = { '@example': canonical };
    app.state.personal.channels[canonical] = app.state.personal.channels['@example'];
    delete app.state.personal.channels['@example'];
    const result = await app.send(operation === 'undo' ? { type: 'asb-undo', token: blocked.undoToken }
      : { type: 'asb-remove-block', storageKey: 'channels', id: canonical });
    assert.equal(result.ok, true);
    assert.deepEqual(app.state.personal, { videos: {}, channels: {} });
  }
});

test('Undo cannot restore a broad exception over a newer explicit block', async () => {
  const app = harness({ allowlist: { videos: {}, channels: { '@example': { name: 'Allowed' } } } });
  const first = await app.send(blockMessage(0));
  await app.send(blockMessage(1));
  await app.send({ type: 'asb-undo', token: first.undoToken });
  assert.ok(app.state.personal.videos[videoId(1)]);
  assert.equal(app.state.allowlist.channels['@example'], undefined);
});
