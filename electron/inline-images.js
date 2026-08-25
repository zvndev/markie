// Turn a document's local images into data: URIs before it is exported.
//
// An exported PDF or a standalone HTML file is meant to be handed to someone
// else. `<img src="diagram.png">` resolves against wherever the file happens to
// sit, so the moment the export leaves the folder the pictures are gone — and
// in the PDF exporter the render happens from a temp directory, so they were
// never there in the first place.
//
// Inlining is also a way to leak a file the user never meant to send, so the
// rules are narrow: only images that really live inside the document's own
// folder, resolved through realpath so a symlink cannot point out of it, and
// only up to a size where the export is still a file somebody can email.
//
// Dependency-free and injectable, like crash-log.js: nothing here touches
// Electron, so it can be unit tested without the binary.

const nodeFs = require("fs");
const nodePath = require("path");
const { fileURLToPath } = require("url");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // one picture
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // the whole document

// Only formats a browser renders from a data: URI. Anything else — .bmp, .tif,
// a stray .html — is left as a plain src rather than guessed at.
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const IMG_TAG = /<img\b[^>]*>/gi;
// Quoted src only. An unquoted or templated src is not something to rewrite by
// pattern matching; those tags are left exactly as they were.
const SRC_ATTR = /(\ssrc\s*=\s*)(["'])([^"']*)\2/i;

function mimeFor(filePath) {
  return MIME_BY_EXT[nodePath.extname(filePath).toLowerCase()] || null;
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

// Returns an absolute path this src *claims* to mean, or null when the src is
// not a local file reference at all (http, https, data:, mailto:, protocol
// relative, absolute path outside the folder).
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
  // An absolute path is not a document-relative image. It still has to survive
  // the containment check below, which is what actually decides.
  return nodePath.resolve(docDir, rel);
}

// Symlinks are resolved on both sides first: a link inside the folder that
// points at ~/.ssh/id_rsa.png would otherwise pass a plain string comparison.
function containedIn(realDir, realFile) {
  if (!realDir || !realFile) return false;
  if (realFile === realDir) return false;
  return realFile.startsWith(realDir.endsWith(nodePath.sep) ? realDir : realDir + nodePath.sep);
}

/**
 * Rewrite local <img src> values in `html` to data: URIs.
 *
 * @param {string} html      the document HTML
 * @param {string} docDir    the folder the document was loaded from
 * @param {object} [opts]    { fs, realpath, maxImageBytes, maxTotalBytes }
 * @returns {string}         html with the images it could safely inline
 */
function inlineLocalImages(html, docDir, opts = {}) {
  const source = html == null ? "" : String(html);
  if (!docDir || !source.includes("<img")) return source;

  const {
    fs = nodeFs,
    realpath = (p) => fs.realpathSync(p),
    maxImageBytes = MAX_IMAGE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = opts;

  let realDir;
  try {
    realDir = realpath(nodePath.resolve(docDir));
  } catch {
    return source; // the folder is gone; nothing can be inlined from it
  }

  const cache = new Map();
  let total = 0;

  function dataUriFor(absPath) {
    if (cache.has(absPath)) return cache.get(absPath);
    let uri = null;
    try {
      const mime = mimeFor(absPath);
      if (mime) {
        const real = realpath(absPath);
        if (containedIn(realDir, real) && mimeFor(real)) {
          const bytes = fs.readFileSync(real);
          const size = bytes.length;
          if (size <= maxImageBytes && total + size <= maxTotalBytes) {
            total += size;
            uri = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
          }
        }
      }
    } catch {
      // Unreadable, missing, or a broken symlink: leave the tag as it was.
      uri = null;
    }
    cache.set(absPath, uri);
    return uri;
  }

  return source.replace(IMG_TAG, (tag) => {
    const attr = SRC_ATTR.exec(tag);
    if (!attr) return tag;
    const [, prefix, quote, src] = attr;
    const abs = candidatePath(src, realDir);
    if (!abs) return tag;
    const uri = dataUriFor(abs);
    if (!uri) return tag;
    return tag.replace(attr[0], `${prefix}${quote}${uri}${quote}`);
  });
}

module.exports = {
  inlineLocalImages,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
};
