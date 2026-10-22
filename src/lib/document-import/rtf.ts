import { DocumentImportError, resolveDocumentImportLimits, type DocumentImportLimits, type ImportedDocumentText } from "./types";

/**
 * Original bounded body-text reader, derived only from the public RTF1.9.1 wire specification:
 * https://go.microsoft.com/fwlink/?LinkId=120924 (lexical/groups pp7–15; font codepages pp18–20).
 * MS-OXRTFEX was read only for its normative reference and encapsulation/destination semantics.
 * No third-party parser, package, source, fixture or reader sample was consulted.
 * This is conversion to a NEW plain-text copy, never RTF editing or lossless round-tripping.
 */
const LOSS_WARNING = "RTF body text was converted to a new plain-text copy. Formatting, page layout, images, headers/footers, comments, footnotes, links and revision semantics are not preserved.";

const OMITTED = new Set([
  "fonttbl", "filetbl", "colortbl", "stylesheet", "latentstyles", "listtable", "listoverridetable", "revtbl", "rsidtbl", "rsidtable",
  "info", "title", "subject", "author", "manager", "company", "operator", "category", "keywords", "comment", "doccomm", "hlinkbase",
  "creatim", "revtim", "printim", "buptim", "generator", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "footnote",
  "annotation", "atnauthor", "atnid", "atndate", "atnref", "atntime", "bkmkstart", "bkmkend", "fldinst", "datafield", "formfield",
  "pict", "shppict", "nonshppict", "object", "objdata", "objclass", "objname", "objtime", "shp", "shpgrp", "shpinst", "shprslt", "shptxt",
  "private", "userprops", "docvar", "themedata", "colorschememapping", "datastore", "xmlnstbl", "protusertbl", "mmathPr",
  "pn", "list", "listlevel", "leveltext", "levelnumbers", "falt", "fname", "panose", "fontemb", "fontfile", "background",
  "xe", "tc", "rxe", "txe", "nextfile", "template", "do", "aftncn", "aftnsep", "aftnsepc", "ftncn", "ftnsep", "ftnsepc",
]);
const TEXT_CONTROLS: Readonly<Record<string, string>> = Object.freeze({
  par: "\n", line: "\n", tab: "\t", cell: "\t", nestcell: "\t", row: "\n", nestrow: "\n", page: "\n\n", sect: "\n\n",
  emdash: "\u2014", endash: "\u2013", bullet: "\u2022", lquote: "\u2018", rquote: "\u2019", ldblquote: "\u201c", rdblquote: "\u201d",
  emspace: "\u2003", enspace: "\u2002", qmspace: "\u2005", ltrmark: "\u200e", rtlmark: "\u200f", zwbo: "\u200b",
});
const SYMBOLS: Readonly<Record<string, string>> = Object.freeze({ "\\": "\\", "{": "{", "}": "}", "~": "\u00a0", "-": "\u00ad", "_": "\u2011" });
const VISIBLE_DESTINATIONS = new Set(["field", "fldrslt", "pntext", "listtext"]);
const KNOWN_FORMATTING = new Set([
  "ansi", "fromtext", "b", "i", "ul", "ulnone", "uldb", "strike", "striked", "super", "sub", "nosupersub", "fs", "cf", "cb", "highlight",
  "pard", "s", "cs", "sa", "sb", "sl", "slmult", "li", "ri", "fi", "ql", "qr", "qc", "qj", "keep", "keepn", "widctlpar", "nowidctlpar",
  "fprq", "fnil", "froman", "fswiss", "fmodern", "fscript", "fdecor", "ftech", "fbidi", "fbidis", "lang", "langfe", "deflang", "deflangfe",
  "paperw", "paperh", "margl", "margr", "margt", "margb", "viewkind", "viewscale", "deftab", "sectd", "linex", "ftnbj", "endnhere",
  "trowd", "trgaph", "trleft", "cellx", "intbl", "itap", "ls", "ilvl", "pntext", "listtext", "rtlch", "ltrch", "rtlpar", "ltrpar", "loch", "hich", "dbch",
  "field", "fldrslt", "flddirty", "fldedit", "fldlock", "fldpriv", "nouicompat", "uc", "u", "rtf", "deff", "f", "cpg", "fcharset", "ansicpg", "plain", "v",
]);

interface Font { charset: number; codepage?: number }
interface Group {
  skip: boolean;
  fontTable: boolean;
  fontDefinition: number | null;
  font: number;
  unicodeFallback: number;
  hidden: boolean;
  start: boolean;
  starred: boolean;
}

function malformed(): never { throw new DocumentImportError("malformed", "The RTF structure or character encoding is malformed. The original is unchanged."); }
function budget(): never { throw new DocumentImportError("limit-exceeded", "RTF conversion exceeded its input, text, nesting or token budget."); }
function unsupported(message: string): never { throw new DocumentImportError("unsupported", message); }
const letter = (byte: number) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
const digit = (byte: number) => byte >= 48 && byte <= 57;
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;

export function extractRtfText(bytes: Uint8Array, suppliedLimits: DocumentImportLimits): ImportedDocumentText {
  const limits = resolveDocumentImportLimits(suppliedLimits);
  if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]") malformed();
  if (bytes.byteLength > limits.maxInputBytes) budget();
  const warnings = new Set([LOSS_WARNING]);
  const stack: Group[] = [];
  const fonts = new Map<number, Font>();
  let defaultFont = 0;
  let position = 0;
  let rootSeen = false;
  let rootClosed = false;
  let headerSeen = false;
  let controls = 0;
  let nodes = 0;
  let fallback = 0;
  let outputLength = 0;
  const chunks: string[] = [];
  let chunk = "";
  const pendingBytes: number[] = [];
  let ansi: TextDecoder;
  try { ansi = new TextDecoder("windows-1252", { fatal: true }); }
  catch { throw new DocumentImportError("platform-unavailable", "Windows-1252 decoding is unavailable on this platform."); }

  const node = () => { if (++nodes > limits.maxNodes) budget(); };
  const append = (text: string) => {
    if (text.length > limits.maxTextCodeUnits - outputLength) budget();
    outputLength += text.length;
    chunk += text;
    if (chunk.length >= 4096) { chunks.push(chunk); chunk = ""; }
  };
  const flush = () => {
    if (!pendingBytes.length) return;
    node();
    const decoded = ansi.decode(Uint8Array.from(pendingBytes));
    pendingBytes.length = 0;
    append(decoded);
  };
  const current = () => stack[stack.length - 1];
  const emitByte = (byte: number) => {
    if (fallback) { fallback--; return; }
    const state = current();
    if (state.skip || state.hidden) return;
    if (byte === 0 || byte === 127 || [0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(byte) ||
        (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)) malformed();
    const font = fonts.get(state.font);
    if (fonts.size && !font) malformed();
    if (font?.codepage !== undefined ? font.codepage !== 1252 && byte >= 128 : font?.charset === 2 || (font && font.charset !== 0 && font.charset !== 1 && byte >= 128)) {
      unsupported("RTF text uses an unsupported font code page. Only Windows-1252 ANSI bytes and explicit Unicode text are converted.");
    }
    if (byte >= 128) warnings.add("RTF ANSI bytes were decoded as Windows-1252; verify regional text.");
    pendingBytes.push(byte);
    if (pendingBytes.length === 4096) flush();
  };
  const emitText = (text: string) => {
    const state = current();
    if (!state.skip && !state.hidden) append(text);
  };

  while (position < bytes.length) {
    const byte = bytes[position++];
    if (rootClosed) { if (!whitespace(byte)) malformed(); continue; }
    if (!rootSeen && whitespace(byte)) continue;
    if (byte === 123) {
      flush();
      fallback = 0; // A brace ends Unicode fallback scanning before the scope delimiter.
      node();
      if (stack.length >= limits.maxDepth) budget();
      const parent = current();
      if (!rootSeen) rootSeen = true;
      else if (!parent || !headerSeen || parent.starred) malformed();
      stack.push(parent ? { ...parent, start: true, starred: false } : {
        skip: false, fontTable: false, fontDefinition: null, font: defaultFont,
        unicodeFallback: 1, hidden: false, start: true, starred: false,
      });
      continue;
    }
    if (!stack.length) malformed();
    const state = current();
    if (byte === 125) {
      flush();
      fallback = 0;
      if (state.starred || !headerSeen) malformed();
      stack.pop();
      if (!stack.length) rootClosed = true;
      continue;
    }
    if (byte === 10 || byte === 13) continue; // Source wrapping, not document paragraphs.
    if (byte !== 92) {
      if (!headerSeen || state.starred) malformed();
      state.start = false;
      emitByte(byte);
      continue;
    }
    flush();
    node();
    if (++controls > limits.maxControlWords || position >= bytes.length) { if (position >= bytes.length) malformed(); budget(); }
    const next = bytes[position++];
    if (!letter(next)) {
      if (!headerSeen) malformed();
      const symbol = String.fromCharCode(next);
      if (symbol === "'") {
        if (position + 2 > bytes.length) malformed();
        const hex = String.fromCharCode(bytes[position], bytes[position + 1]);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) malformed();
        position += 2;
        if (state.starred) malformed();
        state.start = false;
        emitByte(Number.parseInt(hex, 16));
      } else if (fallback) { fallback--; }
      else if (symbol === "*") {
        if (!state.start || state.starred) malformed();
        state.starred = true;
      } else {
        if (state.starred) malformed();
        state.start = false;
        if (Object.hasOwn(SYMBOLS, symbol)) emitText(SYMBOLS[symbol]);
        else if (next !== 10 && next !== 13) warnings.add("Unrecognized RTF controls were ignored; verify the converted text.");
      }
      continue;
    }
    const wordStart = position - 1;
    while (position < bytes.length && letter(bytes[position])) position++;
    if (position - wordStart > 32) budget();
    const word = String.fromCharCode(...bytes.subarray(wordStart, position));
    let parameter: number | undefined;
    let negative = false;
    if (bytes[position] === 45) { negative = true; position++; if (!digit(bytes[position])) malformed(); }
    if (digit(bytes[position])) {
      const numberStart = position;
      while (position < bytes.length && digit(bytes[position])) position++;
      if (position - numberStart > 10) budget();
      parameter = Number(String.fromCharCode(...bytes.subarray(numberStart, position))) * (negative ? -1 : 1);
      if (parameter < -2147483648 || parameter > 2147483647) malformed();
    }
    if (bytes[position] === 32) position++; // Exactly one optional delimiter space.
    if (word === "bin") {
      if (parameter === undefined || parameter < 0) malformed();
      unsupported("Binary RTF payloads are not converted. The original file is unchanged.");
    }
    if (fallback) { fallback--; continue; }
    if (!headerSeen) {
      if (stack.length !== 1 || !state.start || word !== "rtf" || parameter === undefined) malformed();
      if (parameter !== 1) unsupported("Only RTF version 1 documents are converted.");
      headerSeen = true;
      state.start = false;
      continue;
    }
    if (word === "rtf") malformed();
    if (!state.skip && (word === "upr" || word === "ud")) {
      unsupported("Alternate RTF Unicode destinations are not converted; use a source with explicit Unicode text runs.");
    }
    if ((state.starred && !VISIBLE_DESTINATIONS.has(word)) || (state.start && OMITTED.has(word))) {
      if (!state.skip) warnings.add("RTF metadata and non-body destinations were omitted.");
      state.skip = true;
      if (word === "fonttbl") state.fontTable = true;
      state.starred = false;
    } else if (OMITTED.has(word) && !state.skip) malformed();
    state.starred = false;
    state.start = false;

    if (state.fontTable) {
      if (word === "f") {
        if (parameter === undefined || parameter < 0) malformed();
        state.fontDefinition = parameter;
        if (!fonts.has(parameter)) fonts.set(parameter, { charset: 0 });
      } else if (word === "fcharset" || word === "cpg") {
        if (parameter === undefined || parameter < 0 || state.fontDefinition === null ||
            (word === "fcharset" && parameter > 255) || (word === "cpg" && parameter === 0)) malformed();
        const font = fonts.get(state.fontDefinition)!;
        if (word === "fcharset") font.charset = parameter; else font.codepage = parameter;
      }
      continue;
    }
    if (state.skip) continue;
    if (word === "fcharset") malformed(); // Font charset declarations belong to font-table entries, not body text.
    if (word === "mac" || word === "pc" || word === "pca") unsupported("Only ANSI/Windows-1252 RTF and explicit Unicode text are converted.");
    if (word === "ansicpg" || word === "cpg") {
      if (parameter === undefined || parameter < 1) malformed();
      if (parameter !== 1252) unsupported("Only Windows-1252 ANSI RTF and explicit Unicode text are converted; this code page is unsupported.");
    } else if (word === "deff" || word === "f") {
      if (parameter === undefined || parameter < 0) malformed();
      if (word === "deff") defaultFont = parameter;
      state.font = parameter;
    } else if (word === "uc") {
      if (parameter === undefined || parameter < 0) malformed();
      if (parameter > limits.maxInputBytes) budget();
      state.unicodeFallback = parameter;
    } else if (word === "u") {
      if (parameter === undefined || parameter < -32768 || parameter > 32767) malformed();
      const unit = parameter < 0 ? parameter + 65536 : parameter;
      if (unit === 0 || unit === 127 || (unit < 32 && unit !== 9 && unit !== 10 && unit !== 12 && unit !== 13)) malformed();
      emitText(String.fromCharCode(unit));
      fallback = state.unicodeFallback;
    } else if (word === "fromhtml" || word === "htmlrtf") {
      unsupported("HTML-encapsulated RTF is not converted by this body-text importer.");
    } else if ((word === "deleted" || word === "revised") && parameter !== 0) {
      unsupported("RTF tracked-change text requires an explicit revision decision and is not converted.");
    } else if (word === "v") {
      state.hidden = parameter !== 0;
      if (state.hidden) warnings.add("Hidden RTF text was omitted.");
    } else if (word === "plain") {
      state.hidden = false;
      state.font = defaultFont;
    } else if (Object.hasOwn(TEXT_CONTROLS, word)) {
      if (word === "cell" || word === "nestcell" || word === "row" || word === "nestrow") warnings.add("RTF tables were flattened to tabs and newlines; verify cell ordering.");
      emitText(TEXT_CONTROLS[word]);
    } else if (!KNOWN_FORMATTING.has(word)) warnings.add("Unrecognized RTF controls were ignored; verify the converted text.");
  }
  flush();
  if (!rootClosed || stack.length || !headerSeen) malformed();
  const text = chunks.join("") + chunk;
  // Surrogate pairs may span separate \u controls; lone UTF-16 units are never replaced silently.
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) malformed();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) malformed();
  }
  return { text, warnings: Array.from(warnings) };
}
