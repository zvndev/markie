// The card that appears when you hover a link.
//
// Two rules shape everything here. Nothing is fetched when a document opens,
// only when a person deliberately points at a link, because a document is
// somebody else's text and opening it should not make your machine call out to
// every address in it. And the fetch happens in main, because the renderer's
// connect-src is locked to Markie's own API on purpose and widening it to the
// whole web to draw a preview card would be a poor trade.
//
// What comes back is somebody else's HTML. It is scanned for a handful of
// strings and nothing else: no DOM is built, no script is run, no markup is
// kept. The renderer receives four short plain strings and a data URI.

const dns = require("node:dns");

const UA = "Markie link preview (+https://markie.app)";
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 6000;
const TTL_MS = 30 * 60 * 1000;
const MAX_TEXT = 300;

// ── What may be asked for ────────────────────────────────────────────────────

// Reachable-but-not-public addresses. A document is text somebody else wrote,
// and hovering a link in it must not become a way to knock on doors inside the
// reader's network and learn which ones answer.
function isPrivateAddress(address) {
  const ip = String(address || "");
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[cd]/.test(v6)) return true; // unique local
    if (/^fe[89ab]/.test(v6)) return true; // link local
    // ::ffff:10.0.0.1 and friends
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // not an address we understand, so not one we will fetch
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function parseTarget(rawUrl, allowPrivate = false) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return null;
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))) {
    return null;
  }
  // Credentials in the URL would be sent to whatever it redirects to.
  if (url.username || url.password) return null;
  return url;
}

async function resolvesPublicly(hostname, lookup, allowPrivate = false) {
  if (allowPrivate) return true;
  // A literal address never reaches the resolver, so check it directly first.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return !isPrivateAddress(hostname);
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return false;
  }
  if (!addresses || addresses.length === 0) return false;
  return addresses.every((entry) => !isPrivateAddress(entry.address));
}

// ── Reading somebody else's page ─────────────────────────────────────────────

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function clean(text) {
  const flat = decodeEntities(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1).trimEnd()}…` : flat;
}

const META_RE = /<meta\b([^>]*?)\/?>/gi;
const ATTR_RE = /([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * The handful of strings a preview card is made of, scanned out of a page's
 * markup. No DOM, no parser, nothing kept but text.
 */
function parseMeta(html) {
  const source = String(html || "");
  // Everything worth having is in the head, and stopping there keeps a page's
  // body out of a card.
  const head = source.split(/<\/head>/i)[0] ?? source;
  const found = new Map();

  for (const tag of head.matchAll(META_RE)) {
    const attrs = new Map();
    for (const attr of String(tag[1]).matchAll(ATTR_RE)) {
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const key = (attrs.get("property") || attrs.get("name") || "").toLowerCase();
    const content = attrs.get("content");
    // First one wins: a page that repeats og:title means the first.
    if (key && content && !found.has(key)) found.set(key, content);
  }

  const pick = (...keys) => {
    for (const key of keys) {
      const value = found.get(key);
      if (value) {
        const text = clean(value);
        if (text) return text;
      }
    }
    return null;
  };

  const titleTag = TITLE_RE.exec(head);
  return {
    title: pick("og:title", "twitter:title") || (titleTag ? clean(titleTag[1]) : null),
    description: pick("og:description", "twitter:description", "description"),
    siteName: pick("og:site_name", "application-name"),
    imageUrl: found.get("og:image") || found.get("twitter:image") || found.get("og:image:url") || null,
  };
}

// ── Fetching ─────────────────────────────────────────────────────────────────

async function readCapped(response, maxBytes) {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      // Stop pulling rather than reading a whole video somebody pointed at.
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/**
 * Follow the hops ourselves, checking every one. `redirect: "follow"` would
 * hand a public hostname's redirect to an address inside the reader's network
 * without ever showing it to us.
 */
async function fetchChecked(rawUrl, { fetchImpl, lookup, accept, maxBytes, signal, allowPrivate }) {
  let url = parseTarget(rawUrl, allowPrivate);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!(await resolvesPublicly(host, lookup, allowPrivate))) return null;
    const response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "user-agent": UA, accept },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      let next;
      try {
        next = parseTarget(new URL(location, url.href).href, allowPrivate);
      } catch {
        return null;
      }
      if (!next) return null;
      url = next;
      continue;
    }
    if (!response.ok) return null;
    return { response, url, bytes: await readCapped(response, maxBytes) };
  }
  return null;
}

function createLinkPreviews(deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    lookup = dns.promises.lookup,
    now = () => Date.now(),
    // Only the end-to-end check sets this, and only so it can point Markie at a
    // page it serves itself. Without it there is no way to exercise the real
    // path in a real window, because everything a test can host is loopback,
    // which is exactly what the guard exists to refuse.
    allowPrivate = false,
    ttlMs = TTL_MS,
    maxEntries = 200,
    timeoutMs = TIMEOUT_MS,
  } = deps;

  // In memory only, and gone when Markie quits. A list of the links somebody
  // paused over is a record of what they were reading, and it is not one worth
  // keeping on disk to save a second fetch.
  const cache = new Map();
  const inFlight = new Map();

  const withTimeout = async (run) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  async function fetchImage(rawUrl, base, signal) {
    let absolute;
    try {
      absolute = new URL(String(rawUrl), base).href;
    } catch {
      return null;
    }
    const got = await fetchChecked(absolute, {
      fetchImpl,
      lookup,
      accept: "image/*",
      maxBytes: MAX_IMAGE_BYTES,
      signal,
      allowPrivate,
    }).catch(() => null);
    if (!got) return null;
    const type = String(got.response.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(type)) return null;
    if (got.bytes.length === 0) return null;
    // Handed over inlined so the renderer makes no request of its own: the site
    // learns that somebody looked, and the site's CDN does not separately.
    return `data:${type};base64,${got.bytes.toString("base64")}`;
  }

  async function load(target) {
    return withTimeout(async (signal) => {
      const got = await fetchChecked(target, {
        fetchImpl,
        lookup,
        accept: "text/html,application/xhtml+xml",
        maxBytes: MAX_HTML_BYTES,
        signal,
        allowPrivate,
      });
      if (!got) return null;
      const type = String(got.response.headers.get("content-type") || "").toLowerCase();
      if (type && !type.includes("html") && !type.includes("xml")) return null;

      const meta = parseMeta(got.bytes.toString("utf-8"));
      if (!meta.title && !meta.description) return null;

      const image = meta.imageUrl ? await fetchImage(meta.imageUrl, got.url.href, signal) : null;
      return {
        url: got.url.href,
        title: meta.title,
        description: meta.description,
        siteName: meta.siteName || got.url.hostname.replace(/^www\./, ""),
        image,
      };
    });
  }

  return {
    /** The card for a link, or null when there is nothing worth showing. */
    async get(rawUrl) {
      const target = parseTarget(rawUrl, allowPrivate);
      if (!target) return null;
      const key = target.href;

      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.value;

      // Hover fires repeatedly; one request per link, not one per twitch.
      const running = inFlight.get(key);
      if (running) return running;

      const promise = load(key)
        .catch(() => null)
        .then((value) => {
          inFlight.delete(key);
          if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
          cache.set(key, { value, until: now() + ttlMs });
          return value;
        });
      inFlight.set(key, promise);
      return promise;
    },
  };
}

module.exports = {
  createLinkPreviews,
  isPrivateAddress,
  parseMeta,
  parseTarget,
};
