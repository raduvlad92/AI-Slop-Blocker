import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("../extension/content/google.js", import.meta.url), "utf8");

// Minimal tree-based DOM for exercising the actual content script. CSS
// matching supports tag, ID, attribute and descendant selectors used here;
// the browser suite additionally checks real DOM selection and visibility.
class Element {
  nodeType = 1;
  parentElement = null;
  childNodes = [];
  attributes = new Map();

  constructor(tag, attributes = {}, ...children) {
    this.tagName = tag.toLowerCase();
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    if (typeof child === "string") child = { nodeType: 3, textContent: child, parentElement: null };
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.childNodes = []; if (value) this.appendChild(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  matches(selector) {
    return selector.split(",").some((part) => {
      const tokens = part.trim().split(/\s+/);
      const simple = (element, token) => {
        const tag = token.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && element.tagName !== tag.toLowerCase()) return false;
        const id = token.match(/#([\w-]+)/)?.[1];
        if (id && element.getAttribute("id") !== id) return false;
        for (const match of token.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
          if (!element.hasAttribute(match[1])) return false;
          if (match[2] !== undefined && element.getAttribute(match[1]) !== match[2]) return false;
        }
        return true;
      };
      if (!simple(this, tokens.pop())) return false;
      let ancestor = this.parentElement;
      while (tokens.length) {
        const token = tokens.pop();
        while (ancestor && !simple(ancestor, token)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (element) => {
      for (const child of element.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const el = (tag, attributes, ...children) => new Element(tag, attributes, ...children);
const overview = () => el("section", {}, el("h2", {}, "AI Overview"), el("p", {}, "An AI-generated answer."));
const organic = (title = "Ordinary search result") => el("div", {}, el("a", { href: "https://example.com" }, el("h3", {}, title)));
const hidden = (element) => element.hasAttribute("data-asb-hidden");

async function run(...children) {
  const results = el("div", { id: "rso" }, ...children);
  const body = el("body", {}, results);
  const head = el("head", {});
  const html = el("html", {}, head, body);
  let stateChanged;
  let mutation;
  let enabled = true;
  const timers = [];
  const events = [];
  const document = {
    body, head, documentElement: html,
    createElement: (tag) => el(tag, {}),
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    querySelector: (selector) => html.querySelector(selector),
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    ASB: {
      getState: async () => ({ settings: { hideAIOverview: enabled } }),
      onStateChange: (callback) => { stateChanged = callback; },
      logEvent: (kind) => { events.push(kind); },
    },
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {}
    },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
  });
  vm.runInContext(script, context);
  // The script awaits a host promise from inside the VM realm; let both
  // microtask queues finish before inspecting its initial DOM changes.
  await new Promise(setImmediate);
  return {
    results, events,
    async setEnabled(value) { enabled = value; await stateChanged(); },
    mutate(callback) { callback(); mutation(); while (timers.length) timers.shift()(); },
  };
}

test("hides only a nested, self-contained overview beside an organic result", async () => {
  const box = overview();
  const result = organic();
  const wrapper = el("div", { "data-mcpr": "" }, box, result);
  const fixture = await run(wrapper);
  assert.equal(hidden(box), true);
  assert.equal(hidden(wrapper), false);
  assert.equal(hidden(result), false);
  assert.deepEqual(fixture.events, ["overview"]);
});

test("never hides a shared module containing even one organic result", async () => {
  const result = organic();
  const mixed = el("div", { id: "m-x-content", "data-mcpr": "" }, el("h2", {}, "AI Overview"), el("p", {}, "Answer"), result);
  await run(mixed);
  assert.equal(hidden(mixed), false);
  assert.equal(hidden(result), false);
});

test("generic Google attributes without an overview heading are not sufficient", async () => {
  const card = el("div", { "data-mcpr": "" }, el("p", {}, "Useful search content"));
  const knownId = el("div", { id: "m-x-content" }, el("p", {}, "Useful search content"));
  await run(card, knownId);
  assert.equal(hidden(card), false);
  assert.equal(hidden(knownId), false);
});

test("an organic result titled AI Overview remains visible", async () => {
  const result = el("article", {}, el("a", { href: "https://example.com" }, el("h2", {}, "AI Overview")), el("p", {}, "An ordinary result snippet."));
  await run(result);
  assert.equal(hidden(result), false);
});

test("does not hide heading-only wrappers or shared results boundaries", async () => {
  const headingOnly = el("div", {}, el("h2", {}, "AI Overview"), el("button", {}, "Listen"));
  const fixture = await run(headingOnly);
  assert.equal(hidden(headingOnly), false);
  assert.equal(hidden(fixture.results), false);
  const directHeading = el("h2", {}, "AI Overview");
  const directAnswer = el("p", {}, "Answer with no individual module container");
  fixture.mutate(() => { fixture.results.appendChild(directHeading); fixture.results.appendChild(directAnswer); });
  assert.equal(hidden(fixture.results), false);
});

test("supports asynchronous insertion and restores content when switched off", async () => {
  const box = overview();
  const fixture = await run(organic());
  fixture.mutate(() => fixture.results.appendChild(box));
  assert.equal(hidden(box), true);
  await fixture.setEnabled(false);
  assert.equal(hidden(box), false);
  await fixture.setEnabled(true);
  assert.equal(hidden(box), true);
});

test("restores a previously hidden module when organic results arrive", async () => {
  const box = overview();
  const fixture = await run(box);
  assert.equal(hidden(box), true);
  const result = organic();
  fixture.mutate(() => box.appendChild(result));
  assert.equal(hidden(box), false);
  assert.equal(hidden(result), false);
});

test("restores a recycled module whose overview heading was replaced", async () => {
  const box = overview();
  const fixture = await run(box);
  fixture.mutate(() => { box.querySelector("h2").textContent = "Other search feature"; });
  assert.equal(hidden(box), false);
});
