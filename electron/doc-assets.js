// What a document embeds, found the way the local viewer finds it. A
// reference this module resolves is one Markie draws on this machine; one it
// skips is one Markie would refuse to draw, so nothing travels that a reader
// here could not already see.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const localAssets = require("./local-assets");

const MAX_ASSET_BYTES = 100 * 1024 * 1024;

// A markdown image, then the src of an img, video, audio or source tag in raw
// HTML. Fenced and inline code are cut out first so an example is not an
// embed.
const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
// Two destination forms, because CommonMark has two: `<...>`, which is how a
// name with a space in it is written and which the local renderer already
// draws, and the bare form, which cannot contain whitespace.
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>\n]*)>|([^\s)>]+))(?:\s+"[^"]*")?\s*\)/g;
// Whitespace before `src`, not a word boundary: \b matches after the hyphen
// in `data-src`, so a lazy-loading attribute named a file the document does
// not render and Markie uploaded it.
const HTML_SRC = /<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function isLocal(src) {
  return !!src && !src.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

function refOf(src) {
  const bare = src.trim().split("#")[0].split("?")[0];
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

function extractRefs(markdown) {
  const text = String(markdown ?? "").replace(FENCE, "");
  // Both patterns are collected with their position, then merged, so two refs
  // that come from different syntaxes still land in the order the document
  // actually wrote them.
  const found = [];
  for (const m of text.matchAll(MD_IMAGE)) found.push({ index: m.index, src: m[1] ?? m[2] });
  for (const m of text.matchAll(HTML_SRC)) found.push({ index: m.index, src: m[1] ?? m[2] ?? m[3] });
  found.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const out = [];
  for (const { src } of found) {
    if (!isLocal(src)) continue;
    const ref = refOf(src);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

// One entry per ref: the allowed real path and its mime, or why not.
// "type" is a file Markie does not embed; "outside" is anything the local
// viewer would refuse, a missing file included, since the answer to the
// reader is the same either way.
function resolveRefs(refs, { docPath, roots = [], files = [] }) {
  const docDir = path.dirname(docPath);
  return refs.map((ref) => {
    if (!localAssets.mediaMimeFor(ref)) return { ref, skipped: "type" };
    const found = localAssets.resolveMedia(ref, { docDir, roots, files });
    if (!found) return { ref, skipped: "outside" };
    return { ref, path: found.path, mime: found.mime };
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hasher = crypto.createHash("sha256");
    let size = 0;
    fs.createReadStream(filePath)
      .on("data", (chunk) => {
        size += chunk.length;
        hasher.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve({ hash: hasher.digest("hex"), size }));
  });
}

// One string for "these refs at these hashes", so an unchanged document costs
// no request at all on the next push. Entries are `{ ref, hash? }` and cover
// the document's whole reference set: a ref nothing resolved, or one that was
// skipped, contributes an empty hash rather than being left out. Leaving it
// out made "one unresolvable picture" and "no pictures at all" the same
// string, so removing the reference never looked like a change and the old
// asset stayed linked on the server.
function fingerprint(entries) {
  const lines = entries.map((e) => `${e.ref}\t${e.hash ?? ""}`).sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

module.exports = { MAX_ASSET_BYTES, extractRefs, resolveRefs, hashFile, fingerprint };
