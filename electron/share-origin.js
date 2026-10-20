// Origin-pinning helpers, kept pure + dependency-free so they unit-test without
// booting Electron. Used by the markie://open deep-link handler and the sync
// engine to stop an attacker-controlled origin from receiving a fetch (SSRF) or
// the bearer token (token exfiltration).
//
// What counts as trusted is the list of servers the user added on purpose
// (electron/servers.js). Main hands that list in once at startup through
// setTrustedOrigins; until then, and in every test that does not care, the
// only trusted server is Markie Cloud.

// Canonical Markie production API. Update here if the backend moves.
const DEFAULT_SERVER = "https://api-production-602f.up.railway.app";

// Returns the trusted origins, default first. Replaced by main.
let trustedOrigins = () => [DEFAULT_SERVER];

function setTrustedOrigins(provider) {
  trustedOrigins = typeof provider === "function" ? provider : () => [DEFAULT_SERVER];
}

function isTrustedOrigin(origin) {
  if (typeof origin !== "string") return false;
  if (origin === DEFAULT_SERVER) return true;
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
      if (okHost && okProto) return `${u.protocol}//${u.host}`;
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
  setTrustedOrigins,
  isTrustedOrigin,
  shareBaseFromSrc,
  untrustedShareOrigin,
  isAllowedServerOrigin,
  isPublicHostname,
};
