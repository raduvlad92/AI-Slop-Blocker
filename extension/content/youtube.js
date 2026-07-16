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
    blockedCount: 0,
    personalVideos: new Set(),
    personalChannels: new Set(),
    communityVideos: new Set(),
    communityChannels: new Set(),
  };

  function refreshSets(data) {
    state.enabled = data.settings.hideYouTube;
    state.showCardButtons = !!data.settings.showCardButtons;
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

  // Watch page: inline button in the owner row (next to Subscribe) so the
  // currently playing video/channel can be blocked too.
  function injectWatchButton() {
    if (location.pathname !== "/watch") return;
    const owner = document.querySelector("ytd-watch-metadata #owner");
    if (!owner || owner.querySelector(".asb-btn-watch")) return;

    if (getComputedStyle(owner).position === "static") {
      owner.style.position = "relative";
    }
    owner.appendChild(
      makeButton("asb-btn-watch", () => openMenu(null, owner, watchPageInfo(), true))
    );
  }

  let openMenuEl = null;
  function closeMenu() {
    openMenuEl?.remove();
    openMenuEl = null;
  }
  document.addEventListener("click", closeMenu, { capture: true });

  function openMenu(card, container, info, below = false) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = below ? "asb-menu asb-menu--below" : "asb-menu";

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
          // Buttons are still injected while hidden by CSS so flipping the
          // setting on takes effect without a rescan.
          injectButton(card);
        }
      });
      injectWatchButton();
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
    document.documentElement.classList.toggle("asb-cards-off", !state.showCardButtons);
    if (state.enabled) processAll();
    else unhideAll();
  }

  init();
})();
