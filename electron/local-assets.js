// Which files on this machine a document is allowed to show, and where that
// rule lives.
//
// Two places need the answer and they must never disagree: the viewer, which
// serves an image to the renderer over markie-asset://, and the exporter, which
// folds the same image into a data: URI so an exported file can travel. If they
// drift you get a picture on screen that vanishes from the PDF, which is worse
// than either behaviour on its own. So the rule is written once, here.
//
// The rule: a referenced file has to resolve, through realpath on both sides so
// a symlink cannot point out, to something strictly inside either
//
//   - the folder the document itself was opened from, or
//   - one of the user's workspace roots.
//
// The first is what makes `![](demo/shot.png)` work, which is how anyone
// actually writes a report. The second is what makes `![](../assets/logo.png)`
// work, which is how a repository actually stores its pictures. Nothing else is
// reachable: open a markdown file someone sent you and it cannot show you a
// picture from anywhere else on your disk, so it cannot quietly carry one into
// a document you then export and send on.
//
// Dependency-free and injectable, like crash-log.js: nothing here touches
// Electron, so it can be tested without the binary.

const nodeFs = require("fs");
const nodePath = require("path");
const { fileURLToPath } = require("url");

// Only formats a browser renders. Anything else (.bmp, .tif, a stray .html) is
// left alone rather than guessed at, and extension is the whole test: sniffing
// content would mean deciding to serve a file before knowing what it is.
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

function imageMimeFor(filePath) {
  return IMAGE_MIME_BY_EXT[nodePath.extname(String(filePath || "")).toLowerCase()] || null;
}

// The src is a URL, not a path: `my%20image.png` names a file with a space, and
// `a.png?v=2` and `a.png#top` name the same file as `a.png`.
function urlToRelativePath(src) {
  const withoutHash = src.split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  if (!withoutQuery) return null;
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery; // a stray % is not a reason to drop the image
  }
}

// The absolute path a src *claims* to mean, or null when it is not a local file
// reference at all. Claiming is all this does; containedIn decides.
function candidatePath(src, docDir) {
  const raw = String(src || "").trim();
  if (!raw) return null;
  if (raw.startsWith("//")) return null; // protocol relative: remote

  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw.split("#")[0].split("?")[0]);
    } catch {
      return null;
    }
  }
  // Any other scheme (http:, https:, data:, blob:, mailto:) is left alone.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  const rel = urlToRelativePath(raw);
  if (!rel) return null;
  // An absolute path is not a document-relative reference, but it still has to
  // survive containment below, which is what actually decides.
  return nodePath.resolve(docDir, rel);
}

// Symlinks are resolved on both sides first: a link inside the folder pointing
// at ~/.ssh/id_rsa.png would otherwise pass a plain string comparison.
function containedIn(realDir, realFile) {
  if (!realDir || !realFile) return false;
  if (realFile === realDir) return false;
  return realFile.startsWith(realDir.endsWith(nodePath.sep) ? realDir : realDir + nodePath.sep);
}

/**
 * Resolve one absolute path against the allowed roots.
 *
 * @param {string} absPath   an already-resolved absolute path
 * @param {object} opts      { docDir, roots, fs, realpath }
 * @returns {string|null}    the realpath to serve, or null
 */
function allowedRealPath(absPath, { docDir = null, roots = [], realpath = (p) => nodeFs.realpathSync(p) } = {}) {
  if (!absPath) return null;
  let real;
  try {
    real = realpath(absPath);
  } catch {
    return null; // missing, or a broken symlink
  }
  const bounds = [];
  for (const dir of [docDir, ...roots]) {
    if (!dir) continue;
    try {
      bounds.push(realpath(nodePath.resolve(dir)));
    } catch {
      // A root that no longer exists bounds nothing.
    }
  }
  return bounds.some((bound) => containedIn(bound, real)) ? real : null;
}

/**
 * Resolve a document's image reference to a file that may be shown.
 *
 * @param {string} src       the src as written in the document
 * @param {object} opts      { docDir, roots, realpath }
 * @returns {{path: string, mime: string}|null}
 */
function resolveImage(src, opts = {}) {
  const { docDir } = opts;
  if (!docDir) return null;
  const abs = candidatePath(src, docDir);
  if (!abs) return null;
  // Checked before the filesystem is touched and again on the realpath, so a
  // symlink cannot swap a .png for something else on the way through.
  if (!imageMimeFor(abs)) return null;
  const real = allowedRealPath(abs, opts);
  if (!real) return null;
  const mime = imageMimeFor(real);
  return mime ? { path: real, mime } : null;
}

module.exports = {
  IMAGE_MIME_BY_EXT,
  allowedRealPath,
  candidatePath,
  containedIn,
  imageMimeFor,
  resolveImage,
  urlToRelativePath,
};
