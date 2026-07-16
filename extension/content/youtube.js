// YouTube: inject a "🤖 AI Slop" button on video cards, hide blocked videos.
//
// Handles home feed, search results, watch-page sidebar, channel pages and
// Shorts shelves. YouTube is an SPA — we re-run on `yt-navigate-finish` and
// on DOM mutations (debounced), never just on page load.

(() => {
  "use strict";

  // Video card elements across YouTube surfaces. New "lockup view model"
  // elements are YouTube's 2024+ markup; ytd-* renderers are the legacy ones
  // still used on many surfaces.
  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",       // home feed / channel videos
    "ytd-video-renderer",           // search results
    "ytd-compact-video-renderer",   // watch sidebar (legacy)
    "ytd-grid-video-renderer",      // channel grids (legacy)
    "ytd-playlist-video-renderer",  // playlist entries
    "ytd-reel-item-renderer",       // shorts shelf (legacy)
    "yt-lockup-view-model",         // new-style cards (watch sidebar etc.)
    "ytm-shorts-lockup-view-model", // new-style shorts
  ].join(",");

  const state = {
    enabled: true,
    showCardButtons: false,
    watchAction: "overlay",
    blockedCount: 0,
    personalVideos: new Set(),
    personalChannels: new Set(),
    communityVideos: new Set(),
    communityChannels: new Set(),
  };

  function refreshSets(data) {
    state.enabled = data.settings.hideYouTube;
    state.showCardButtons = !!data.settings.showCardButtons;
    state.watchAction = data.settings.watchAction || "overlay";
    state.blockedCount = data.blockedCount;
    state.personalVideos = new Set(Object.keys(data.personal.videos));
    state.personalChannels = new Set(Object.keys(data.personal.channels));
    state.communityVideos = new Set(data.community.videos);
    state.communityChannels = new Set(data.community.channels);
  }

  // -------------------------------------------------------------------------
  // Card introspection
  // -------------------------------------------------------------------------

  // NOTE: no caching here — YouTube recycles card elements across SPA
  // navigations (same DOM node, new hrefs), so info must be re-extracted
  // every time, especially at click time.
  function extractInfo(card) {
    const info = { videoId: null, channelId: null, channelName: null };

    const link = card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (link) {
      try {
        const url = new URL(link.getAttribute("href"), location.origin);
        if (url.pathname === "/watch") {
          info.videoId = url.searchParams.get("v");
        } else if (url.pathname.startsWith("/shorts/")) {
          info.videoId = url.pathname.split("/")[2] || null;
        }
      } catch { /* malformed href — leave null */ }
    }

    // channelId is a UC… id when the card links /channel/, otherwise the
    // @handle. The blocklists store whichever form we saw — both are stable.
    const chLink = card.querySelector('a[href^="/channel/"], a[href^="/@"]');
    if (chLink) {
      const path = chLink.getAttribute("href") || "";
      if (path.startsWith("/channel/")) info.channelId = path.split("/")[2] || null;
      else if (path.startsWith("/@")) info.channelId = path.split("/")[1] || null;
    }

    const nameEl = card.querySelector(
      "ytd-channel-name a, ytd-channel-name #text, #channel-name a, " +
      ".yt-lockup-metadata-view-model-wiz__metadata a"
    );
    if (nameEl) info.channelName = nameEl.textContent.trim().slice(0, 100) || null;
    if (!info.channelName && info.channelId?.startsWith("@")) {
      info.channelName = info.channelId;
    }
    return info;
  }

  // The main video on a watch page isn't a card — its identity comes from the
  // URL and the owner row under the player.
  function watchPageInfo() {
    const info = { videoId: null, channelId: null, channelName: null };
    info.videoId = new URLSearchParams(location.search).get("v");

    const chLink = document.querySelector(
      'ytd-watch-metadata #owner a[href^="/channel/"], ytd-watch-metadata #owner a[href^="/@"]'
    );
    if (chLink) {
      const path = chLink.getAttribute("href") || "";
      if (path.startsWith("/channel/")) info.channelId = path.split("/")[2] || null;
      else if (path.startsWith("/@")) info.channelId = path.split("/")[1] || null;
    }

    const nameEl = document.querySelector("ytd-watch-metadata #owner ytd-channel-name a");
    if (nameEl) info.channelName = nameEl.textContent.trim().slice(0, 100) || null;
    if (!info.channelName && info.channelId?.startsWith("@")) {
      info.channelName = info.channelId;
    }
    return info;
  }

  function isBlocked(info) {
    return (
      (info.videoId &&
        (state.personalVideos.has(info.videoId) || state.communityVideos.has(info.videoId))) ||
      (info.channelId &&
        (state.personalChannels.has(info.channelId) || state.communityChannels.has(info.channelId)))
    );
  }

  // -------------------------------------------------------------------------
  // Overlay button + inline mini-menu
  // -------------------------------------------------------------------------

  function findThumb(card) {
    let thumb = card.querySelector("ytd-thumbnail, yt-thumbnail-view-model");
    if (!thumb) {
      const img = card.querySelector("img");
      thumb = img ? img.closest("a") : null;
    }
    return thumb;
  }

  function makeButton(className, onClick) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    btn.title = "Mark as AI slop";
    btn.textContent = "🤖 AI Slop";
    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      },
      { capture: true }
    );
    return btn;
  }

  function injectButton(card) {
    if (card.dataset.asbBtn) return;
    const thumb = findThumb(card);
    if (!thumb) return;
    card.dataset.asbBtn = "1";

    if (getComputedStyle(thumb).position === "static") {
      thumb.style.position = "relative";
    }

    // Info is extracted at click time — the card element may have been
    // recycled for a different video since injection.
    thumb.appendChild(
      makeButton("asb-btn", () => openMenu(card, thumb, extractInfo(card)))
    );
  }

  // Watch page: inline pill in the owner row (next to Subscribe). Clicking it
  // expands the pill to the right, revealing the two block actions in place —
  // no dropdown, so nothing can render below the fold.
  function injectWatchButton() {
    if (location.pathname !== "/watch") return;
    const owner = document.querySelector("ytd-watch-metadata #owner");
    if (!owner || owner.querySelector(".asb-watch")) return;

    const wrap = document.createElement("div");
    wrap.className = "asb-watch";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "asb-watch-toggle";
    toggle.title = "Mark as AI slop";
    toggle.textContent = "🤖 AI Slop";

    const actions = document.createElement("div");
    actions.className = "asb-watch-actions";

    const mkMini = (label, scope) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "asb-mini";
      b.textContent = label;
      b.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          wrap.classList.remove("asb-expanded");
          // Identity is read at click time — the owner row survives SPA
          // navigations while the video underneath it changes.
          block(scope, watchPageInfo(), null);
        },
        { capture: true }
      );
      return b;
    };
    const miniChannel = mkMini("Block Channel", "channel");
    actions.append(mkMini("Block Video", "video"), miniChannel);

    toggle.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasExpanded = wrap.classList.contains("asb-expanded");
        closeMenu();
        if (!wasExpanded) {
          // No channel link found (rare) — offer the video action only.
          miniChannel.style.display = watchPageInfo().channelId ? "" : "none";
          wrap.classList.add("asb-expanded");
        }
      },
      { capture: true }
    );

    wrap.append(toggle, actions);
    owner.appendChild(wrap);
  }

  let openMenuEl = null;
  function closeMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
    document
      .querySelectorAll(".asb-watch.asb-expanded")
      .forEach((el) => el.classList.remove("asb-expanded"));
  }
  // Outside click closes card menus and collapses the watch pill. Clicks
  // inside the pill are handled by its own listeners (toggle semantics).
  document.addEventListener(
    "click",
    (e) => {
      if (e.target instanceof Element && e.target.closest(".asb-watch")) return;
      closeMenu();
    },
    { capture: true }
  );

  function openMenu(card, container, info) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "asb-menu";

    const addItem = (label, scope) => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          block(scope, info, card);
        },
        { capture: true }
      );
      menu.appendChild(item);
    };

    if (info.videoId) addItem("Block this video", "video");
    if (info.channelId) {
      addItem(`Block channel${info.channelName ? ": " + info.channelName : ""}`, "channel");
    }
    if (!menu.children.length) return; // couldn't identify the card — do nothing

    menu.addEventListener("click", (e) => e.stopPropagation(), { capture: true });
    container.appendChild(menu);
    openMenuEl = menu;
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  async function block(scope, info, card) {
    // 1. Instant local feedback — hide before any storage/network work.
    // (card is null when blocking from the watch page — the playing video
    // isn't hidden, but it's list-blocked everywhere it appears from now on.)
    if (card) hideCard(card);

    // 2. Persist to the local block list + bump the counter.
    const data = await ASB.getState();
    const now = Date.now();
    if (info.videoId) {
      data.personal.videos[info.videoId] = { channelName: info.channelName || "", addedAt: now };
    }
    if (scope === "channel" && info.channelId) {
      data.personal.channels[info.channelId] = { name: info.channelName || "", addedAt: now };
    }
    data.blockedCount += 1;
    await chrome.storage.local.set({
      personal: data.personal,
      blockedCount: data.blockedCount,
    });
    refreshSets(data);
    processAll(); // channel blocks should sweep the rest of the page too
    ASB.logEvent("video", blockedMinutes(card)); // badge + stats, fire-and-forget

    // 3. Satisfying toast with the running counter.
    const n = data.blockedCount;
    showToast(`Blocked. You've hidden ${n} AI ${n === 1 ? "video" : "videos"} 🎉`);

    // 4. Fire-and-forget submission to the backend (relayed via background).
    try {
      chrome.runtime.sendMessage({
        type: "asb-submit",
        payload: {
          videoId: info.videoId,
          channelId: info.channelId,
          channelName: info.channelName,
          scope,
        },
      });
    } catch { /* extension reloading — local block already succeeded */ }
  }

  // Estimated length of the blocked video, for the "brain rot avoided" stat.
  // Cards carry a duration badge; on the watch page the <video> element knows.
  function blockedMinutes(card) {
    try {
      if (card) {
        const badge = card.querySelector(
          "ytd-thumbnail-overlay-time-status-renderer, badge-shape, .yt-badge-shape__text, .badge-shape-wiz__text"
        );
        const m = (badge?.textContent || "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
        if (m) {
          return Math.max(1, Math.round((+(m[1] || 0)) * 60 + +m[2] + +m[3] / 60));
        }
      } else {
        const d = document.querySelector("video.html5-main-video")?.duration;
        if (Number.isFinite(d) && d > 0) return Math.max(1, Math.round(d / 60));
      }
    } catch { /* fall through to the estimate */ }
    return 8; // ASSUMPTION: average slop video length when duration is unknown
  }

  function hideCard(card) {
    card.classList.add("asb-hidden");
  }

  function unhideAll() {
    document.querySelectorAll(".asb-hidden").forEach((el) => el.classList.remove("asb-hidden"));
  }

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------

  let toastTimer = null;
  function showToast(message) {
    if (!document.body) return; // document_start — too early to render
    let toast = document.querySelector(".asb-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "asb-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove("asb-toast-show");
    void toast.offsetWidth; // restart the pop animation on rapid blocks
    toast.classList.add("asb-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("asb-toast-show"), 2500);
  }

  // -------------------------------------------------------------------------
  // Watch-page enforcement: what happens when a blocked video is opened.
  // -------------------------------------------------------------------------

  let enforcedVideoId = null; // the chosen action has FIRED for this video
  let watchBlocked = false; // current watch video is blocked (play-guard flag)
  let overlayEl = null;

  function pauseVideo() {
    document.querySelector("video.html5-main-video")?.pause();
  }

  function enforceWatchBlock() {
    if (!state.enabled) return;
    if (location.pathname !== "/watch") {
      watchBlocked = false;
      return;
    }
    const info = watchPageInfo();
    if (!info.videoId) return;

    if (!isBlocked(info)) {
      watchBlocked = false;
      clearWatchOverlay();
      enforcedVideoId = null;
      return;
    }

    // Contain immediately, before (and independently of) the chosen action:
    // the play-guard in init() now keeps this video paused no matter how
    // often YouTube tries to start it.
    watchBlocked = true;
    pauseVideo();

    if (enforcedVideoId === info.videoId) return;

    // enforcedVideoId is only set once the action actually fires — the next
    // button / sidebar render async, so failed attempts retry on every scan
    // (with the overlay holding the fort in between) instead of giving up.
    switch (state.watchAction) {
      case "redirect":
        enforcedVideoId = info.videoId;
        // Full navigation — flag survives it so the fresh content script can
        // explain why the user landed on the homepage.
        try { sessionStorage.setItem("asb-redirected", "1"); } catch { /* blocked storage */ }
        location.href = "https://www.youtube.com/";
        break;
      case "next": {
        showWatchOverlay("Skipping to the next video…");
        // The next button is an <a>; clicking it triggers YouTube's SPA
        // router. Its href is only set once player data has loaded.
        const nextBtn = document.querySelector("a.ytp-next-button");
        if (nextBtn?.getAttribute("href")) {
          enforcedVideoId = info.videoId;
          nextBtn.click();
        } else if (playFirstSidebar()) {
          enforcedVideoId = info.videoId;
        }
        break;
      }
      case "sidebar":
        showWatchOverlay("Skipping to a recommended video…");
        if (playFirstSidebar()) enforcedVideoId = info.videoId;
        break;
      default: // "overlay"
        enforcedVideoId = info.videoId;
        showWatchOverlay();
    }
  }

  // Click the first sidebar recommendation that isn't itself blocked.
  function playFirstSidebar() {
    const cards = document.querySelectorAll(
      "#secondary ytd-compact-video-renderer, #secondary yt-lockup-view-model"
    );
    for (const card of cards) {
      if (card.classList.contains("asb-hidden")) continue;
      const link = card.querySelector('a[href*="/watch?v="]');
      if (link) {
        link.click();
        return true;
      }
    }
    return false;
  }

  function showWatchOverlay(subText) {
    pauseVideo();
    if (overlayEl?.isConnected) return;

    const player = document.querySelector("#movie_player");
    if (!player) return;

    overlayEl = document.createElement("div");
    overlayEl.className = "asb-player-overlay";
    const emoji = document.createElement("div");
    emoji.className = "asb-overlay-emoji";
    emoji.textContent = "🤖🚫";
    const title = document.createElement("div");
    title.className = "asb-overlay-title";
    title.textContent = "Blocked because of AI Slop";
    const sub = document.createElement("div");
    sub.className = "asb-overlay-sub";
    sub.textContent = subText || "This video or its channel is on your block list.";
    overlayEl.append(emoji, title, sub);
    player.appendChild(overlayEl);
  }

  function clearWatchOverlay() {
    overlayEl?.remove();
    overlayEl = null;
  }

  // -------------------------------------------------------------------------
  // Scan loop
  // -------------------------------------------------------------------------

  function processAll() {
    if (!state.enabled) return;
    try {
      document.querySelectorAll(CARD_SELECTORS).forEach((card) => {
        const info = extractInfo(card);
        if (!info.videoId && !info.channelId) return;
        if (isBlocked(info)) {
          hideCard(card);
        } else {
          card.classList.remove("asb-hidden");
          // Buttons are still injected while hidden by CSS so flipping the
          // setting on takes effect without a rescan.
          injectButton(card);
        }
      });
      injectWatchButton();
      enforceWatchBlock();
    } catch { /* never break YouTube */ }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      processAll();
    }, 150);
  }

  async function init() {
    refreshSets(await ASB.getState());
    applyEnabled();

    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    // SPA navigation: YouTube swaps content without a page load.
    window.addEventListener("yt-navigate-finish", () => {
      closeMenu();
      clearWatchOverlay();
      watchBlocked = false;
      enforcedVideoId = null;
      processAll();
    });

    // Keeps a blocked video paused the instant anything tries to play it —
    // this is what stops the "plays for a split second" flash. Media "play"
    // events don't bubble, but a capturing listener on document still fires.
    document.addEventListener(
      "play",
      (e) => {
        if (watchBlocked && e.target instanceof HTMLVideoElement) e.target.pause();
      },
      true
    );

    // Landing here from a "redirect" enforcement — explain what happened.
    // (We run at document_start now, so body may not exist yet.)
    try {
      if (sessionStorage.getItem("asb-redirected")) {
        sessionStorage.removeItem("asb-redirected");
        const notify = () => showToast("Redirected — that video was AI slop 🤖");
        if (document.body) notify();
        else document.addEventListener("DOMContentLoaded", notify, { once: true });
      }
    } catch { /* sessionStorage unavailable */ }

    processAll();

    ASB.onStateChange(async () => {
      refreshSets(await ASB.getState());
      applyEnabled();
    });
  }

  function applyEnabled() {
    document.documentElement.classList.toggle("asb-off", !state.enabled);
    document.documentElement.classList.toggle("asb-cards-off", !state.showCardButtons);
    if (state.enabled) {
      processAll();
    } else {
      unhideAll();
      clearWatchOverlay();
      watchBlocked = false;
      enforcedVideoId = null;
    }
  }

  init();
})();
