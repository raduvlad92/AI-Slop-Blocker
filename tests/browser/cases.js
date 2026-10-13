(async () => {
  const files = ["background.js", "content/channel-identity.js", "content/common.js", "content/youtube.js", "content/google.js", "content/youtube.css"];
  const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await (await fetch(`/extension/${file}`)).text()])));
  const background = sources["background.js"].replace(/^import \{[\s\S]*?\} from "\.\/config\.js";\n/m, "").replace(/^import "[^\"]+";\n/gm, "");
  const clone = (value) => structuredClone(value);
  const wait = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const video = "AAAAAAAAAAA", other = "BBBBBBBBBBB", channel = "UCabcdefghijklmnopqrstuv";
  const defaults = { settings: { hideAIOverview: true, hideYouTube: true, showCardButtons: true, watchAction: "overlay" }, personal: { videos: {}, channels: {} }, channelAliases: {}, community: { videos: [], channels: [], syncedAt: 0 }, blockedCount: 0, events: [], installId: "test-install", reportingConsent: { enabled: true, updatedAt: 1 } };

  function environment(initial) {
    const state = { ...clone(defaults), ...clone(initial) };
    const changes = [], errors = [], reports = [], lookups = [];
    let handler;
    const event = { addListener() {} };
    const chrome = {
      runtime: { id: "browser-test", getURL: (path) => `chrome-extension://browser-test/${path}`, onInstalled: event, onStartup: event, onMessage: { addListener: (callback) => { handler = callback; } } },
      storage: { local: {
        onChanged: { addListener: (callback) => changes.push(callback) },
        async get(keys) {
          const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          return clone(Object.fromEntries(names.map((key) => [key, key in state ? state[key] : keys[key]])));
        },
        async set(update) {
          const changed = {};
          for (const [key, value] of Object.entries(update)) {
            if (JSON.stringify(value) === JSON.stringify(state[key])) continue;
            changed[key] = { oldValue: clone(state[key]), newValue: clone(value) };
            state[key] = clone(value);
          }
          if (Object.keys(changed).length) queueMicrotask(() => changes.forEach((callback) => callback(changed)));
        },
      } },
      alarms: { create() {}, onAlarm: event },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    };
    chrome.runtime.sendMessage = (message) => new Promise((resolve, reject) => {
      try { if (!handler(message, { id: chrome.runtime.id }, resolve)) resolve(undefined); }
      catch (error) { reject(error); }
    });
    const network = async (url, options) => {
      if (url.endsWith("/submit")) {
        reports.push(JSON.parse(options.body));
        return new Response("{}", { status: 200 });
      }
      lookups.push(url);
      const html = initial.lookupPages?.[url];
      return new Response(html || "Not found", { status: html ? 200 : 404 });
    };
    new Function("chrome", "fetch", "BACKEND_URL", "BLOCKLIST_VIDEOS_URL", "BLOCKLIST_CHANNELS_URL", "SYNC_INTERVAL_MINUTES", background)(chrome, network, "https://example.invalid", "https://example.invalid/videos", "https://example.invalid/channels", 360);
    return { chrome, state, errors, reports, lookups, changes };
  }

  async function fixture(path, html, initial = {}, script = "youtube") {
    const env = environment(initial);
    const frame = document.createElement("iframe");
    frame.src = "/fixture";
    const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    document.getElementById("fixtures").appendChild(frame);
    await loaded;
    const win = frame.contentWindow, doc = win.document;
    win.history.replaceState({}, "", path);
    win.chrome = env.chrome;
    win.addEventListener("error", (event) => env.errors.push(event.message));
    win.addEventListener("unhandledrejection", (event) => env.errors.push(String(event.reason)));
    doc.body.innerHTML = html;
    let pauses = 0;
    win.HTMLMediaElement.prototype.pause = function () { pauses++; };
    const style = doc.createElement("style");
    style.textContent = sources["content/youtube.css"];
    doc.head.appendChild(style);
    for (const file of ["content/channel-identity.js", "content/common.js", `content/${script}.js`]) {
      const tag = doc.createElement("script");
      tag.textContent = sources[file];
      doc.head.appendChild(tag);
    }
    await wait();
    return { ...env, win, doc, pauses: () => pauses, dispose: () => frame.remove() };
  }

  const card = (id = video, owner = "@example") => `<ytd-video-renderer id="card"><ytd-thumbnail><a href="/watch?v=${id}"><img></a></ytd-thumbnail><ytd-channel-name><a href="/${owner.startsWith("UC") ? "channel/" : ""}${owner}">Example</a></ytd-channel-name></ytd-video-renderer>`;
  const player = '<div id="movie_player" style="position:relative;width:640px;height:200px"><video class="html5-main-video"></video></div>';
  const watch = (owner = "@example") => `<ytd-watch-metadata><div id="owner"><ytd-channel-name><a href="/${owner.startsWith("UC") ? "channel/" : ""}${owner}">Example</a></ytd-channel-name></div></ytd-watch-metadata>`;
  const short = (id = video, owner = "@example", active = true) => `<ytd-reel-video-renderer video-id="${id}" ${active ? "is-active" : ""}>${player}<ytd-reel-player-header-renderer><a href="/${owner.startsWith("UC") ? "channel/" : ""}${owner}">Example</a></ytd-reel-player-header-renderer></ytd-reel-video-renderer>`;
  const tests = [
    ["Thumbnail video action saves exactly once and closes its menu", async () => {
      const f = await fixture("/results", card());
      try {
        f.doc.querySelector(".asb-btn").click();
        const button = f.doc.querySelector(".asb-menu button");
        assert(button, "menu not present"); button.click(); await wait();
        assert(f.state.personal.videos[video], "video not saved");
        assert(f.state.blockedCount === 1 && f.state.events.length === 1 && f.reports.length === 1, "block/event/report duplicated or missing");
        assert(f.doc.querySelector("#card").classList.contains("asb-hidden"), "card visible after block");
        assert(!f.doc.querySelector(".asb-menu"), "menu stayed open");
      } finally { f.dispose(); }
    }],
    ["Thumbnail channel action sweeps matching cards", async () => {
      const f = await fixture("/results", card() + card(other).replace('id="card"', 'id="other"'));
      try {
        f.doc.querySelector(".asb-btn").click(); f.doc.querySelectorAll(".asb-menu button")[1].click(); await wait();
        assert(f.state.personal.channels["@example"], "channel not saved");
        assert(f.doc.querySelectorAll(".asb-hidden").length === 2, "channel sweep missed a card");
      } finally { f.dispose(); }
    }],
    ["Blocked watch overlay retries delayed and replaced players", async () => {
      const f = await fixture(`/watch?v=${video}`, watch(), { personal: { videos: { [video]: {} }, channels: {} } });
      try {
        f.doc.body.insertAdjacentHTML("afterbegin", player); await wait();
        assert(f.doc.querySelector(".asb-player-overlay"), "late overlay missing");
        f.doc.querySelector("#movie_player").outerHTML = player; await wait();
        assert(f.doc.querySelector("#movie_player .asb-player-overlay"), "replacement overlay missing");
        const before = f.pauses(); f.doc.querySelector("video").dispatchEvent(new f.win.Event("play"));
        assert(f.pauses() > before, "blocked play not paused");
        assert(f.errors.length === 0, f.errors.join("; "));
      } finally { f.dispose(); }
    }],
    ["Recycled hrefs restore cards and replaced thumbnails regain buttons", async () => {
      const f = await fixture("/results", card(), { personal: { videos: { [video]: {} }, channels: {} } });
      try {
        f.doc.querySelector('a[href*="watch"]').setAttribute("href", `/watch?v=${other}`); await wait();
        assert(!f.doc.querySelector("#card").classList.contains("asb-hidden"), "recycled card still hidden");
        f.doc.querySelector("ytd-thumbnail").outerHTML = `<ytd-thumbnail><a href="/watch?v=${other}"><img></a></ytd-thumbnail>`; await wait();
        assert(f.doc.querySelectorAll(".asb-btn").length === 1, "button not restored or duplicated");
      } finally { f.dispose(); }
    }],
    ["Canonical blocks hide handle cards and handle blocks hide canonical cards", async () => {
      for (const reverse of [false, true]) {
        const f = await fixture("/results", card(video, reverse ? channel : "@EXAMPLE/videos?view=0"), {
          personal: { videos: {}, channels: { [reverse ? "@example" : channel]: {} } },
          channelAliases: { "@example": { id: channel, resolvedAt: Date.now() }, [channel]: { id: channel, resolvedAt: Date.now() } },
        });
        try { assert(f.doc.querySelector("#card").classList.contains("asb-hidden"), "alias block missed"); }
        finally { f.dispose(); }
      }
    }],
    ["Blocked channel identity is resolved and legacy handle storage migrates", async () => {
      const f = await fixture("/results", card(video, channel), {
        personal: { videos: {}, channels: { "@example": { name: "Example" } } },
        lookupPages: { "https://www.youtube.com/@example": `<meta itemprop="channelId" content="${channel}"><link rel="canonical" href="https://www.youtube.com/@example">` },
      });
      try {
        assert(f.state.personal.channels[channel] && !f.state.personal.channels["@example"], "legacy block not migrated");
        assert(f.doc.querySelector("#card").classList.contains("asb-hidden"), "resolved card visible");
        assert(f.lookups.length === 1, "lookup repeated");
      } finally { f.dispose(); }
    }],
    ["Direct Shorts are blocked, guarded and have block controls", async () => {
      const f = await fixture(`/shorts/${video}`, short(), { personal: { videos: { [video]: {} }, channels: {} } });
      try {
        assert(f.doc.querySelector(".asb-player-overlay"), "Shorts overlay missing");
        assert(f.doc.querySelector(".asb-watch-toggle"), "Shorts block button missing");
        const before = f.pauses(); f.doc.querySelector("video").dispatchEvent(new f.win.Event("play"));
        assert(f.pauses() > before, "Shorts playback not guarded");
        assert(f.errors.length === 0, f.errors.join("; "));
      } finally { f.dispose(); }
    }],
    ["Shorts channel action persists and active-video navigation clears overlay", async () => {
      const f = await fixture(`/shorts/${video}`, short() + short(other, "@different", false));
      try {
        f.doc.querySelector(".asb-watch-toggle").click(); f.doc.querySelectorAll(".asb-mini")[1].click(); await wait();
        assert(f.state.personal.channels["@example"] && f.state.personal.videos[video], "Shorts block missing");
        const renderers = f.doc.querySelectorAll("ytd-reel-video-renderer");
        renderers[0].removeAttribute("is-active"); renderers[1].setAttribute("is-active", "");
        f.win.history.replaceState({}, "", `/shorts/${other}`); f.win.dispatchEvent(new f.win.Event("yt-navigate-finish")); await wait();
        assert(!f.doc.querySelector(".asb-player-overlay"), "old overlay remains after Shorts navigation");
        assert(renderers[1].querySelector(".asb-watch-toggle"), "new Short has no button");
      } finally { f.dispose(); }
    }],
    ["Shorts next preference triggers its down-navigation control", async () => {
      const f = await fixture(`/shorts/${video}`, short() + '<div id="navigation-button-down"><button>Next</button></div>', { personal: { videos: { [video]: {} }, channels: {} }, settings: { ...defaults.settings, watchAction: "next" } });
      try {
        // The first enforcement occurs during setup; keep it waiting until the
        // control arrives so this listener can observe the actual click.
        await f.chrome.storage.local.set({ settings: { ...defaults.settings, watchAction: "overlay" } }); await wait();
        let clicks = 0; f.doc.querySelector("#navigation-button-down button").addEventListener("click", () => clicks++);
        await f.chrome.storage.local.set({ settings: { ...defaults.settings, watchAction: "next" } }); await wait();
        assert(clicks === 1, "next action did not fire exactly once after setting change");
      } finally { f.dispose(); }
    }],
    ["Shorts transitions use the URL's renderer and do not pause the new unblocked video", async () => {
      const f = await fixture(`/shorts/${video}`, short() + short(other, "@different", false), { personal: { videos: {}, channels: { "@example": {} } } });
      try {
        assert(f.doc.querySelector(".asb-player-overlay"), "initial channel was not blocked");
        // The URL can update before YouTube changes the active attribute or
        // emits navigate-finish. The old renderer must not lend its identity.
        f.win.history.replaceState({}, "", `/shorts/${other}`);
        const nextVideo = f.doc.querySelectorAll("video")[1];
        const before = f.pauses(); nextVideo.dispatchEvent(new f.win.Event("play"));
        assert(f.pauses() === before, "new unblocked Short paused by old identity");
        f.doc.querySelectorAll("ytd-reel-video-renderer")[1].setAttribute("active", ""); await wait();
        assert(!f.doc.querySelector(".asb-player-overlay"), "new unblocked Short incorrectly overlaid");
      } finally { f.dispose(); }
    }],
    ["Concurrent tabs and Google events retain every block and event", async () => {
      const f = await fixture("/results", card());
      try {
        const messages = Array.from({ length: 10 }, (_, i) => f.chrome.runtime.sendMessage({ type: "asb-block", scope: "video", info: { videoId: `v${String(i).padStart(10, "0")}`, channelId: null }, mins: 8 }));
        await Promise.all([...messages, ...Array.from({ length: 10 }, () => f.chrome.runtime.sendMessage({ type: "asb-log-event", kind: "overview" }))]);
        assert(Object.keys(f.state.personal.videos).length === 10, "concurrent blocks lost");
        assert(f.state.blockedCount === 10 && f.state.events.length === 20, "concurrent counters/events lost");
      } finally { f.dispose(); }
    }],
    ["Google hides only the nested answer and restores mixed/recycled modules", async () => {
      const f = await fixture("/search?q=test", '<div id="rso"><section id="mixed" data-mcpr><section id="overview"><h2>AI Overview</h2><p>Answer</p></section><article id="organic"><a href="https://example.com"><h3>Ordinary result</h3></a></article></section><div data-mcpr id="ordinary">Unrelated module</div></div>', {}, "google");
      try {
        const box = f.doc.getElementById("overview");
        assert(getComputedStyle(box).display === "none", "answer not hidden");
        assert(f.doc.getElementById("organic").getClientRects().length > 0, "organic result hidden");
        assert(f.doc.getElementById("ordinary").getClientRects().length > 0, "unlabelled module hidden");
        box.insertAdjacentHTML("beforeend", '<a href="https://example.com"><h3>New ordinary result</h3></a>'); await wait();
        assert(getComputedStyle(box).display !== "none", "mixed module was not restored");
        box.innerHTML = '<h2>AI Overview</h2><p>Answer</p>'; await wait();
        assert(getComputedStyle(box).display === "none", "reused overview not hidden");
        await f.chrome.storage.local.set({ settings: { ...defaults.settings, hideAIOverview: false } }); await wait();
        assert(getComputedStyle(box).display !== "none", "toggle did not restore overview");
      } finally { f.dispose(); }
    }],
  ];

  window.browserResults = [];
  for (const [name, run] of tests) {
    const row = document.createElement("li");
    document.getElementById("results").appendChild(row);
    try { await run(); browserResults.push({ name, passed: true }); row.textContent = `PASS: ${name}`; row.className = "pass"; }
    catch (error) { browserResults.push({ name, passed: false, error: String(error) }); row.textContent = `FAIL: ${name}: ${error}`; row.className = "fail"; }
  }
  window.browserDone = true;
  const passed = browserResults.filter((result) => result.passed).length;
  document.getElementById("summary").textContent = `${passed}/${tests.length} checks passed`;
})();
