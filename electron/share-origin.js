// Origin-pinning helpers, kept pure + dependency-free so they unit-test without
// booting Electron. Used by the markie://open deep-link handler and the sync
// engine to stop an attacker-controlled origin from receiving a fetch (SSRF) or
// the bearer token (token exfiltration).
//
// What counts as trusted is the list of servers the user added on purpose
// (electron/servers.js). Main hands that list in once at startup through
// setTrustedOrigins; until then, and in every test that does not care, the
// only trusted server is Markie Cloud.

// Markie Cloud's address, and the addresses it used to have. The one copy
// lives in cloud-origin.json, which the renderer imports too (the sandboxed
// preload and the server package keep literal copies, tested against it).
// An alias is the same server under an older name: the same backend, the
// same database, so a session or a link from one is good on the other.
// Anything stored under an alias is read as the canonical origin.
const CLOUD = require("./cloud-origin.json");
const DEFAULT_SERVER = CLOUD.origin;
const CLOUD_ALIASES = Object.freeze([...CLOUD.legacyAliases]);

/** Whether `origin` is Markie Cloud under its current name or an old one. */
function isCloudOrigin(origin) {
  return typeof origin === "string" && (origin === DEFAULT_SERVER || CLOUD_ALIASES.includes(origin));
}

/**
 * Markie Cloud's current origin for any of its old ones; anything else,
 * including a value that is not an origin at all, comes back unchanged.
 */
function canonicalCloudOrigin(origin) {
  if (typeof origin !== "string" || !origin) return origin;
  let parsed = null;
  try {
    parsed = new URL(origin).origin;
  } catch {
    return origin;
  }
  return CLOUD_ALIASES.includes(parsed) ? DEFAULT_SERVER : origin;
}

// Returns the trusted origins, default first. Replaced by main.
let trustedOrigins = () => [DEFAULT_SERVER];

function setTrustedOrigins(provider) {
  trustedOrigins = typeof provider === "function" ? provider : () => [DEFAULT_SERVER];
}

function isTrustedOrigin(origin) {
  if (typeof origin !== "string") return false;
  if (isCloudOrigin(origin)) return true;
  try {
    return trustedOrigins().includes(origin);
  } catch {
    return false;
  }
}

function isLocalhost(host) {
  const h = String(host).split(":")[0];
  return h === "localhost" || h === "127.0.0.1";
}

function parse(src) {
  try {
    return new URL(/^https?:\/\//i.test(src) ? src : `https://${src}`);
  } catch {
    return null;
  }
}

// Resolve the base origin to fetch a shared doc from. The deep link carries a
// `src`, but we NEVER trust it as a fetch target: honor it only when it is a
// trusted Markie https origin (or localhost in dev), otherwise fall back to
// the known production API. Defeats markie://open?src=<attacker>.
function shareBaseFromSrc(src, { allowDev = false } = {}) {
  if (src) {
    const u = parse(src);
    if (u && !u.username && !u.password) {
      const okProto = u.protocol === "https:" || (allowDev && u.protocol === "http:");
      const okHost = isTrustedOrigin(u.origin) || (allowDev && isLocalhost(u.host));
      if (okHost && okProto) return canonicalCloudOrigin(`${u.protocol}//${u.host}`);
    }
  }
  return DEFAULT_SERVER;
}

// A host a link from outside may name as a server to ask. Public DNS names
// only: an IP literal, a single-label name or a local-network suffix is an
// address inside the user's own network, and a click in an email must not be
// able to make this app knock on it, even after a confirmation the user may
// not read closely.
function isPublicHostname(hostname) {
  const h = String(hostname).toLowerCase();
  if (!h || h.startsWith("[") || h.includes(":")) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  if (!h.includes(".")) return false;
  if (/\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(h)) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

// An IPv6 literal as the URL parser writes it ("[::ffff:7f00:1]"), as its
// eight 16-bit groups, or null when it is not one.
function ipv6Groups(hostname) {
  const m = /^\[([0-9a-f:.]+)\]$/i.exec(String(hostname));
  if (!m) return null;
  let text = m[1].toLowerCase();
  // A trailing dotted quad ("::ffff:127.0.0.1") is two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const b = quad.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    text = `${text.slice(0, quad.index)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

// 127.0.0.0/8 (loopback) and 0.0.0.0/8 ("this host", which reaches the
// loopback interface on the common platforms), as dotted-quad text.
function isLoopbackIPv4(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return false;
  const b = m.slice(1).map(Number);
  if (b.some((n) => n > 255)) return false;
  return b[0] === 127 || b[0] === 0;
}

/**
 * Whether a URL's hostname is this computer: localhost by any spelling
 * ("localhost", "localhost.", "anything.localhost"), 127.0.0.0/8, 0.0.0.0/8,
 * ::1, the unspecified ::, and an IPv4 loopback or unspecified address
 * written as IPv6 (mapped "::ffff:7f00:1", compatible "::7f00:1",
 * translated "::ffff:0:7f00:1"). Takes `URL.hostname`, which has already
 * turned "127.1", "0x7f000001" and "2130706433" into "127.0.0.1".
 *
 * Narrower than isPublicHostname on purpose: a server the user adds by hand
 * may be on their own network (a LAN name, a Tailscale address); only the
 * machine itself is ruled out, because a packaged app has no business
 * sending a session token to a port some other local program opened.
 */
function isLoopbackHostname(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  if (!h) return false;
  const name = h.endsWith(".") ? h.slice(0, -1) : h;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (isLoopbackIPv4(name)) return true;
  const g = ipv6Groups(h);
  if (!g) return false;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  // :: and ::1
  if (zeros(0, 7) && (g[7] === 0 || g[7] === 1)) return true;
  // An IPv4 address carried in the last 32 bits.
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const mapped = zeros(0, 5) && g[5] === 0xffff;
  const translated = zeros(0, 4) && g[4] === 0xffff && g[5] === 0;
  if ((mapped || translated) && isLoopbackIPv4(v4)) return true;
  // The deprecated "compatible" form: only 127/8, since ::2 and the like are
  // ordinary (if unused) IPv6 addresses, not 0.0.0.2.
  return zeros(0, 6) && g[6] >> 8 === 127;
}

// The origin a markie://open link names when it is a plausible Markie server
// the user has NOT added: https, no credentials, a public host. The caller has
// to ask the user before fetching anything from it. Null for a trusted origin
// (shareBaseFromSrc already handles that), for no src, and for anything that
// is not a clean https origin, all of which keep the old behaviour of falling
// back to the default server.
function untrustedShareOrigin(src, { allowDev = false } = {}) {
  if (!src || typeof src !== "string") return null;
  const u = parse(src);
  if (!u || u.protocol !== "https:" || u.username || u.password) return null;
  if (isTrustedOrigin(u.origin)) return null;
  if (allowDev && isLocalhost(u.host)) return null;
  if (!isPublicHostname(u.hostname)) return null;
  return u.origin;
}

// May we forward the bearer token / sync to this server URL? Only to a server
// the user added (plus localhost in dev), compared as an exact origin.
function isAllowedServerOrigin(serverURL, { allowDev = false } = {}) {
  if (!serverURL || typeof serverURL !== "string") return false;
  try {
    const u = new URL(serverURL);
    if (u.username || u.password) return false;
    if (u.protocol === "https:" && isTrustedOrigin(u.origin)) return true;
    if (allowDev && isLocalhost(u.host)) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SERVER,
  CLOUD_ALIASES,
  isCloudOrigin,
  canonicalCloudOrigin,
  setTrustedOrigins,
  isTrustedOrigin,
  shareBaseFromSrc,
  untrustedShareOrigin,
  isAllowedServerOrigin,
  isPublicHostname,
  isLoopbackHostname,
};
