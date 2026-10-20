// markie://open?token=…&src=… — a public share link, the token being the
// only authority it needs. Kept out of main.js so the order of events can be
// tested without Electron: for a server the user has not added, nothing is
// fetched until they say yes, and then only anonymously.
const { shareBaseFromSrc, untrustedShareOrigin } = require("./share-origin");
const { MAX_DOC_BYTES } = require("./doc-tiers");

// The same ceiling a document opened from disk has.
const DEFAULT_MAX_BYTES = MAX_DOC_BYTES;

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
 * Resolves `{ status: "ignored" | "declined" }` or
 * `{ status: "ok", content, disposition, origin, untrusted }`; throws when
 * the server's answer is not a document.
 */
async function fetchSharedDoc(link, { allowDev = false, confirm, fetchImpl, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const plan = planShareOpen(link, { allowDev });
  if (plan.action === "ignore") return { status: "ignored" };
  let base = plan.base;
  let init;
  if (plan.action === "confirm") {
    const yes = typeof confirm === "function" ? await confirm({ origin: plan.origin, host: plan.host }) : false;
    if (!yes) return { status: "declined", origin: plan.origin };
    base = plan.origin;
    // Anonymous: no session, no cookies, and no redirect, which is how an
    // approved public host would hand the request on to an internal one.
    init = { method: "GET", redirect: "error", credentials: "omit", headers: { Accept: "text/markdown, text/plain, */*" } };
  }
  const res = await fetchImpl(`${base}/s/${encodeURIComponent(plan.token)}/raw`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers?.get?.("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("too large");
  const content = await res.text();
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("too large");
  return {
    status: "ok",
    content,
    disposition: res.headers?.get?.("content-disposition") ?? null,
    origin: base,
    untrusted: plan.action === "confirm",
  };
}

module.exports = { planShareOpen, fetchSharedDoc };
