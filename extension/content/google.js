// Hides Google's AI Overview / SGE box on search result pages.
//
// Find an exact AI Overview heading and its smallest self-contained answer
// container. A generic Google module attribute is not enough evidence to hide
// anything, and a container with any linked result heading is never hidden.
//
// Everything is wrapped so a markup change fails silently and never breaks
// the page. Deliberately does NOT touch regular organic results.

(() => {
  "use strict";

  const HIDDEN_ATTR = "data-asb-hidden";

  // Never hide these shared result containers, even if their only current
  // content happens to be the overview. More results may arrive later.
  const BOUNDARIES = "#center_col, #rcnt, #search, #rso, body, html";
  const HEADINGS = 'h1, h2, [role="heading"], strong';
  const RESULT_HEADINGS =
    'a h1, a h2, a h3, a h4, a h5, a h6, a [role="heading"], ' +
    'h1 a, h2 a, h3 a, h4 a, h5 a, h6 a, [role="heading"] a';
  const CONTROLS = 'button, a, input, select, textarea, svg, script, style, [role="button"]';

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

  function isOverviewHeading(heading) {
    return LABELS.has((heading.textContent || "").trim().toLowerCase()) &&
      !heading.closest("a");
  }

  // Ignore toolbar buttons and citation links when deciding whether there is
  // answer content beside the heading. A heading-only wrapper is not a box.
  function contentText(node) {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1 || node.matches(CONTROLS)) return "";
    return Array.from(node.childNodes, contentText).join(" ");
  }

  function hasAnswerContent(container, heading) {
    let headingBranch = heading;
    while (headingBranch.parentElement !== container) {
      headingBranch = headingBranch.parentElement;
      if (!headingBranch) return false;
    }
    return Array.from(container.childNodes).some(
      (node) => node !== headingBranch && contentText(node).trim()
    );
  }

  function isSafeContainer(container) {
    return !container.matches(BOUNDARIES) &&
      !container.querySelector(RESULT_HEADINGS);
  }

  function findOverviewContainers() {
    const containers = new Set();
    for (const heading of document.querySelectorAll(HEADINGS)) {
      if (!isOverviewHeading(heading)) continue;
      let container = heading.parentElement;
      for (let depth = 0; container && depth < 20; depth++) {
        // Every ancestor of an unsafe container would also contain its
        // organic result. Stop here instead of considering a bigger wrapper.
        if (!isSafeContainer(container)) break;
        if (hasAnswerContent(container, heading)) {
          containers.add(container);
          break;
        }
        container = container.parentElement;
      }
    }
    return containers;
  }

  function hideAIOverview() {
    if (!enabled) return;
    try {
      const containers = findOverviewContainers();
      // Google can reuse a module or inject results into a previously safe
      // box. Restore it as soon as it no longer qualifies.
      document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((el) => {
        if (!containers.has(el)) el.removeAttribute(HIDDEN_ATTR);
      });
      for (const el of containers) {
        if (!el.hasAttribute(HIDDEN_ATTR)) {
          el.setAttribute(HIDDEN_ATTR, "1");
          ASB.logEvent("overview"); // badge + stats, once per hidden box
        }
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
