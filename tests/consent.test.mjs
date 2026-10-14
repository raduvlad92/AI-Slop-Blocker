import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
  .replace(/^import \{[\s\S]*?\} from "\.\/config\.js";\n/m, "")
  .replace(/^import "[^\"]+";\n/gm, "");
const identity = vm.createContext({ URL, Date });
vm.runInContext(await readFile(new URL("../extension/content/channel-identity.js", import.meta.url), "utf8"), identity);
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const INSTALL_ID = "12345678-1234-4234-8234-123456789abc";
const BLOCK = {
  type: "asb-block", scope: "video", mins: 8,
  info: { videoId: "AAAAAAAAAAA", channelId: "@creator", channelName: "Creator" },
};

function harness(initial = {}, postResponse = async () => ({ ok: true, status: 200 })) {
  const state = structuredClone(initial);
  const reports = [];
  const requests = [];
  const retries = [];
  let listener, installed, startup;
  let uuidCalls = 0, optionsOpened = 0;
  const extensionUrl = "chrome-extension://asb-test/";
  const chrome = {
    runtime: {
      id: "asb-test",
      getURL: (path) => `${extensionUrl}${path}`,
      onInstalled: { addListener(callback) { installed = callback; } },
      onStartup: { addListener(callback) { startup = callback; } },
      onMessage: { addListener(callback) { listener = callback; } },
      async openOptionsPage() { optionsOpened++; },
    },
    storage: { local: {
      onChanged: { addListener() {} },
      async get(keys) {
        if (typeof keys === "string") return structuredClone({ [keys]: state[keys] });
        if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map((key) => [key, state[key]])));
        return structuredClone(Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback])));
      },
      async set(update) { Object.assign(state, structuredClone(update)); },
    } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  };
  const startWorker = () => vm.runInNewContext(source, {
    chrome, console, Date,
    ASBChannels: identity.ASBChannels,
    crypto: { randomUUID() {
      uuidCalls++;
      return uuidCalls === 1 ? INSTALL_ID : `12345678-1234-4234-8234-${String(uuidCalls).padStart(12, "0")}`;
    } },
    setTimeout(callback) { retries.push(callback); return retries.length; },
    clearTimeout() {},
    BACKEND_URL: "https://reports.example.invalid",
    BLOCKLIST_VIDEOS_URL: "https://lists.example.invalid/videos",
    BLOCKLIST_CHANNELS_URL: "https://lists.example.invalid/channels",
    SYNC_INTERVAL_MINUTES: 360,
    async fetch(url, options) {
      requests.push({ url, method: options?.method || "GET" });
      if (options?.method === "POST") {
        reports.push({ url, credentials: options.credentials, payload: JSON.parse(options.body) });
        return postResponse(reports.length);
      }
      return { ok: true, json: async () => [] };
    },
  });
  startWorker();
  function send(message, sender = { id: "asb-test", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" }) {
    return new Promise((resolve) => {
      let replied = false;
      const keepOpen = listener(message, sender, (response) => { replied = true; resolve(structuredClone(response)); });
      if (!keepOpen && !replied) resolve(undefined);
    });
  }
  return {
    state, reports, requests, retries, send,
    setReporting: (enabled) => send({ type: "asb-set-reporting", enabled }, { id: "asb-test", url: `${extensionUrl}options/options.html` }),
    install: (reason) => installed({ reason }),
    startup: () => startup(),
    restartWorker: startWorker,
    uuidCalls: () => uuidCalls,
    optionsOpened: () => optionsOpened,
  };
}

test("fresh install creates only a local UUID, starts reporting off, and presents the optional choice", async () => {
  const app = harness();
  await app.install("install");
  await flush();
  assert.equal(app.state.reportingConsent.enabled, false);
  assert.equal(app.state.installId, INSTALL_ID);
  assert.equal(app.uuidCalls(), 1);
  assert.equal(app.reports.length, 0);
  assert.ok(app.requests.every((request) => request.url.startsWith("https://lists.example.invalid/")));
  assert.equal(app.optionsOpened(), 1);
});

test("updates preserve valid existing UUIDs and reporting choices", async () => {
  for (const id of [INSTALL_ID, "ABCDEFAB-ABCD-ABCD-ABCD-ABCDEFABCDEF"]) {
    const consent = { enabled: true, updatedAt: 1 };
    const app = harness({ installId: id, reportingConsent: consent, settings: { hideYouTube: false } });
    await app.install("update");
    await flush();
    assert.equal(app.state.installId, id);
    assert.equal(app.uuidCalls(), 0);
    assert.deepEqual(app.state.reportingConsent, consent);
    assert.equal(app.state.settings.hideYouTube, false);
    assert.equal(app.reports.length, 0);
    assert.equal(app.optionsOpened(), 0);
  }
});

test("updates repair missing or invalid legacy UUIDs locally without enabling reports", async () => {
  for (const id of [undefined, null, "", "not-a-uuid", 42, {}]) {
    const app = harness({ ...(id !== undefined ? { installId: id } : {}) });
    await app.install("update");
    await flush();
    assert.equal(app.state.installId, INSTALL_ID);
    assert.equal(app.uuidCalls(), 1);
    assert.equal(app.state.reportingConsent.enabled, false);
    assert.equal(app.reports.length, 0);
    assert.ok(app.requests.every((request) => request.url.startsWith("https://lists.example.invalid/")));
  }
});

test("the local UUID survives worker restarts, browser startup, consent toggles and opt-out", async () => {
  const app = harness();
  await app.install("install");
  await flush();
  const id = app.state.installId;
  app.restartWorker();
  await app.startup();
  await app.setReporting(true);
  await app.setReporting(false);
  await app.setReporting(true);
  await app.setReporting(false);
  await app.send(BLOCK);
  await flush();
  assert.equal(app.state.installId, id);
  assert.equal(app.uuidCalls(), 1);
  assert.equal(app.state.reportingConsent.enabled, false);
  assert.ok(app.state.personal.videos.AAAAAAAAAAA);
  assert.equal(app.reports.length, 0);
});

test("initialization and opt-in share one queue and create only one UUID", async () => {
  for (const consentFirst of [false, true]) {
    const app = harness();
    const operations = consentFirst
      ? [app.setReporting(true), app.install("install"), app.install("update")]
      : [app.install("install"), app.install("update"), app.setReporting(true)];
    await Promise.all(operations);
    await flush();
    assert.equal(app.state.installId, INSTALL_ID);
    assert.equal(app.uuidCalls(), 1);
    assert.equal(app.state.reportingConsent.enabled, true);
    assert.equal(app.reports.length, 0);
  }
});

test("initialization and a simultaneous local block preserve both the UUID and block", async () => {
  for (const initializationFirst of [false, true]) {
    const app = harness();
    await Promise.all(initializationFirst
      ? [app.install("install"), app.send(BLOCK)]
      : [app.send(BLOCK), app.install("update")]);
    await flush();
    assert.equal(app.state.installId, INSTALL_ID);
    assert.equal(app.uuidCalls(), 1);
    assert.ok(app.state.personal.videos.AAAAAAAAAAA);
    assert.equal(app.state.blockedCount, 1);
    assert.equal(app.state.events.length, 1);
    assert.equal(app.state.reportingConsent.enabled, false);
    assert.equal(app.reports.length, 0);
  }
});

test("a reporting choice repairs older missing or invalid UUIDs without rotating valid IDs", async () => {
  for (const enabled of [false, true]) {
    for (const oldId of [undefined, "invalid"]) {
      const app = harness({ ...(oldId ? { installId: oldId } : {}) });
      assert.equal((await app.setReporting(enabled)).ok, true);
      assert.equal(app.state.installId, INSTALL_ID);
      assert.equal(app.uuidCalls(), 1);
      assert.equal(app.state.reportingConsent.enabled, enabled);
      await app.setReporting(!enabled);
      assert.equal(app.state.installId, INSTALL_ID);
      assert.equal(app.uuidCalls(), 1);
      assert.equal(app.reports.length, 0);
    }
  }
});

test("existing installs with missing consent remain local-only despite an old identifier", async () => {
  const app = harness({ installId: INSTALL_ID, settings: { shareReports: true } });
  await app.install("update");
  await app.send(BLOCK);
  await flush();
  assert.equal(app.state.reportingConsent.enabled, false);
  assert.ok(app.state.personal.videos.AAAAAAAAAAA);
  assert.equal(app.state.blockedCount, 1);
  assert.equal(app.reports.length, 0);
  assert.equal(app.optionsOpened(), 0);
  assert.equal(app.uuidCalls(), 0);
});

test("missing, disabled, and non-boolean consent never report blocks", async () => {
  for (const consent of [undefined, { enabled: false }, { enabled: "true" }]) {
    const app = harness({ installId: INSTALL_ID, ...(consent ? { reportingConsent: consent } : {}) });
    await app.send(BLOCK);
    await flush();
    assert.equal(app.reports.length, 0);
    assert.equal(app.uuidCalls(), 0);
    assert.equal(app.state.events.length, 1);
  }
});

test("affirmative opt-in shares only the disclosed payload with the existing local identifier", async () => {
  const app = harness();
  await app.install("install");
  await flush();
  assert.equal((await app.setReporting(true)).ok, true);
  assert.equal(app.uuidCalls(), 1);
  await app.send({ ...BLOCK, scope: "channel" });
  await flush();
  assert.equal(app.reports.length, 1);
  assert.deepEqual(app.reports[0].payload, { ...BLOCK.info, scope: "channel", installId: INSTALL_ID });
  assert.equal(app.reports[0].credentials, "omit");
  assert.ok(app.state.personal.videos.AAAAAAAAAAA);
  assert.ok(app.state.personal.channels["@creator"]);
});

test("an ignored HTTP 200 report does not change successful local blocking", async () => {
  const app = harness({}, async () => ({ ok: true, status: 200, json: async () => ({ ok: true, accepted: false }) }));
  await app.install("install");
  await app.setReporting(true);
  const result = await app.send(BLOCK);
  await flush();
  assert.equal(result.ok, true);
  assert.ok(app.state.personal.videos.AAAAAAAAAAA);
  assert.equal(app.state.blockedCount, 1);
  assert.equal(app.state.events.length, 1);
  assert.equal(app.reports.length, 1);
  assert.deepEqual(app.reports[0].payload, { ...BLOCK.info, scope: "video", installId: INSTALL_ID });
  assert.equal(app.retries.length, 0);
});

test("opting in does not send blocks saved before that choice", async () => {
  const app = harness();
  await Promise.all([app.send(BLOCK), app.setReporting(true)]);
  await flush();
  assert.equal(app.reports.length, 0);
  await app.send({ ...BLOCK, info: { ...BLOCK.info, videoId: "BBBBBBBBBBB" } });
  await flush();
  assert.equal(app.reports.length, 1);
  assert.equal(app.reports[0].payload.videoId, "BBBBBBBBBBB");
});

test("turning reporting off prevents new reports and keeps local blocking", async () => {
  const app = harness();
  await app.setReporting(true);
  await app.setReporting(false);
  await app.send(BLOCK);
  await flush();
  assert.equal(app.reports.length, 0);
  assert.equal(app.state.blockedCount, 1);
  assert.equal(app.state.reportingConsent.enabled, false);
  assert.equal(app.uuidCalls(), 1);
});

test("turning sharing off cancels pending retries", async () => {
  const app = harness({}, async () => ({ ok: false, status: 503 }));
  await app.setReporting(true);
  await app.send(BLOCK);
  await flush();
  assert.equal(app.reports.length, 1);
  assert.equal(app.retries.length, 1);
  await app.setReporting(false);
  app.retries.shift()();
  await flush();
  assert.equal(app.reports.length, 1);
  assert.equal(app.retries.length, 0);
});

test("content scripts and other origins cannot enable sharing", async () => {
  const app = harness();
  for (const sender of [
    { id: "asb-test", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA" },
    { id: "asb-test", url: "chrome-extension://another/options/options.html" },
    { id: "asb-test" },
    { id: "another", url: "chrome-extension://asb-test/options/options.html" },
  ]) {
    const response = await app.send({ type: "asb-set-reporting", enabled: true }, sender);
    assert.notEqual(response?.ok, true);
  }
  assert.equal(app.state.reportingConsent, undefined);
  assert.equal(app.uuidCalls(), 0);
  assert.equal((await app.setReporting("true")).ok, false);
});

test("legacy submission relay validates payload and also requires consent", async () => {
  const app = harness({ installId: INSTALL_ID });
  const payload = { ...BLOCK.info, scope: "video", installId: "caller-cannot-choose", extra: "not-disclosed" };
  assert.equal((await app.send({ type: "asb-submit", payload })).ok, true);
  await flush();
  assert.equal(app.reports.length, 0);
  await app.setReporting(true);
  assert.equal((await app.send({ type: "asb-submit", payload: { ...payload, scope: "invalid" } })).ok, false);
  assert.equal((await app.send({ type: "asb-submit", payload })).ok, true);
  await flush();
  assert.equal(app.reports.length, 1);
  assert.deepEqual(app.reports[0].payload, { ...BLOCK.info, scope: "video", installId: INSTALL_ID });
});

test("settings-only changes cannot grant or reset reporting consent", async () => {
  const app = harness();
  await app.send(BLOCK);
  app.state.settings = { hideYouTube: true, shareReports: true };
  await app.send(BLOCK);
  await flush();
  assert.equal(app.reports.length, 0);
  await app.setReporting(true);
  app.state.settings = { hideYouTube: false, shareReports: false };
  assert.equal(app.state.reportingConsent.enabled, true);
  assert.equal(app.uuidCalls(), 1);
});
