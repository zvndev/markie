// Plain text for search, pulled out of every document type Markie indexes.
//
// The device index only carries a short head of small text files, which is
// enough to filter a list and not enough to find a sentence inside a report.
// Global search asks for this instead: the readable text of a file, extracted
// on demand, bounded, and cached by (path, mtime, size) so a second query
// over the same files costs no disk reads.
//
// Extraction is deliberately lossy and read-only. It never decides what a
// document says for editing purposes; the real codecs in src/lib/office do
// that. A search hit only has to be honest about the words being present.
const fs = require("fs");
const zlib = require("zlib");

const fsp = fs.promises;

const TEXT_FORMATS = new Set(["markdown", "darkmown", "text", "csv", "json", "yaml", "xml"]);
// Per-format ceilings on the bytes read from disk. Past these a file is still
// found by name, path and type, just not by its body.
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_RTF_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
// One inflated part (document.xml / content.xml). Bounds a ZIP bomb without
// needing to trust the sizes the archive claims.
const MAX_PART_BYTES = 24 * 1024 * 1024;
// What survives in memory per file and across the cache.
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const CACHE_BUDGET_CHARS = 48 * 1024 * 1024;

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ENTITY[body.toLowerCase()] ?? whole;
  });
}

function tidy(text) {
  return text.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim().slice(0, MAX_TEXT_CHARS);
}

// Read one named part from a ZIP package. Read-only and bounded: the central
// directory is walked for the name, and the part is inflated with a hard
// output ceiling so a lying size field cannot expand past MAX_PART_BYTES.
function zipPart(bytes, wanted) {
  if (bytes.length < 22) return null;
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) return null;
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count && cursor + 46 <= bytes.length; index++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) return null;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameSize);
    cursor += 46 + nameSize + extraSize + commentSize;
    if (name !== wanted) continue;
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) return null;
    const data = bytes.subarray(start, start + compressed);
    try {
      if (method === 0) return data.length <= MAX_PART_BYTES ? data.toString("utf8") : null;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString("utf8");
    } catch {
      return null;
    }
    return null;
  }
  return null;
}

function docxText(xml) {
  return tidy(decodeEntities(
    xml
      // Field instructions and deleted revisions are not words on the page.
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "")
      .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "")
      .replace(/<w:tab\/>/g, " ")
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ));
}

function odtText(xml) {
  return tidy(decodeEntities(
    xml
      .replace(/<office:(?:font-face-decls|automatic-styles)\b[\s\S]*?<\/office:(?:font-face-decls|automatic-styles)>/g, "")
      .replace(/<text:(?:tab|s)\b[^>]*\/>/g, " ")
      .replace(/<text:line-break\b[^>]*\/>/g, "\n")
      .replace(/<\/text:(?:p|h)>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ));
}

function htmlText(html) {
  return tidy(decodeEntities(
    html
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ));
}

// Destinations whose content is never body text: tables of fonts, colors and
// styles, document info, pictures, and anything marked ignorable with \*.
const RTF_SKIP = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "listtable", "listoverridetable", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "rsidtbl", "generator", "header", "footer", "headerl", "headerr", "footerl", "footerr", "object", "fldinst"]);
const CP1252 = new Map([[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x2c6], [0x89, 0x2030], [0x8a, 0x160], [0x8b, 0x2039], [0x8c, 0x152], [0x8e, 0x17d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x2dc], [0x99, 0x2122], [0x9a, 0x161], [0x9b, 0x203a], [0x9c, 0x153], [0x9e, 0x17e], [0x9f, 0x178]]);

function rtfText(source) {
  const out = [];
  const stack = [];
  let skip = false;
  let unicodeSkip = 1;
  let pendingSkip = 0;
  let groupStart = false;
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === "{") { stack.push({ skip, unicodeSkip }); groupStart = true; i++; continue; }
    if (char === "}") { const prev = stack.pop(); if (prev) { skip = prev.skip; unicodeSkip = prev.unicodeSkip; } groupStart = false; i++; continue; }
    if (char === "\\") {
      const next = source[i + 1];
      if (next === "*") { skip = true; i += 2; continue; }
      if (next === "'") {
        const code = parseInt(source.slice(i + 2, i + 4), 16);
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip && Number.isFinite(code)) out.push(String.fromCharCode(CP1252.get(code) ?? code));
        i += 4; groupStart = false; continue;
      }
      if (next === "\\" || next === "{" || next === "}") { if (!skip) out.push(next); i += 2; groupStart = false; continue; }
      if (next === "~") { if (!skip) out.push(" "); i += 2; continue; }
      if (next === "\n" || next === "\r") { if (!skip) out.push("\n"); i += 2; continue; }
      const match = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(source.slice(i, i + 48));
      if (!match) { i += 2; continue; }
      const [whole, word, arg] = match;
      i += whole.length;
      if (groupStart && RTF_SKIP.has(word)) skip = true;
      groupStart = false;
      if (skip) continue;
      if (word === "par" || word === "line" || word === "row" || word === "sect" || word === "page") out.push("\n");
      else if (word === "tab" || word === "cell") out.push(" ");
      else if (word === "uc") unicodeSkip = Math.max(0, Number(arg) || 0);
      else if (word === "u") {
        let code = Number(arg);
        if (code < 0) code += 65536;
        if (Number.isFinite(code)) out.push(String.fromCharCode(code));
        pendingSkip = unicodeSkip;
      } else if (word === "bin") {
        i += Math.max(0, Number(arg) || 0);
      }
      continue;
    }
    groupStart = false;
    if (char === "\r" || char === "\n") { i++; continue; }
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    if (!skip) out.push(char);
    i++;
  }
  return tidy(out.join(""));
}

function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.toString("utf16le", 2);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.includes("\0") ? null : text.replace(/^﻿/, "");
}

/** Readable text from document bytes, or null when the format has none to offer. */
function textFromBytes(bytes, format) {
  if (TEXT_FORMATS.has(format)) {
    const text = decodeText(bytes);
    return text === null ? null : text.slice(0, MAX_TEXT_CHARS);
  }
  if (format === "docx") { const xml = zipPart(bytes, "word/document.xml"); return xml === null ? null : docxText(xml); }
  if (format === "odt") { const xml = zipPart(bytes, "content.xml"); return xml === null ? null : odtText(xml); }
  if (format === "rtf") return rtfText(bytes.toString("latin1"));
  if (format === "html") return htmlText(bytes.toString("utf8"));
  // Legacy .doc is a compound binary file; its text is only trusted through
  // the real reader when the document is opened.
  return null;
}

function byteLimit(format) {
  if (TEXT_FORMATS.has(format)) return MAX_TEXT_BYTES;
  if (format === "docx" || format === "odt") return MAX_PACKAGE_BYTES;
  if (format === "rtf") return MAX_RTF_BYTES;
  if (format === "html") return MAX_HTML_BYTES;
  return 0;
}

function createTextCache({ budget = CACHE_BUDGET_CHARS } = {}) {
  const entries = new Map();
  let used = 0;
  return {
    get(key, stamp) {
      const hit = entries.get(key);
      if (!hit || hit.stamp !== stamp) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit.text;
    },
    set(key, stamp, text) {
      const prior = entries.get(key);
      if (prior) { used -= prior.size; entries.delete(key); }
      const size = text ? text.length : 0;
      entries.set(key, { stamp, text, size });
      used += size;
      for (const [oldest, value] of entries) {
        if (used <= budget) break;
        entries.delete(oldest);
        used -= value.size;
      }
    },
    get size() { return entries.size; },
    get used() { return used; },
  };
}

const sharedCache = createTextCache();

/** Extract (and cache) a file's search text. Resolves null when there is none. */
async function extractSearchText(filePath, format, { cache = sharedCache } = {}) {
  const limit = byteLimit(format);
  if (!limit) return null;
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size > limit) return null;
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(filePath, stamp);
  if (cached !== undefined) return cached;
  let text = null;
  try { text = textFromBytes(await fsp.readFile(filePath), format); } catch { text = null; }
  cache.set(filePath, stamp, text);
  return text;
}

function terms(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

// A window of text around the first hit, with the hit offsets inside that
// window so the renderer can mark them without searching again.
function excerpt(text, needles, radius = 70) {
  const lower = text.toLowerCase();
  let at = -1;
  let length = 0;
  for (const needle of needles) {
    const index = lower.indexOf(needle);
    if (index >= 0 && (at < 0 || index < at)) { at = index; length = needle.length; }
  }
  if (at < 0) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + length + radius);
  const raw = text.slice(start, end).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const window = prefix + raw.trim() + (end < text.length ? "…" : "");
  const lowerWindow = window.toLowerCase();
  const marks = [];
  for (const needle of needles) {
    let from = 0;
    while (marks.length < 12) {
      const index = lowerWindow.indexOf(needle, from);
      if (index < 0) break;
      marks.push([index, index + needle.length]);
      from = index + needle.length;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  return { text: window, marks };
}

let generation = 0;

/**
 * @typedef {{ path: string, name: string, dir: string, format: string, mtimeMs: number, nameHit: boolean, excerpt?: string, marks?: Array<[number, number]> }} SearchHit
 * @typedef {{ results: SearchHit[], scanned: number, total: number, partial: boolean, superseded?: boolean }} SearchResponse
 */

/**
 * Search indexed rows by name, path and body text. Recent files are searched
 * first, so a time-capped search spends its budget where hits are likeliest.
 * A newer call supersedes an older one still in flight.
 * @param {Array<{ path: string, name: string, dir: string, format: string, mtimeMs: number }>} rows
 * @param {string} query
 * @param {{ formats?: string[] | null, limit?: number, maxMs?: number, now?: () => number, cache?: ReturnType<typeof createTextCache> }} [options]
 * @returns {Promise<SearchResponse>}
 */
async function searchDocuments(rows, query, {
  formats = null,
  limit = 60,
  maxMs = 1800,
  now = Date.now,
  cache = sharedCache,
} = {}) {
  const mine = ++generation;
  const needles = terms(query);
  const allowed = Array.isArray(formats) && formats.length ? new Set(formats) : null;
  const pool = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.path === "string" && (!allowed || allowed.has(row.format)))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  if (!needles.length) {
    return { results: pool.slice(0, limit).map((row) => ({ path: row.path, name: row.name, dir: row.dir, format: row.format, mtimeMs: row.mtimeMs, nameHit: false })), scanned: 0, total: pool.length, partial: false };
  }
  const startedAt = now();
  const results = [];
  let scanned = 0;
  let partial = false;
  for (const row of pool) {
    if (mine !== generation) return { superseded: true, results: [], scanned, total: pool.length, partial: true };
    const name = String(row.name || "").toLowerCase();
    const where = String(row.path || "").toLowerCase();
    const nameHit = needles.every((needle) => name.includes(needle));
    const pathHit = needles.every((needle) => where.includes(needle));
    let body = null;
    let bodyHit = false;
    if (!partial && byteLimit(row.format)) {
      if (now() - startedAt > maxMs) partial = true;
      else {
        body = await extractSearchText(row.path, row.format, { cache });
        scanned += 1;
        if (body) {
          const lower = body.toLowerCase();
          bodyHit = needles.every((needle) => lower.includes(needle) || name.includes(needle));
        }
      }
    }
    if (!nameHit && !pathHit && !bodyHit) continue;
    const match = bodyHit && body ? excerpt(body, needles) : null;
    results.push({
      path: row.path,
      name: row.name,
      dir: row.dir,
      format: row.format,
      mtimeMs: row.mtimeMs,
      nameHit,
      excerpt: match?.text,
      marks: match?.marks,
      score: (nameHit ? 4 : 0) + (bodyHit ? 2 : 0) + (pathHit ? 1 : 0),
    });
    if (results.length >= limit * 3) { partial = true; break; }
  }
  results.sort((a, b) => b.score - a.score || (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return { results: results.slice(0, limit).map(({ score: _score, ...rest }) => rest), scanned, total: pool.length, partial };
}

module.exports = {
  TEXT_FORMATS, textFromBytes, extractSearchText, searchDocuments, createTextCache, excerpt,
  rtfText, docxText, odtText, htmlText, zipPart,
};
