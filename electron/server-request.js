// The renderer's REST calls to a server other than Markie Cloud: sign-in,
// sharing. Made in main so a server added a moment ago works before the
// window's content security policy (fixed when the page loaded) knows about
// it. Main sends only to a trusted origin, only to its API routes, with no
// redirects, and with the token the renderer holds for that same origin.
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

/**
 * Make one request. `origin` has already been checked against the trusted
 * list by the caller.
 * @param {{ origin: string, path: string, method?: string, body?: string, token?: string | null }} req
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, maxResponseBytes?: number }} [opts]
 */
async function serverRequest(req, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const origin = req?.origin;
  const p = typeof req?.path === "string" ? req.path : "";
  if (!origin || !/^\/(?:api|auth)\/[A-Za-z0-9/_\-.~%?=&]*$/.test(p) || p.includes("..")) return { ...REFUSED };
  const method = METHODS.has(req?.method) ? req.method : "GET";
  const token = typeof req?.token === "string" && req.token.length <= MAX_TOKEN_CHARS ? req.token : null;
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

module.exports = { serverRequest, MAX_RESPONSE_BYTES, MAX_REQUEST_BODY_CHARS };
