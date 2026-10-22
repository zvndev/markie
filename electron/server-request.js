// The renderer's REST calls to a server other than Markie Cloud: sign-in,
// sharing. Made in main so a server added a moment ago works before the
// window's content security policy (fixed when the page loaded) knows about
// it. Main sends only to a trusted origin, only to its API routes, with no
// redirects, and only with the token main itself holds for that origin.
//
// Kept out of main.js so the checks unit-test without Electron.
const { readTextCapped } = require("./bounded-body");

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_TOKEN_CHARS = 4096;
// What the renderer may send, and what main will read back. Both match the
// server's own JSON body limit (server/src/index.ts JSON_BODY_LIMIT): these
// are sign-in and sharing calls, never a document's text.
const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;

const REFUSED = Object.freeze({ ok: false, status: 0, data: null, error: "That request isn't allowed." });
const WRONG_SESSION = Object.freeze({ ok: false, status: 0, data: null, error: "That sign-in isn't this server's." });

/**
 * The path and query to send, or null. The raw string is checked first, and
 * then the path the URL parser actually makes of it against the origin,
 * because that is the one the request goes to. A percent-encoded dot, slash
 * or backslash is refused outright: "/api/%2e%2e/admin" passes a check on
 * the raw text and may be decoded into "/api/../admin" by a proxy or the
 * server in front of the route.
 */
function checkedPath(origin, p) {
  if (typeof p !== "string" || p.length > 4096) return null;
  if (!/^\/(?:api|auth)\/[A-Za-z0-9/_\-.~%?=&]*$/.test(p)) return null;
  if (p.includes("..") || /%(?:2e|2f|5c)/i.test(p)) return null;
  let u;
  try {
    u = new URL(p, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || u.hash || u.username || u.password) return null;
  if (!/^\/(?:api|auth)\/[A-Za-z0-9/_\-.~%]*$/.test(u.pathname)) return null;
  if (u.pathname.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return `${u.pathname}${u.search}`;
}

/**
 * Make one request. `origin` has already been checked against the trusted
 * list by the caller.
 *
 * The bearer token is bound to the origin here, not taken on the renderer's
 * word. `storedToken` is the token main holds for this origin: the session
 * the renderer handed the sync engine for it (sync-session), keyed by
 * origin. The renderer still says whether to send a token, because a
 * sign-in goes without one and its own checks on the answer compare against
 * the token it asked with. But a token it names has to be that origin's
 * stored one, and main sends its own copy, so a renderer bug or a
 * compromised page cannot hand one server's token to another.
 *
 * @param {{ origin: string, path: string, method?: string, body?: string, token?: string | null }} req
 * @param {{ storedToken?: string | null, fetchImpl?: typeof fetch, timeoutMs?: number, maxResponseBytes?: number }} [opts]
 */
async function serverRequest(
  req,
  { storedToken = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {}
) {
  const origin = req?.origin;
  const p = origin ? checkedPath(origin, req?.path) : null;
  if (!p) return { ...REFUSED };
  const method = METHODS.has(req?.method) ? req.method : "GET";
  const asked = typeof req?.token === "string" && req.token && req.token.length <= MAX_TOKEN_CHARS ? req.token : null;
  if (asked !== null && asked !== storedToken) return { ...WRONG_SESSION };
  const token = asked === null ? null : storedToken;
  const body = typeof req?.body === "string" && req.body.length <= MAX_REQUEST_BODY_CHARS ? req.body : undefined;
  // One controller for the answer and the body, so the timeout covers both
  // and an oversize body closes the connection rather than draining it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === "GET" ? undefined : body,
      redirect: "error",
      signal: controller.signal,
    });
    let text;
    try {
      text = await readTextCapped(res, maxResponseBytes, { controller });
    } catch (err) {
      if (err && err.code === "EBODYTOOLARGE") return { ok: false, status: 0, data: null, error: "The server's answer was too large." };
      throw err;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data, setAuthToken: res.headers.get("set-auth-token") };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { serverRequest, checkedPath, MAX_RESPONSE_BYTES, MAX_REQUEST_BODY_CHARS };
