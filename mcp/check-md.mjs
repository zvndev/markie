// Reading a document the way Markie will, without a renderer.
//
// The failure this exists for is silent. A document that points at a picture in
// /tmp, or embeds a .pdf with image syntax, or wraps a heading in a <div>, opens
// with a hole in it and says nothing: nothing throws, nothing is logged, and the
// agent that wrote it has no way to find out. So the answer is computed from the
// text plus one stat per local target, which is cheap enough to run on every
// document before it is handed over.
//
// The rules here are copies, and copies only stay correct if the original is
// named. Targets are found with the regex from src/lib/attach.ts (localAssetCount),
// the displayable extensions come from the MIME maps in electron/local-assets.js,
// containment is the docDir half of its containedIn, block HTML is the line rule
// from src/lib/rich-hold-aside.ts, and the surviving inline set was measured
// against src/lib/rich-extensions.ts.
//
// Deliberately NOT a copy in one place: fenced code is skipped. localAssetCount
// counts targets inside fences because it is warning about sharing and would
// rather over-count, but a guide about markdown that shows `![](example.png)` in
// a fence is not a broken document and must not be reported as one.
// Self-contained: no imports from outside mcp/ (see the scan.mjs header).
import { existsSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// What Markie draws in place, from IMAGE/VIDEO/AUDIO_MIME_BY_EXT in
// electron/local-assets.js. Anything not in these three sets is a link.
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"]);
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".ogv", ".mov"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".oga", ".opus"]);

// The types Markie opens as documents rather than treating as an attachment.
// Mirrors OPENS_AS_DOCUMENT in src/lib/attach.ts and OPENABLE in
// electron/file-grants.js.
const DOCUMENT_RE = /\.(md|markdown|mdx|txt|csv)$/i;

// Image and link targets, both `![a](x)` and `[a](x)`, including the
// angle-bracket form a path with spaces needs. Straight from src/lib/attach.ts;
// the leading `!` is captured here because an embed and a link fail differently.
const MD_TARGET = /(!?)\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)/g;

// A fence opens a code block; nothing inside one is markup. From
// src/lib/rich-block-preserve.ts.
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

// A line that starts with a tag is an HTML *block*, which Markie holds aside
// rather than renders. From src/lib/rich-hold-aside.ts, where the same two
// patterns decide what gets lifted out of the text.
const BLOCK_HTML_OPEN = /^\s{0,3}<[a-zA-Z!/]/;
const BLOCK_COMMENT_OPEN = /^\s{0,3}<!--/;

// An opening tag, as CommonMark defines one: a name, then attributes, then an
// optional slash and the bracket. The strictness is load-bearing rather than
// pedantry. A loose "anything up to the next >" reads the angle-bracket link
// form, `![a](<demo/my shot.png>)`, as a <demo> tag and reports a document that
// is perfectly fine, which is exactly the kind of noise that gets a checker
// ignored.
const OPEN_TAG =
  /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;

// The CSS properties a <span> can carry into the file and back out again. Color,
// FontFamily and FontSize are the three text-style extensions in
// src/lib/rich-extensions.ts; a span whose style names none of them is unwrapped
// on the way in, which is why background-color is not here. Use <mark> for that.
const SURVIVING_STYLE_PROPS = new Set(["color", "font-family", "font-size"]);

// Tags the editor parses back into marks, so they survive a save. Measured
// 2026-09-05 by round-tripping through richBaseExtensions: everything else
// inline is unwrapped (its text stays, the tag goes).
const SURVIVING_TAGS = new Set(["mark", "u"]);

const kindForExt = (ext) => {
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
};

/** True when a <span>'s attributes name a style property that survives. */
function spanSurvives(attrs) {
  const style = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs || "");
  if (!style) return false;
  return (style[1] ?? style[2] ?? "")
    .split(";")
    .some((decl) => SURVIVING_STYLE_PROPS.has(decl.split(":")[0].trim().toLowerCase()));
}

function tagSurvives(tag, attrs) {
  const name = tag.toLowerCase();
  if (SURVIVING_TAGS.has(name)) return true;
  return name === "span" && spanSurvives(attrs);
}

// Blank out what is not markup, keeping every character position so line and
// column numbers still point at the source. Fenced code and inline code spans
// become spaces; the newlines that end their lines are kept so the line count
// never shifts.
function blankNonMarkup(markdown) {
  const lines = markdown.split(/(?<=\n)/);
  let fenceClose = null;
  const out = lines.map((line) => {
    const bare = line.replace(/\r?\n$/, "");
    const eol = line.slice(bare.length);
    if (fenceClose) {
      if (fenceClose.test(bare)) fenceClose = null;
      return " ".repeat(bare.length) + eol;
    }
    const fence = FENCE_OPEN.exec(bare);
    if (fence) {
      const ch = fence[1][0] === "`" ? "`" : "~";
      fenceClose = new RegExp(`^\\s{0,3}\\${ch}{${fence[1].length},}\\s*$`);
      return " ".repeat(bare.length) + eol;
    }
    // Inline code spans. The middle cannot hold a backtick, so `a` and `b` on
    // one line stay two spans instead of one that swallows the words between.
    return bare.replace(/`+[^`\n]*`+/g, (m) => " ".repeat(m.length)) + eol;
  });
  return out.join("");
}

// 1-based line numbers for a run of offsets. Built once and walked with a
// cursor rather than counting newlines per match, because a long document with
// many links would otherwise re-scan the whole text for every one of them.
function lineNumberer(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  let cursor = 0;
  return (index) => {
    while (cursor + 1 < starts.length && starts[cursor + 1] <= index) cursor++;
    return cursor + 1;
  };
}

// The absolute path a target claims, or null when it does not name a local file.
// Mirrors candidatePath and urlToRelativePath in electron/local-assets.js: the
// target is a URL, so `my%20shot.png` names a file with a space and `a.png?v=2`
// names the same file as `a.png`.
function localPathFor(target, docDir) {
  if (/^file:\/\//i.test(target)) {
    try {
      return fileURLToPath(target.split("#")[0].split("?")[0]);
    } catch {
      return null;
    }
  }
  const bare = target.split("#")[0].split("?")[0];
  if (!bare) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare; // a stray % is not a reason to give up on the path
  }
  return isAbsolute(decoded) ? resolve(decoded) : resolve(docDir, decoded);
}

function classifyTarget(raw, embed, docDir, exists) {
  const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  const base = { raw: target, embed };

  // Anything that names where it lives travels on its own: an anchor stays in
  // the document, a URL is a URL from anywhere, and a data URI is carried in the
  // text itself. Same three exemptions localAssetCount makes.
  if (!target) return { ...base, kind: "remote" };
  if (target.startsWith("#")) return { ...base, kind: "anchor" };
  if (target.startsWith("//")) return { ...base, kind: "remote" };
  if (/^data:/i.test(target)) return { ...base, kind: "data" };
  const isFileUrl = /^file:\/\//i.test(target);
  if (!isFileUrl && /^[a-z][a-z0-9+.-]*:/i.test(target)) return { ...base, kind: "remote" };

  const resolved = localPathFor(target, docDir);
  if (!resolved) return { ...base, kind: "remote" };

  const ext = extname(resolved).toLowerCase();
  const media = kindForExt(ext);
  const kind = media ?? (DOCUMENT_RE.test(resolved) ? "document" : "file");
  const insideDocFolder = resolved.startsWith(docDir.endsWith(sep) ? docDir : docDir + sep);
  return {
    ...base,
    kind,
    resolved,
    exists: exists(resolved),
    displayable: media !== null,
    insideDocFolder,
  };
}

function warningsFor(t) {
  const warnings = [];
  if (t.resolved === undefined) return warnings;
  if (!t.exists) {
    warnings.push("No file at this path, so nothing will display.");
  }
  if (t.embed && !t.displayable) {
    warnings.push(
      "Markie embeds pictures, video and audio only. This extension is none of those, so the embed shows nothing; link to it instead."
    );
  }
  if (!t.insideDocFolder) {
    warnings.push(
      "Outside the document's own folder, so it displays only if that location is inside one of the user's Markie workspace folders. This check cannot see which folders those are."
    );
  }
  return warnings;
}

// Every tag that will not render, with the line it is on. Two shapes of loss,
// and they are not the same thing for an author: an inline tag outside the
// surviving set keeps its text and loses its formatting, while a tag that starts
// a line makes a block, and a block keeps its bytes in the file but renders
// nowhere.
//
// Takes the blanked text, so code fences are already spaces and need no handling
// of their own here.
function findHtml(text) {
  const found = [];
  const lines = text.split(/(?<=\n)/);
  let skipUntilBlank = false;
  let skipUntilCommentEnd = false;

  for (let i = 0; i < lines.length; i++) {
    const bare = lines[i].replace(/\r?\n$/, "");
    if (skipUntilCommentEnd) {
      if (bare.includes("-->")) skipUntilCommentEnd = false;
      continue;
    }
    if (skipUntilBlank) {
      if (bare.trim() === "") skipUntilBlank = false;
      continue;
    }
    // A comment renders nowhere and is meant to render nowhere, so it is not a
    // finding. Markie keeps its bytes exactly as written.
    if (BLOCK_COMMENT_OPEN.test(bare)) {
      if (!bare.includes("-->")) skipUntilCommentEnd = true;
      continue;
    }
    if (BLOCK_HTML_OPEN.test(bare)) {
      const first = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(bare);
      found.push({
        tag: first ? first[1].toLowerCase() : "?",
        line: i + 1,
        form: "block",
        note: "A tag at the start of a line makes an HTML block. Markie keeps the bytes exactly as written but renders nothing: the editor shows a placeholder where the block was, and exports, PDFs and shared links drop it entirely, contents included.",
      });
      skipUntilBlank = true;
      continue;
    }
    // The line-start cases are gone, so anything left is inline. Comments in the
    // middle of a line are skipped for the same reason as block ones.
    const inline = bare.replace(/<!--[\s\S]*?-->/g, "");
    for (const m of inline.matchAll(OPEN_TAG)) {
      if (tagSurvives(m[1], m[2])) continue;
      found.push({
        tag: m[1].toLowerCase(),
        line: i + 1,
        form: "inline",
        note: `<${m[1].toLowerCase()}> is not markup Markie keeps. The text inside it stays and the tag is dropped on the next save.`,
      });
    }
  }
  return found;
}

function summarize(report) {
  const { counts } = report;
  const problems = [];
  for (const t of report.targets) {
    if (t.resolved === undefined) continue;
    // Both reasons, because a .mkv that is also missing needs moving AND
    // relinking, and hearing only the first one costs a second round trip.
    const why = [];
    if (!t.exists) why.push("no such file");
    if (t.embed && !t.displayable) why.push("not a kind Markie embeds");
    if (why.length) problems.push(`${t.raw} (${why.join(", ")})`);
  }
  for (const h of report.html) problems.push(`<${h.tag}> on line ${h.line} (${h.form})`);

  const scanned = `${counts.targets} target${counts.targets === 1 ? "" : "s"}, ${counts.html} HTML problem${counts.html === 1 ? "" : "s"}`;
  const head = report.ok
    ? `Everything in this document displays: ${scanned}.`
    : `${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}.`;
  const outside =
    counts.outsideFolder > 0
      ? ` ${counts.outsideFolder} target${counts.outsideFolder === 1 ? " sits" : "s sit"} outside the document's folder and will display only from inside a Markie workspace folder.`
      : "";
  return head + outside;
}

/**
 * Read a document the way Markie will and report what will not display.
 *
 * Static: the only thing it touches on disk is the existence of each local
 * target, through the injected `exists` so the analysis stays testable without
 * a filesystem (same shape as markieOpenCommand in lib.mjs).
 *
 * @param {string} markdown  the document's text
 * @param {string} docPath   the absolute path the document is saved at, which is
 *                           what relative targets resolve against
 * @param {object} [opts]    { exists }
 */
export function checkMarkdown(markdown, docPath, { exists = existsSync } = {}) {
  if (!docPath || typeof docPath !== "string") {
    throw new Error("checkMarkdown needs the document's absolute path");
  }
  const src = String(markdown ?? "");
  const docDir = resolve(docPath, "..");
  const scannable = blankNonMarkup(src);

  const targets = [];
  const lineOf = lineNumberer(scannable);
  for (const m of scannable.matchAll(MD_TARGET)) {
    const t = classifyTarget(m[2], m[1] === "!", docDir, exists);
    t.line = lineOf(m.index);
    const warnings = warningsFor(t);
    if (warnings.length) t.warnings = warnings;
    targets.push(t);
  }

  const html = findHtml(scannable);
  const local = targets.filter((t) => t.resolved !== undefined);
  const counts = {
    targets: targets.length,
    embeds: targets.filter((t) => t.embed).length,
    local: local.length,
    missing: local.filter((t) => !t.exists).length,
    undisplayable: local.filter((t) => t.embed && !t.displayable).length,
    outsideFolder: local.filter((t) => !t.insideDocFolder).length,
    html: html.length,
  };
  const report = {
    ok: counts.missing === 0 && counts.undisplayable === 0 && counts.html === 0,
    path: docPath,
    counts,
    targets,
    html,
  };
  report.summary = summarize(report);
  return report;
}
