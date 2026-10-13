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
    chrome, console, setTimeout, crypto,
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
  const app = harness({ installId: "install-for-test" });
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

test("channel blocking still adds the current video and channel removal leaves it blocked", async () => {
  const app = harness();
  const response = await app.send(blockMessage(0, { scope: "channel" }));
  assert.equal(response.ok, true);
  assert.equal(response.personal.channels["@example"].name, "Example");
  assert.equal(response.personal.videos[videoId(0)].channelName, "Example");
  assert.equal(response.events.length, 1);
  await app.send({ type: "asb-remove-block", storageKey: "channels", id: "@example" });
  assert.deepEqual(app.state.personal.channels, {});
  assert.ok(app.state.personal.videos[videoId(0)]);
  assert.equal(app.state.blockedCount, 1);
});

test("failed writes report failure and the queue continues with the next request", async () => {
  const app = harness();
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
  const app = harness({ channelAliases: { "@example": canonical } }, {
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
