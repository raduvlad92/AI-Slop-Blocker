// Shared by classic content scripts and the module background worker. Only
// channels already on a block list are looked up; no feed/watch history is sent.
(() => {
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const HANDLE = /^@[\p{L}\p{M}\p{N}._·-]{1,100}$/u;
  const CACHE_MS = 7 * 864e5;

  function normalize(value) {
    if (typeof value !== "string") return null;
    let id = value.trim();
    if (/^(https?:\/\/|\/)/.test(id)) {
      try {
        const url = new URL(id, "https://www.youtube.com");
        if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) return null;
        id = url.pathname.startsWith("/channel/") ? url.pathname.split("/")[2] : url.pathname.split("/")[1];
      } catch { return null; }
    }
    if (CHANNEL_ID.test(id)) return id;
    try { id = decodeURIComponent(id).normalize("NFC").toLowerCase(); } catch { return null; }
    return HANDLE.test(id) ? id : null;
  }

  function canonical(value, aliases = {}, now = Date.now()) {
    const id = normalize(value);
    if (!id) return null;
    const cached = aliases[id];
    if (typeof cached === "object" && !(cached?.resolvedAt > now - CACHE_MS)) return id;
    const resolved = typeof cached === "string" ? cached : cached?.id;
    return CHANNEL_ID.test(resolved || "") ? resolved : id;
  }

  function attribute(tag, name) {
    return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "";
  }

  function initialData(html) {
    const match = /(?:var\s+)?ytInitialData\s*=\s*|window\s*\[\s*["']ytInitialData["']\s*\]\s*=\s*/.exec(html);
    if (!match) return null;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < html.length; i++) {
      const char = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function parsePage(html, requested) {
    const ids = new Set();
    const aliases = new Set();
    for (const tag of html.match(/<(?:meta|link)\b[^>]*>/gi) || []) {
      if (attribute(tag, "itemprop") === "channelId") {
        const value = attribute(tag, "content");
        if (CHANNEL_ID.test(value)) ids.add(value);
      }
      if (attribute(tag, "rel").toLowerCase() === "canonical") {
        const value = normalize(attribute(tag, "href"));
        if (!value) return null;
        if (value?.startsWith("UC")) ids.add(value);
        else if (value) aliases.add(value);
      }
    }
    const metadata = initialData(html)?.metadata?.channelMetadataRenderer;
    if (CHANNEL_ID.test(metadata?.externalId || "")) ids.add(metadata.externalId);
    for (const url of [metadata?.vanityChannelUrl, metadata?.channelUrl]) {
      const alias = normalize(url);
      if (alias?.startsWith("@")) aliases.add(alias);
      else if (alias?.startsWith("UC")) ids.add(alias);
    }
    const source = normalize(requested);
    const [id] = ids;
    if (ids.size !== 1 || !source || (source.startsWith("UC") && source !== id)) return null;
    if (source.startsWith("@") && aliases.size && !aliases.has(source)) return null;
    if (source?.startsWith("@")) aliases.add(source);
    return { id, aliases: [...aliases] };
  }

  function createResolver({ storage, fetchPage, mutate, now = Date.now }) {
    const pending = new Map();
    const waiting = [];
    let active = 0;

    async function acquire() {
      if (active >= 4) await new Promise((resolve) => waiting.push(resolve));
      else active++;
    }

    function release() {
      if (waiting.length) waiting.shift()();
      else active--;
    }

    async function lookup(source) {
      if (pending.has(source)) return pending.get(source);
      const operation = (async () => {
        await acquire();
        try {
          const path = source.startsWith("@") ? `@${encodeURIComponent(source.slice(1))}` : `channel/${source}`;
          const html = await fetchPage(`https://www.youtube.com/${path}`);
          const result = parsePage(html, source);
          if (!result) return;
          await mutate(async () => {
            const data = await storage.get({
              channelAliases: {}, personal: { videos: {}, channels: {} },
              community: { videos: [], channels: [], syncedAt: 0 }, communityChannelBindings: {},
            });
            const record = { id: result.id, resolvedAt: now() };
            const currentAliases = new Set(result.aliases);
            for (const [alias, previous] of Object.entries(data.channelAliases)) {
              const previousId = typeof previous === "string" ? previous : previous?.id;
              if (alias.startsWith("@") && previousId === result.id && !currentAliases.has(alias)) {
                delete data.channelAliases[alias];
              }
            }
            data.channelAliases[result.id] = record;
            for (const alias of result.aliases) data.channelAliases[alias] = record;
            // Existing handle blocks become canonical blocks so a later handle
            // rename or reassignment does not change which creator was blocked.
            for (const key of Object.keys(data.personal.channels)) {
              if (key !== result.id && canonical(key, data.channelAliases, now()) === result.id) {
                data.personal.channels[result.id] ||= data.personal.channels[key];
                delete data.personal.channels[key];
              }
            }
            data.community.channels = [...new Set(data.community.channels.map((key) => {
              const normalized = normalize(key);
              if (normalized?.startsWith("@") && canonical(key, data.channelAliases, now()) === result.id) {
                data.communityChannelBindings[normalized] = result.id;
                return result.id;
              }
              return key;
            }))];
            await storage.set(data);
          });
        } finally { release(); }
      })();
      pending.set(source, operation);
      try { await operation; } finally { pending.delete(source); }
    }

    return async function resolve(ids) {
      const data = await storage.get({ channelAliases: {}, personal: { videos: {}, channels: {} }, community: { channels: [] } });
      const blocked = new Set([...Object.keys(data.personal.channels), ...data.community.channels].map(normalize));
      const sources = [...new Set(ids.map(normalize).filter((id) => id && blocked.has(id)))].slice(0, 20);
      // Small batches bound network concurrency and finish inside the
      // message lifetime. A failed lookup leaves the existing block intact.
      for (let i = 0; i < sources.length; i += 4) {
        await Promise.allSettled(sources.slice(i, i + 4).map((source) => {
          const cached = data.channelAliases[source];
          if (CHANNEL_ID.test(cached?.id || "") && cached.resolvedAt > now() - CACHE_MS) return;
          return lookup(source);
        }));
      }
      const { channelAliases } = await storage.get({ channelAliases: {} });
      return { ok: true, channelAliases };
    };
  }

  globalThis.ASBChannels = { normalize, canonical, parsePage, createResolver, CACHE_MS };
})();
