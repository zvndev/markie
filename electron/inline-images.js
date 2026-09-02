// Turn a document's local images into data: URIs before it is exported.
//
// An exported PDF or a standalone HTML file is meant to be handed to someone
// else. `<img src="diagram.png">` resolves against wherever the file happens to
// sit, so the moment the export leaves the folder the pictures are gone — and
// in the PDF exporter the render happens from a temp directory, so they were
// never there in the first place.
//
// Inlining is also a way to leak a file the user never meant to send, so which
// files may be read is not decided here: local-assets.js owns that rule, and
// the viewer's markie-asset:// handler asks it the same question. What is left
// here is the part that is only about exporting, which is the size at which an
// export stops being a file somebody can email.
//
// Dependency-free and injectable, like crash-log.js: nothing here touches
// Electron, so it can be unit tested without the binary.

const nodeFs = require("fs");
const { imageMimeFor, resolveImage } = require("./local-assets");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // one picture
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // the whole document

const IMG_TAG = /<img\b[^>]*>/gi;
// Quoted src only. An unquoted or templated src is not something to rewrite by
// pattern matching; those tags are left exactly as they were.
const SRC_ATTR = /(\ssrc\s*=\s*)(["'])([^"']*)\2/i;

/**
 * Rewrite local <img src> values in `html` to data: URIs.
 *
 * @param {string} html      the document HTML
 * @param {string} docDir    the folder the document was loaded from
 * @param {object} [opts]    { roots, fs, realpath, maxImageBytes, maxTotalBytes }
 * @returns {string}         html with the images it could safely inline
 */
function inlineLocalImages(html, docDir, opts = {}) {
  const source = html == null ? "" : String(html);
  if (!docDir || !source.includes("<img")) return source;

  const {
    roots = [],
    fs = nodeFs,
    realpath = (p) => fs.realpathSync(p),
    maxImageBytes = MAX_IMAGE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = opts;

  const cache = new Map();
  let total = 0;

  function dataUriFor(src) {
    if (cache.has(src)) return cache.get(src);
    let uri = null;
    try {
      const found = resolveImage(src, { docDir, roots, realpath });
      if (found) {
        const bytes = fs.readFileSync(found.path);
        const size = bytes.length;
        if (size <= maxImageBytes && total + size <= maxTotalBytes) {
          total += size;
          uri = `data:${found.mime};base64,${Buffer.from(bytes).toString("base64")}`;
        }
      }
    } catch {
      // Unreadable, missing, or a broken symlink: leave the tag as it was.
      uri = null;
    }
    cache.set(src, uri);
    return uri;
  }

  return source.replace(IMG_TAG, (tag) => {
    const attr = SRC_ATTR.exec(tag);
    if (!attr) return tag;
    const [, prefix, quote, src] = attr;
    const uri = dataUriFor(src);
    if (!uri) return tag;
    return tag.replace(attr[0], `${prefix}${quote}${uri}${quote}`);
  });
}

module.exports = {
  inlineLocalImages,
  // Re-exported so existing callers and tests keep one import.
  imageMimeFor,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
};
