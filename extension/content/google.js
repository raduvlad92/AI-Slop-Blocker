// Hides Google's AI Overview / SGE box on search result pages.
//
// Strategy (most → least resilient):
//   1. Structural: find a heading whose text is exactly "AI Overview", then
//      climb to the block-level container that sits directly under a known
//      results boundary (#center_col / #rcnt / #search).
//   2. Fallback: known container selectors (these rot when Google ships new
//      markup — they're a backstop, not the primary signal).
//
// Everything is wrapped so a markup change fails silently and never breaks
// the page. Deliberately does NOT touch regular organic results.

(() => {
  "use strict";

  const HIDDEN_ATTR = "data-asb-hidden";

  // Known AI Overview container selectors as of mid-2026. Expected to rot;
  // the structural detection above is the real workhorse.
  const FALLBACK_SELECTORS = ["#m-x-content", "div[data-mcpr]"];

  // Boundaries we climb up to — the AI Overview block is a direct child of
  // one of these.
  const BOUNDARIES = ["#center_col", "#rcnt", "#search", "#rso"];

  // ASSUMPTION: English-only text match for now. Localized UIs use translated
  // labels ("Vue d'ensemble de l'IA", etc.) — add them here as reported.
  const LABELS = new Set(["ai overview", "ai overviews"]);

  let enabled = null; // null until settings load; we don't hide before that

  // display:none with !important so Google's own styles can't override it.
  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `[${HIDDEN_ATTR}="1"] { display: none !important; }`;
    (document.head || document.documentElement).appendChild(style);
  }

  function findByStructure() {
    const headings = document.querySelectorAll('h1, h2, [role="heading"], strong');
    for (const h of headings) {
      const text = (h.textContent || "").trim().toLowerCase();
      if (!LABELS.has(text)) continue;

      // Climb to the child of the nearest boundary element (capped depth so a
      // weird DOM can't send us to <body>).
      let el = h;
      for (let depth = 0; depth < 20 && el.parentElement; depth++) {
        const parent = el.parentElement;
        if (BOUNDARIES.some((sel) => parent.matches?.(sel)) || parent === document.body) {
          return el === h ? null : el; // never hide the bare heading's own parent chain root = body
        }
        el = parent;
      }
    }
    return null;
  }

  function findAIOverview() {
    const structural = findByStructure();
    if (structural) return structural;
    for (const sel of FALLBACK_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Safety valve: if the candidate contains several organic result titles
  // (result links wrap an <h3>), we grabbed too big a container — abort
  // rather than blank out the results page.
  function looksSafeToHide(el) {
    return el.querySelectorAll("a h3").length <= 2;
  }

  function hideAIOverview() {
    if (!enabled) return;
    try {
      const el = findAIOverview();
      if (el && !el.hasAttribute(HIDDEN_ATTR) && looksSafeToHide(el)) {
        el.setAttribute(HIDDEN_ATTR, "1");
      }
    } catch {
      // fail silently, never break the page
    }
  }

  function unhideAll() {
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) =>
      el.removeAttribute(HIDDEN_ATTR)
    );
  }

  // Google injects the AI Overview asynchronously after first paint, so a
  // one-shot check isn't enough — watch the DOM (debounced).
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      hideAIOverview();
    }, 100);
  });

  async function init() {
    injectStyle();
    const { settings } = await ASB.getState();
    enabled = settings.hideAIOverview;

    observer.observe(document.documentElement, { childList: true, subtree: true });
    hideAIOverview();
    document.addEventListener("DOMContentLoaded", hideAIOverview);

    ASB.onStateChange(async () => {
      const { settings: s } = await ASB.getState();
      enabled = s.hideAIOverview;
      if (enabled) hideAIOverview();
      else unhideAll();
    });
  }

  init();
})();
