// The document links a markdown file makes, and what they point at.
//
// `[the plan](plan.md)` names a file beside this one. If that file is a
// document this Markie syncs, the registry knows its cloud id, and the pair
// (ref, id) is what travels: a pointer the server hands to readers who may
// follow it. Nothing here reads the target file; the registry row is the
// whole answer.
//
// Shares the fence strip, the locality test and the reference rules with
// doc-assets.js so a link and a picture written the same way are read the
// same way.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MAX_EXTRACT_CHARS, MAX_REF_CHARS, isLocal, refOf, refIsMalformed } = require("./doc-assets");

const MAX_DOC_LINKS = 500;
// What Markie opens and lands: the same set electron/main.js accepts for a
// landed document's name.
const DOC_EXT = /\.(md|markdown|mdx|txt)$/i;

const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
// An inline link. The lookbehind keeps images out: `![alt](x.md)` is a
// picture whatever its extension says. The bare destination is bounded for
// the same reason doc-assets.js bounds its image pattern (quadratic
// backtracking on text with no closing paren).
const MD_LINK = new RegExp(
  `(?<!!)\\[[^\\]]*\\]\\(\\s*(?:<([^>\\n]*)>|([^\\s)>]{1,${MAX_REF_CHARS}}))(?:\\s+"[^"]*")?\\s*\\)`,
  "g"
);
// A reference definition at the start of a line: `[label]: dest`.
const REF_DEF = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;
// Whitespace before `href`, not a word boundary, so `data-href` is not read.
const HTML_HREF = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function isDocRef(ref) {
  return DOC_EXT.test(String(ref ?? ""));
}

function extractLinks(markdown) {
  const source = String(markdown ?? "");
  if (source.length > MAX_EXTRACT_CHARS) return [];
  const text = source.replace(FENCE, "");
  const found = [];
  for (const m of text.matchAll(MD_LINK)) found.push({ index: m.index, dest: m[1] ?? m[2] });
  for (const m of text.matchAll(REF_DEF)) found.push({ index: m.index, dest: m[1] ?? m[2] });
  for (const m of text.matchAll(HTML_HREF)) found.push({ index: m.index, dest: m[1] ?? m[2] ?? m[3] });
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const { dest } of found) {
    if (out.length >= MAX_DOC_LINKS) break;
    if (!isLocal(dest)) continue;
    const ref = refOf(dest);
    if (!ref || refIsMalformed(ref) || !isDocRef(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

function defaultRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Order-free, so two machines with the same links agree, and the empty set
// has a fingerprint of its own so "never pushed" and "pushed nothing" differ
// (the row's links_fingerprint is null until the first push).
function linkFingerprint(links) {
  const pairs = links.map((l) => [l.ref, l.target]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

// One pair per ref that resolves to a document the registry knows by cloud
// id. The path is taken through realpath when the file exists, because the
// registry tracks real paths; a file that is gone from disk is looked up as
// written, since its row may still be there with the cloud copy behind it.
function resolveLinks(refs, { docPath, registry, realpath = defaultRealpath }) {
  const docDir = path.dirname(docPath);
  const links = [];
  for (const ref of refs) {
    const abs = path.resolve(docDir, ref);
    const row = registry.get(realpath(abs));
    if (row && row.cloud_doc_id) links.push({ ref, target: row.cloud_doc_id });
  }
  return { links, fingerprint: linkFingerprint(links) };
}

module.exports = { MAX_DOC_LINKS, MAX_EXTRACT_CHARS, DOC_EXT, isDocRef, extractLinks, resolveLinks, linkFingerprint };
