// Reading a document the way Markie will, without a renderer.
//
// The failure this exists for is silent. A document that points at a picture in
// /tmp, or embeds a .pdf with image syntax, or carries a <script> nothing will
// ever run, opens with a hole in it and says nothing: nothing throws, nothing is
// logged, and the agent that wrote it has no way to find out. So the answer is
// computed from the text plus one stat per local target, which is cheap enough
// to run on every document before it is handed over.
//
// Two places render a document and they do not agree, so every HTML finding
// says both halves: what Rich does with the tag, and what an export or a shared
// page does. Only a tag that renders in neither is a failure; the rest are
// warnings, because "your kbd will come back as plain text once you edit that
// paragraph" is worth knowing and is not a broken document.
//
// The rules here are copies, and copies only stay correct if the original is
// named. Targets are found with the two regexes from src/lib/attach.ts
// (localAssetCount), the displayable extensions come from the MIME maps in
// electron/local-assets.js, containment is the docDir half of its containedIn,
// block HTML is the line rule from src/lib/rich-hold-aside.ts, the two shapes
// the editor owns are src/lib/rich-media-html.ts, and both HTML fates were
// measured against src/lib/rich-extensions.ts and src/lib/markdown-html.ts.
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
// A picture or clip with a chosen width is written as its HTML tag, so its src
// is a local file exactly as much as `![](…)` is. Also from src/lib/attach.ts.
const HTML_SRC = /<(?:img|video|audio|source)\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

// A fence opens a code block; nothing inside one is markup. From
// src/lib/rich-block-preserve.ts.
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

// A line that starts with a tag is an HTML *block*, which Markie holds aside
// rather than renders. From src/lib/rich-hold-aside.ts, where the same two
// patterns decide what gets lifted out of the text.
const BLOCK_HTML_OPEN = /^\s{0,3}<[a-zA-Z!/]/;
const BLOCK_COMMENT_OPEN = /^\s{0,3}<!--/;

// The two block shapes the rich editor writes itself and reads back as its own
// nodes, so they are drawn rather than held aside. Copied from
// src/lib/rich-media-html.ts (isLoneMediaTag, isAlignedBlockTag); the quoting
// and the "nothing else on the line" part are load-bearing, which is why the
// guide tells an author to write exactly this shape.
const LONE_MEDIA_TAG =
  /^\s{0,3}<(img|video|audio)\b(?:\s+[^\s"'<>=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*\s*\/?>(?:\s*<\/(?:video|audio)\s*>)?\s*$/i;
const ALIGNED_BLOCK =
  /^\s{0,3}<(p|h[1-6])\s+style="text-align:\s*(?:center|right|justify|left);?"\s*>.*<\/\1\s*>\s*$/i;

const isEditorOwnHtmlBlock = (line) => LONE_MEDIA_TAG.test(line) || ALIGNED_BLOCK.test(line);

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
// src/lib/rich-extensions.ts; a span whose style names none of them loses the
// style on the way in, which is why background-color is not here. Use <mark>.
const SURVIVING_STYLE_PROPS = new Set(["color", "font-family", "font-size"]);

// Tags the editor parses back into marks, so the file keeps them as written.
const SURVIVING_TAGS = new Set(["mark", "u"]);

// Tags the editor turns into the markdown that means the same thing. Nothing is
// lost: `<b>x</b>` comes back as `**x**` once that paragraph is edited.
const REWRITTEN_TAGS = new Set(["b", "i", "strong", "em", "del", "s", "strike", "code", "br", "a"]);

// Never rendered, anywhere: not by the editor, and dropped by the sanitizer that
// every export, print, PDF and shared page runs through
// (src/lib/markdown-html.ts, server/src/render.ts). The document keeps the bytes
// and no reader ever sees them, which is the worst of both. Measured, not
// assumed: <input> is NOT here, because the default schema keeps it (that is
// how a task list gets its checkbox), and neither is <svg>, which the schema
// allows for equations.
const DROPPED_TAGS = new Set(["script", "iframe", "style", "object", "embed", "form", "link", "meta", "base", "noscript"]);

// A picture or clip in the middle of a line. Neither dropped nor unwrapped: the
// editor has a node for it and gives it a line of its own.
const MEDIA_TAGS = new Set(["img", "video", "audio", "source"]);

// What survives the export sanitizer: hast-util-sanitize's GitHub-derived
// default tagNames (as re-exported by rehype-sanitize), plus the tags
// src/lib/markdown-html.ts adds for the editor's own marks and for media. A tag
// outside this set has its element dropped and its text kept, so `<small>x`
// exports as a bare x. Pinned by a test rather than imported, because mcp/ ships
// without dependencies and must run from a bare Node.
const EXPORT_RENDERS = new Set([
  "a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "ol",
  "p", "picture", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "source", "span",
  "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "tt", "ul", "var",
  // What src/lib/markdown-html.ts adds on top. The MathML element names are in
  // that list too and are left out here: rehype-katex emits them from `$x$`,
  // nobody writes them by hand.
  "mark", "u", "video", "audio", "source", "div", "span",
  "svg", "path", "line", "g", "defs", "use", "rect", "polyline", "math",
]);

// An attribute that runs script. The sanitizer drops it and the editor never
// keeps it, so it is dead weight wherever it is written.
const EVENT_ATTR = /\son[a-z]+\s*=/i;

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

// Why a tag renders nowhere. <style> earns its own sentence: the sanitizer drops
// the element and keeps its children, so the CSS itself comes out as visible
// text in an export, which is worse than losing it.
function droppedNote(name) {
  if (name === "style") {
    return "<style> renders nowhere, and worse: the export keeps the CSS inside it as visible text on the page. Style a document with the inline forms Markie writes.";
  }
  return `<${name}> renders nowhere. The editor never draws it and the export sanitizer drops it, so the markup sits in the file and no reader ever sees it.`;
}

// What becomes of one inline tag, as a pair: what Rich does, and what an export
// does. Returns null when the tag is kept as written on both sides, which is the
// only case worth saying nothing about.
function inlineFate(tag, attrs) {
  const name = tag.toLowerCase();
  const exported = EXPORT_RENDERS.has(name);
  if (DROPPED_TAGS.has(name)) {
    return { effect: "dropped", note: droppedNote(name) };
  }
  const keptByRich = SURVIVING_TAGS.has(name) || (name === "span" && spanSurvives(attrs));
  if (keptByRich && exported) return null;
  if (MEDIA_TAGS.has(name)) {
    return {
      effect: "moved",
      note: `<${name}> renders in exports and shared pages where it stands. Rich has a node for it and pulls it onto a line of its own when that block is edited, so write it alone on its line if that is where you want it.`,
    };
  }
  if (REWRITTEN_TAGS.has(name)) {
    return {
      effect: "rewritten",
      note: `<${name}> renders in exports and shared pages, and Rich rewrites it as the markdown that means the same thing when it next saves that paragraph. Nothing is lost.`,
    };
  }
  return {
    effect: "unwrapped",
    note: exported
      ? `<${name}> renders in exports and shared pages, but Rich drops the tag and keeps the text when it next saves that paragraph. Only <mark>, <u> and a <span> styled with color, font-family or font-size come back.`
      : `<${name}> is dropped by exports and shared pages (the text stays), and Rich drops the tag too when it next saves that paragraph.`,
  };
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
  if (/^javascript:/i.test(target)) return { ...base, kind: "remote", unsafe: true };
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
  if (t.unsafe) {
    warnings.push(
      "A javascript: link works nowhere. The export sanitizer strips the address and leaves the words behind with nothing to click."
    );
    return warnings;
  }
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

// Every tag whose two fates are worth saying, with the line it is on. The two
// shapes the editor owns, a sized picture or clip and an aligned paragraph or
// heading, are drawn properly on both sides and are not findings at all.
//
// Takes the blanked text, so code fences are already spaces and need no handling
// of their own here.
function findHtml(text) {
  const found = [];
  const lines = text.split(/(?<=\n)/);
  let skipUntilCommentEnd = false;

  const scanInline = (bare, line, onlyDropped) => {
    // Comments render nowhere and are meant to render nowhere, so they are not
    // findings. Markie keeps their bytes exactly as written.
    const stripped = bare.replace(/<!--[\s\S]*?-->/g, "");
    for (const m of stripped.matchAll(OPEN_TAG)) {
      if (EVENT_ATTR.test(m[2] ?? "")) {
        found.push({
          tag: m[1].toLowerCase(),
          line,
          form: "attribute",
          effect: "dropped",
          note: `An on...= handler on <${m[1].toLowerCase()}> runs nowhere. The export sanitizer strips it and the editor never keeps it.`,
        });
      }
      const fate = inlineFate(m[1], m[2]);
      if (!fate) continue;
      if (onlyDropped && fate.effect !== "dropped") continue;
      found.push({ tag: m[1].toLowerCase(), line, form: "inline", ...fate });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const bare = lines[i].replace(/\r?\n$/, "");
    if (skipUntilCommentEnd) {
      if (bare.includes("-->")) skipUntilCommentEnd = false;
      continue;
    }
    if (BLOCK_COMMENT_OPEN.test(bare)) {
      if (!bare.includes("-->")) skipUntilCommentEnd = true;
      continue;
    }
    if (!BLOCK_HTML_OPEN.test(bare)) {
      scanInline(bare, i + 1, false);
      continue;
    }
    // A CommonMark HTML block runs to the next blank line. One line of it that
    // is a shape the editor owns is not a block at all: it is a node the editor
    // draws, so it is left alone here exactly as rich-hold-aside.ts leaves it.
    let j = i + 1;
    while (j < lines.length && lines[j].replace(/\r?\n$/, "").trim() !== "") j++;
    if (j === i + 1 && isEditorOwnHtmlBlock(bare)) {
      // The shape is fine, but an on...= handler written on it still runs
      // nowhere, and nothing else would ever say so.
      scanInline(bare, i + 1, true);
      continue;
    }

    const first = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(bare);
    const tag = first ? first[1].toLowerCase() : "?";
    if (DROPPED_TAGS.has(tag)) {
      found.push({ tag, line: i + 1, form: "block", effect: "dropped", note: droppedNote(tag) });
    } else {
      found.push({
        tag,
        line: i + 1,
        form: "block",
        effect: "held",
        note: EXPORT_RENDERS.has(tag)
          ? `A tag at the start of a line makes an HTML block. Exports, PDFs and shared pages render it, and Rich shows a placeholder token where the block is because it holds the bytes aside untouched. Only a lone picture or clip tag, and an aligned <p> or heading, are drawn in Rich.`
          : `A tag at the start of a line makes an HTML block. Rich shows a placeholder token where the block is, and exports drop the <${tag}> element itself and keep what is inside it.`,
      });
    }
    // The block is held whole, but a <script> inside it still renders nowhere,
    // and that is the half worth saying. The opening line is skipped when its
    // own tag is what was just reported, so a lone <script> is one finding.
    const scanFrom = DROPPED_TAGS.has(tag) ? i + 1 : i;
    for (let k = scanFrom; k < j; k++) scanInline(lines[k].replace(/\r?\n$/, ""), k + 1, true);
    i = j - 1;
  }
  return found;
}

function summarize(report) {
  const { counts } = report;
  const problems = [];
  for (const t of report.targets) {
    if (t.unsafe) {
      problems.push(`${t.raw} (works nowhere)`);
      continue;
    }
    if (t.resolved === undefined) continue;
    // Both reasons, because a .mkv that is also missing needs moving AND
    // relinking, and hearing only the first one costs a second round trip.
    const why = [];
    if (!t.exists) why.push("no such file");
    if (t.embed && !t.displayable) why.push("not a kind Markie embeds");
    if (why.length) problems.push(`${t.raw} (${why.join(", ")})`);
  }
  for (const h of report.html) {
    if (h.effect === "dropped") problems.push(`<${h.tag}> on line ${h.line} (renders nowhere)`);
  }

  const notes = counts.html - counts.htmlDropped;
  const head = report.ok
    ? `Everything in this document displays: ${counts.targets} target${counts.targets === 1 ? "" : "s"} checked.`
    : `${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}.`;
  const outside =
    counts.outsideFolder > 0
      ? ` ${counts.outsideFolder} target${counts.outsideFolder === 1 ? " sits" : "s sit"} outside the document's folder and will display only from inside a Markie workspace folder.`
      : "";
  const html =
    notes > 0
      ? ` ${notes} tag${notes === 1 ? " renders" : "s render"} differently in Rich and in exports; see html[] for which.`
      : "";
  return head + outside + html;
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
  const addTarget = (raw, embed, index, lineOf) => {
    const t = classifyTarget(raw, embed, docDir, exists);
    t.line = lineOf(index);
    const warnings = warningsFor(t);
    if (warnings.length) t.warnings = warnings;
    targets.push(t);
  };
  const mdLines = lineNumberer(scannable);
  for (const m of scannable.matchAll(MD_TARGET)) addTarget(m[2], m[1] === "!", m.index, mdLines);
  // A media tag's src is a local file exactly as much as `![](…)` is, and it is
  // always an embed: the tag is the picture, not a link to it. Its own line
  // numberer because each walks its matches in order from the top.
  const htmlLines = lineNumberer(scannable);
  for (const m of scannable.matchAll(HTML_SRC)) {
    addTarget(m[1] ?? m[2] ?? m[3] ?? "", true, m.index, htmlLines);
  }
  targets.sort((a, b) => a.line - b.line);

  const html = findHtml(scannable);
  const local = targets.filter((t) => t.resolved !== undefined);
  const counts = {
    targets: targets.length,
    embeds: targets.filter((t) => t.embed).length,
    local: local.length,
    missing: local.filter((t) => !t.exists).length,
    undisplayable: local.filter((t) => t.embed && !t.displayable).length,
    outsideFolder: local.filter((t) => !t.insideDocFolder).length,
    unsafe: targets.filter((t) => t.unsafe).length,
    html: html.length,
    htmlDropped: html.filter((h) => h.effect === "dropped").length,
  };
  const report = {
    ok:
      counts.missing === 0 &&
      counts.undisplayable === 0 &&
      counts.unsafe === 0 &&
      counts.htmlDropped === 0,
    path: docPath,
    counts,
    targets,
    html,
  };
  report.summary = summarize(report);
  return report;
}
