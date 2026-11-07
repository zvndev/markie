// What a Darkmown (.wd) preview frame may reach outside itself: pictures that
// sit in the document's own folder, and a link the user clicked.
//
// The preview is an opaque, sandboxed srcdoc frame (src/lib/darkmown/frame.ts).
// It cannot read files and it cannot navigate. Two things a plain document
// needs anyway, and this module is the main-process half of both:
//
//   Pictures. The renderer never learns where a .wd file lives: it holds an
//   opaque lease (electron/document-files.cjs). So main mints a picture scope
//   for the document's folder, a random host under markie-asset://, and the
//   asset protocol answers a request on that host only with an image whose
//   realpath is strictly inside that one folder. The rule itself is
//   local-assets.js, the same one the Markdown viewer and the exporter use,
//   called with no workspace roots and no granted files, so a `../` or a
//   symlink out of the folder resolves to nothing.
//
//   Links. The frame posts the href of an anchor the user really clicked to
//   the host page, which asks main through one channel that only knows how to
//   open a web page or a mail draft. darkmownLinkTarget is that whole list,
//   checked again here because the renderer is not trusted to have checked it.
//
// Dependency-free and injectable like local-assets.js, so it is tested
// without Electron.

const { randomUUID: nodeRandomUUID } = require("crypto");
const localAssets = require("./local-assets");

const MAX_URL = 8192;
const MAX_REF = 2048;
// A simple address, the shape every mail client agrees on. Quoted local parts
// and IP literals are legal and never what a document means.
const ADDRESS = /^[A-Za-z0-9.!$&'*+/=^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
// Query fields a mailto may prefill. Anything else is refused, not dropped:
// some clients honour `attach=` with a local path, and a link that silently
// changes meaning on the way out is worse than one that does not open.
const MAIL_FIELDS = new Set(["subject", "body", "cc", "bcc"]);
const SCOPE_HOST = /^wd-[0-9a-f]{32}$/;

function addressList(value) {
  const parts = String(value).split(",").map((part) => part.trim());
  return parts.length > 0 && parts.length <= 20 && parts.every((part) => ADDRESS.test(part));
}

/**
 * The URL to hand the operating system for a link in a .wd preview, or null.
 * Only http:, https: and mailto:. Never file:, javascript:, a custom app
 * scheme, a relative path, or a URL carrying credentials.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function darkmownLinkTarget(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!/^https?:\/\//i.test(value) || !url.hostname || url.username || url.password) return null;
    return url.href;
  }
  if (url.protocol !== "mailto:" || url.hash) return null;
  let to;
  try { to = decodeURIComponent(url.pathname); } catch { return null; }
  if (to && !addressList(to)) return null;
  let fields = 0;
  for (const [key, field] of url.searchParams) {
    const name = key.toLowerCase();
    if (!MAIL_FIELDS.has(name) || ++fields > 8 || field.length > 2000) return null;
    if ((name === "cc" || name === "bcc") && !addressList(field)) return null;
  }
  // A draft with nobody to send it to and nothing in it is not a link.
  if (!to && fields === 0) return null;
  return url.href;
}

/**
 * True when a subframe navigation must be stopped because it would take a
 * srcdoc document (the Darkmown preview) somewhere else. A preview only ever
 * replaces itself with new srcdoc; a link it shows goes to the browser
 * through darkmownLinkTarget, never into the frame.
 *
 * @param {{isMainFrame?: boolean, isSameDocument?: boolean, frameUrl?: string|null, url?: string}} details
 */
function blocksSrcdocNavigation({ isMainFrame, isSameDocument, frameUrl, url } = {}) {
  if (isMainFrame || isSameDocument) return false;
  if (frameUrl !== "about:srcdoc") return false;
  return url !== "about:srcdoc" && url !== "about:blank";
}

// The reference as the document wrote it, if it is a plain relative path.
// local-assets.js would refuse the rest too; refusing them here first means a
// scheme or an absolute path never reaches the filesystem at all.
function relativeRef(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REF) return null;
  if (/[\x00-\x1f\x7f\\]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const bare = localAssets.urlToRelativePath(raw);
  if (!bare || bare.startsWith("/") || /^[a-z]:/i.test(bare) || /[\x00-\x1f\x7f\\]/.test(bare)) return null;
  if (bare.split("/").includes("..")) return null;
  return raw;
}

/**
 * Picture scopes: one random markie-asset host per (window, document folder).
 *
 * @param {{randomUUID?: () => string, maxScopes?: number, resolveImage?: typeof localAssets.resolveImage, realpath?: (p: string) => string}} [options]
 */
function createDarkmownPictureScopes({ randomUUID = nodeRandomUUID, maxScopes = 64, resolveImage = localAssets.resolveImage, realpath } = {}) {
  const scopes = new Map(); // host -> { owner, docDir }

  const scopeFor = (owner, docDir) => {
    if (!Number.isSafeInteger(owner) || owner < 1 || typeof docDir !== "string" || !docDir) return null;
    for (const [host, scope] of scopes) {
      if (scope.owner === owner && scope.docDir === docDir) {
        // Most recently used goes to the back, so eviction takes the oldest.
        scopes.delete(host); scopes.set(host, scope);
        return host;
      }
    }
    const host = `wd-${String(randomUUID()).replace(/-/g, "").toLowerCase()}`;
    if (!SCOPE_HOST.test(host)) return null;
    scopes.set(host, { owner, docDir });
    while (scopes.size > maxScopes) scopes.delete(scopes.keys().next().value);
    return host;
  };

  /**
   * The image to serve for a request on a picture-scope host, or null.
   * @param {string} host     the URL's hostname
   * @param {string} pathname the URL's pathname: "/" + one encoded reference
   */
  const resolve = (host, pathname) => {
    const scope = SCOPE_HOST.test(String(host)) ? scopes.get(host) : null;
    if (!scope || typeof pathname !== "string" || !pathname.startsWith("/")) return null;
    let raw;
    try { raw = decodeURIComponent(pathname.slice(1)); } catch { return null; }
    const ref = relativeRef(raw);
    if (!ref) return null;
    // The document's folder and nothing else: no workspace roots, no files
    // the user granted elsewhere. Realpath on both sides inside.
    return resolveImage(ref, { docDir: scope.docDir, roots: [], files: [], ...(realpath ? { realpath } : {}) });
  };

  const releaseOwner = (owner) => {
    for (const [host, scope] of scopes) if (scope.owner === owner) scopes.delete(host);
  };

  return { scopeFor, resolve, releaseOwner, isScopeHost: (host) => SCOPE_HOST.test(String(host)), size: () => scopes.size };
}

/**
 * One link per click. A renderer that asks to open a page many times a second
 * is not a person clicking, and a double click is still one link.
 * @param {{now?: () => number, minIntervalMs?: number}} [options]
 */
function createLinkGate({ now = Date.now, minIntervalMs = 400 } = {}) {
  let last = -Infinity;
  return {
    allow() {
      const at = now();
      if (at - last < minIntervalMs) return false;
      last = at;
      return true;
    },
  };
}

module.exports = { darkmownLinkTarget, blocksSrcdocNavigation, createDarkmownPictureScopes, createLinkGate, relativeRef };
