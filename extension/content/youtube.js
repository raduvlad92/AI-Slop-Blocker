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
    blockedCount: 0,
    personalVideos: new Set(),
    personalChannels: new Set(),
    communityVideos: new Set(),
    communityChannels: new Set(),
  };

  function refreshSets(data) {
    state.enabled = data.settings.hideYouTube;
    state.blockedCount = data.blockedCount;
    state.personalVideos = new Set(Object.keys(data.personal.videos));
    state.personalChannels = new Set(Object.keys(data.personal.channels));
    state.communityVideos = new Set(data.community.videos);
    state.communityChannels = new Set(data.community.channels);
  }

  // -------------------------------------------------------------------------
  // Card introspection
  // -------------------------------------------------------------------------

  function extractInfo(card) {
    // Cache on the element — cards are re-scanned on every mutation pass and
    // their links don't change.
    if (card.dataset.asbInfo) {
      try { return JSON.parse(card.dataset.asbInfo); } catch { /* re-extract */ }
    }

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

    if (info.videoId) card.dataset.asbInfo = JSON.stringify(info);
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

  function injectButton(card, info) {
    if (card.dataset.asbBtn) return;
    const thumb = findThumb(card);
    if (!thumb) return;
    card.dataset.asbBtn = "1";

    if (getComputedStyle(thumb).position === "static") {
      thumb.style.position = "relative";
    }

    const btn = document.createElement("button");
    btn.className = "asb-btn";
    btn.type = "button";
    btn.title = "Mark as AI slop";
    btn.textContent = "🤖 AI Slop";
    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(card, thumb, info);
      },
      { capture: true }
    );
    thumb.appendChild(btn);
  }

  let openMenuEl = null;
  function closeMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
  }
  document.addEventListener("click", closeMenu, { capture: true });

  function openMenu(card, thumb, info) {
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
    thumb.appendChild(menu);
    openMenuEl = menu;
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  async function block(scope, info, card) {
    // 1. Instant local feedback — hide before any storage/network work.
    hideCard(card);

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

    // 3. Satisfying toast with the running counter.
    showToast(data.blockedCount);

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
  function showToast(count) {
    let toast = document.querySelector(".asb-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "asb-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = `Blocked. You've hidden ${count} AI ${count === 1 ? "video" : "videos"} 🎉`;
    toast.classList.remove("asb-toast-show");
    void toast.offsetWidth; // restart the pop animation on rapid blocks
    toast.classList.add("asb-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("asb-toast-show"), 2500);
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
          injectButton(card, info);
        }
      });
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
      processAll();
    });
    processAll();

    ASB.onStateChange(async () => {
      refreshSets(await ASB.getState());
      applyEnabled();
    });
  }

  function applyEnabled() {
    document.documentElement.classList.toggle("asb-off", !state.enabled);
    if (state.enabled) processAll();
    else unhideAll();
  }

  init();
})();
