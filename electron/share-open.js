// markie://open?token=…&src=… — a public share link, the token being the
// only authority it needs. Kept out of main.js so the order of events can be
// tested without Electron: for a server the user has not added, nothing is
// fetched until they say yes, and then only anonymously.
const { shareBaseFromSrc, untrustedShareOrigin } = require("./share-origin");
const { MAX_DOC_BYTES } = require("./doc-tiers");
const { readTextCapped } = require("./bounded-body");

// The same ceiling a document opened from disk has.
const DEFAULT_MAX_BYTES = MAX_DOC_BYTES;
// The whole exchange, answer and body. Generous, because a document can be
// large, but finite: a server that never finishes must not hold a fetch open
// in main for ever.
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * What a link asks for, before anything touches the network.
 *   { action: "ignore" }                         no token, or not a URL
 *   { action: "fetch", base, token }             a trusted server (or the default)
 *   { action: "confirm", origin, host, token }   a server the user has not added
 */
function planShareOpen(link, { allowDev = false } = {}) {
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    return { action: "ignore" };
  }
  const token = parsed.searchParams.get("token");
  if (!token) return { action: "ignore" };
  const src = parsed.searchParams.get("src");
  const untrusted = untrustedShareOrigin(src, { allowDev });
  if (untrusted) return { action: "confirm", origin: untrusted, host: new URL(untrusted).host, token };
  return { action: "fetch", base: shareBaseFromSrc(src, { allowDev }), token };
}

/**
 * Fetch the shared document a link names. `confirm({ origin, host })` is the
 * user's answer for an unknown server and is awaited before any request.
 * `fetchImpl(url, init, { anonymous })` makes the request; `anonymous` is
 * true for a server the user has not added. Resolves
 * `{ status: "ignored" | "declined" }` or
 * `{ status: "ok", content, disposition, origin, untrusted }`; throws when
 * the server's answer is not a document, is over `maxBytes`, or takes longer
 * than `timeoutMs`.
 */
async function fetchSharedDoc(
  link,
  { allowDev = false, confirm, fetchImpl, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const plan = planShareOpen(link, { allowDev });
  if (plan.action === "ignore") return { status: "ignored" };
  let base = plan.base;
  const anonymous = plan.action === "confirm";
  if (anonymous) {
    const yes = typeof confirm === "function" ? await confirm({ origin: plan.origin, host: plan.host }) : false;
    if (!yes) return { status: "declined", origin: plan.origin };
    base = plan.origin;
  }
  // The clock starts after the user answered, and covers the body as well
  // as the answer.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = anonymous
      ? // Anonymous: no session, no cookies, and no redirect, which is how an
        // approved public host would hand the request on to an internal one.
        { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "text/markdown, text/plain, */*" }, signal: controller.signal }
      : { signal: controller.signal };
    const res = await fetchImpl(`${base}/s/${encodeURIComponent(plan.token)}/raw`, init, { anonymous });
    if (!res.ok) {
      controller.abort();
      throw new Error(`HTTP ${res.status}`);
    }
    let content;
    try {
      content = await readTextCapped(res, maxBytes, { controller });
    } catch (err) {
      if (err && err.code === "EBODYTOOLARGE") throw new Error("too large");
      throw err;
    }
    return {
      status: "ok",
      content,
      disposition: res.headers?.get?.("content-disposition") ?? null,
      origin: base,
      untrusted: anonymous,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { planShareOpen, fetchSharedDoc };
