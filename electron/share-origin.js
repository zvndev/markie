// Origin-pinning helpers, kept pure + dependency-free so they unit-test without
// booting Electron. Used by the markie://open deep-link handler and the sync
// engine to stop an attacker-controlled origin from receiving a fetch (SSRF) or
// the bearer token (token exfiltration).

// Canonical Markie production API. Update here if the backend moves.
const DEFAULT_SERVER = "https://api-production-602f.up.railway.app";

// Hosts we will talk to. Add the custom domain here when it ships.
const ALLOWED_HOSTS = new Set([
  "api-production-602f.up.railway.app",
  // "markie.zvndev.com",
]);

function isLocalhost(host) {
  const h = String(host).split(":")[0];
  return h === "localhost" || h === "127.0.0.1";
}

// Resolve the base origin to fetch a shared doc from. The deep link carries a
// `src`, but we NEVER trust it as a fetch target: honor it only when it is an
// explicitly allowlisted Markie https origin (or localhost in dev), otherwise
// fall back to the known production API. Defeats markie://open?src=<attacker>.
function shareBaseFromSrc(src, { allowDev = false } = {}) {
  if (src) {
    try {
      const u = new URL(/^https?:\/\//i.test(src) ? src : `https://${src}`);
      const okHost = ALLOWED_HOSTS.has(u.host) || (allowDev && isLocalhost(u.host));
      const okProto = u.protocol === "https:" || (allowDev && u.protocol === "http:");
      if (okHost && okProto) return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_SERVER;
}

// May we forward the bearer token / sync to this server URL? Pin to the known
// production origin (plus localhost in dev).
function isAllowedServerOrigin(serverURL, { allowDev = false } = {}) {
  if (!serverURL || typeof serverURL !== "string") return false;
  try {
    const u = new URL(serverURL);
    if (ALLOWED_HOSTS.has(u.host) && u.protocol === "https:") return true;
    if (allowDev && isLocalhost(u.host)) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_SERVER, ALLOWED_HOSTS, shareBaseFromSrc, isAllowedServerOrigin };
