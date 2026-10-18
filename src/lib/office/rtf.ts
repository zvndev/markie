import type { DocxOperation, DocxTextEdit, DocxRunStyle, DocxPageLayout } from "./docx-types";
import { DocxError } from "./docx-types";
import type { NativeRichDocument, RichParagraphInput, RichRunInput } from "./rich-text-types";
import { createRichSnapshot, applySimpleRichOperations, replaceSimpleRichText, rebaseSimpleRichDefaults } from "./rich-text-model";

/** Original, deliberately bounded implementation of Microsoft RTF 1.9.1 prose, §§ Introduction,
 * Unicode RTF, Font/Color Tables, Paragraph Formatting and Character Text. No sample reader used.
 * Unsupported semantics keep the original stream readable and exportable, but never editable. */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOKENS = 250_000;
const MAX_TEXT = 1_000_000;
type Token = { kind: "word"; name: string; value?: number } | { kind: "byte"; value: number }
  | { kind: "symbol"; name: string } | { kind: "binary" } | Group;
interface Group { kind: "group"; tokens: Token[]; start: number; end: number }
interface Owner { bytes: Uint8Array; retained: readonly Uint8Array[]; fonts: ReadonlyMap<number, Font>; defaultFamily: string }
const owners = new WeakMap<NativeRichDocument, Owner>();
const error = (message: string): never => { throw new DocxError("invalid-rtf", message); };

function lex(bytes: Uint8Array): Group {
  if (!bytes.length || bytes.length > MAX_BYTES) return error("RTF file exceeds the supported byte budget.");
  let cursor = 0, count = 0;
  const letter = (byte: number) => byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122;
  const digit = (byte: number) => byte >= 48 && byte <= 57;
  function group(depth: number): Group {
    if (depth > 128 || bytes[cursor] !== 123) return error("Invalid or excessively nested RTF group.");
    const start = cursor++;
    const tokens: Token[] = [];
    while (cursor < bytes.length) {
      if (++count > MAX_TOKENS) return error("RTF exceeds the supported token budget.");
      const byte = bytes[cursor++];
      if (byte === 125) return { kind: "group", tokens, start, end: cursor };
      if (byte === 123) { cursor--; tokens.push(group(depth + 1)); continue; }
      if (byte === 10 || byte === 13) continue;
      if (byte !== 92) { if (byte === 0) return error("Unexpected null byte in RTF text."); tokens.push({ kind: "byte", value: byte }); continue; }
      if (cursor === bytes.length) return error("Truncated RTF escape.");
      const next = bytes[cursor++];
      if (next === 39) {
        const hex = String.fromCharCode(...bytes.subarray(cursor, cursor + 2));
        if (!/^[a-f\d]{2}$/i.test(hex)) return error("Invalid RTF hexadecimal escape.");
        cursor += 2; tokens.push({ kind: "byte", value: Number.parseInt(hex, 16) }); continue;
      }
      if (!letter(next)) { tokens.push({ kind: "symbol", name: String.fromCharCode(next) }); continue; }
      let name = String.fromCharCode(next);
      while (cursor < bytes.length && letter(bytes[cursor])) {
        if (name.length >= 32) return error("RTF control word is too long.");
        name += String.fromCharCode(bytes[cursor++]);
      }
      let sign = 1;
      if (bytes[cursor] === 45) { sign = -1; cursor++; if (!digit(bytes[cursor])) return error("Malformed RTF parameter."); }
      const numberStart = cursor;
      while (cursor < bytes.length && digit(bytes[cursor])) cursor++;
      if (cursor - numberStart > 9) return error("RTF parameter exceeds the supported range.");
      const value = cursor === numberStart ? undefined : sign * Number(new TextDecoder().decode(bytes.subarray(numberStart, cursor)));
      if (bytes[cursor] === 32) cursor++;
      if (name === "bin") {
        if (value === undefined || value < 0 || cursor + value > bytes.length) return error("Truncated RTF binary data.");
        cursor += value; tokens.push({ kind: "binary" });
      } else tokens.push({ kind: "word", name, value });
    }
    return error("Unclosed RTF group.");
  }
  const result = group(0);
  while (cursor < bytes.length && [10, 13, 32, 9].includes(bytes[cursor])) cursor++;
  if (cursor !== bytes.length) return error("Unexpected data outside the RTF root group.");
  const first = result.tokens[0];
  if (first?.kind !== "word" || first.name !== "rtf" || first.value !== 1) return error("The file is not an RTF 1 document.");
  return result;
}

const codepages: Record<number, string> = { 1250: "windows-1250", 1251: "windows-1251", 1252: "windows-1252", 1253: "windows-1253", 1254: "windows-1254", 1255: "windows-1255", 1256: "windows-1256", 1257: "windows-1257", 1258: "windows-1258", 874: "windows-874", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 65001: "utf-8", 10000: "macintosh" };
const charsets: Record<number, number> = { 0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
interface Font { name: string; charset?: number; codepage?: number; family: string }
interface State { style: DocxRunStyle; font?: number; uc: number; paragraph: Omit<RichParagraphInput, "runs">; line?: number; multiple?: number }
const paragraphDefaults = () => ({ alignment: "left", spacingBeforePoints: 0, spacingAfterPoints: 0, lineSpacingMultiple: 1 });
const defaultLayout: DocxPageLayout = { widthPoints: 612, heightPoints: 792, orientation: "portrait", marginTopPoints: 72, marginBottomPoints: 72, marginLeftPoints: 72, marginRightPoints: 72 };

export async function openRtf(input: Uint8Array): Promise<NativeRichDocument> {
  const bytes = new Uint8Array(input);
  const root = lex(bytes);
  const unsupported = new Set<string>();
  const retained: Uint8Array[] = [];
  const fonts = new Map<number, Font>();
  const fontNames = new Set<string>();
  const colors: (string | undefined)[] = [];
  let defaultFont: number | undefined, codepage = 1252, textLength = 0, bodyStarted = false;
  const layout = { ...defaultLayout };
  const paragraphs: RichParagraphInput[] = [];
  let runs: RichRunInput[] = [], currentParagraph = paragraphDefaults() as Omit<RichParagraphInput, "runs">;
  const warn = (name: string) => { if (unsupported.size < 64) unsupported.add(name); };
  const decode = (values: number[], cp: number) => {
    const encoding = codepages[cp];
    if (!encoding) { warn(`codepage-${cp}`); return "\uFFFD".repeat(values.length); }
    try { return new TextDecoder(encoding, { fatal: true }).decode(new Uint8Array(values)); }
    catch { warn(`invalid-codepage-${cp}-bytes`); return new TextDecoder(encoding).decode(new Uint8Array(values)); }
  };
  const fontCodepage = (font?: number) => {
    const entry = font === undefined ? undefined : fonts.get(font);
    if (entry?.codepage !== undefined) return entry.codepage;
    if (entry?.charset !== undefined && entry.charset !== 1) return charsets[entry.charset] ?? -entry.charset;
    return codepage;
  };
  const append = (text: string, state: State) => {
    if (!text) return;
    bodyStarted = true; textLength += text.length;
    if (textLength > MAX_TEXT) error("RTF text exceeds the supported display budget.");
    const font = state.font ?? defaultFont;
    const family = font === undefined ? "Times New Roman" : fonts.get(font)?.name;
    if (font !== undefined && !family) warn(`missing-font-${font}`);
    const style = { ...state.style, ...(family ? { fontFamily: family } : {}) };
    const previous = runs.at(-1);
    if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) runs[runs.length - 1] = { text: previous.text + text, style };
    else runs.push({ text, style });
  };
  const finish = (state: State) => {
    currentParagraph = { ...state.paragraph };
    if (state.line !== undefined) {
      if (state.multiple === 1 && state.line > 0) currentParagraph = { ...currentParagraph, lineSpacingMultiple: state.line / 240 };
      else if (state.line !== 0) warn("absolute-line-spacing");
    }
    const font = state.font ?? defaultFont;
    const family = font === undefined ? "Times New Roman" : fonts.get(font)?.name;
    if (font !== undefined && !family) warn(`missing-font-${font}`);
    paragraphs.push({ ...currentParagraph, runs: runs.length ? runs : [{ text: "", style: { ...state.style, ...(family ? { fontFamily: family } : {}) } }] });
    runs = []; bodyStarted = true;
  };
  const destination = (group: Group) => {
    const first = group.tokens[0];
    const token = first?.kind === "symbol" && first.name === "*" ? group.tokens[1] : first;
    return token?.kind === "word" ? token.name : undefined;
  };
  const fontTable = (group: Group, inheritedUc: number) => {
    if (bodyStarted || fonts.size) warn("late-or-duplicate-font-table");
    let id: number | undefined, charset: number | undefined, cp: number | undefined, values: number[] = [], nameText = "", fallback = 0, family = "fnil";
    const flushBytes = () => { nameText += decode(values, cp ?? codepage); values = []; };
    const flush = () => {
      flushBytes();
      if (id === undefined) { if (values.some(v => v !== 32)) warn("invalid-font-table"); return; }
      const name = nameText.trim();
      if (!name || fonts.has(id) || fontNames.has(name) || name.length > 200 || /[;{}\\\x00-\x1f\x7f]/.test(name)) warn("invalid-font-table");
      else { fonts.set(id, { name, charset, codepage: cp, family }); fontNames.add(name); }
      id = undefined; charset = undefined; cp = undefined; values = []; nameText = ""; family = "fnil";
    };
    const visit = (tokens: Token[], inheritedCount: number) => {
      let uc = inheritedCount;
      for (const t of tokens) {
        if (t.kind === "group") { fallback = 0; visit(t.tokens, uc); fallback = 0; continue; }
        if (t.kind === "byte") { if (fallback) fallback--; else if (t.value === 59) flush(); else values.push(t.value); continue; }
        flushBytes();
        if (fallback) { fallback--; continue; }
        if (t.kind !== "word") { warn("font-table-extension"); continue; }
        if (t.name === "f") { if (id !== undefined || t.value === undefined || t.value < 0) warn("invalid-font-table"); id = t.value; }
        else if (t.name === "fcharset") charset = t.value;
        else if (t.name === "cpg") cp = t.value;
        else if (["fnil", "froman", "fswiss", "fmodern", "fscript", "fdecor", "ftech", "fbidi"].includes(t.name)) family = t.name;
        else if (t.name === "uc" && t.value !== undefined && t.value >= 0 && t.value <= 32) uc = t.value;
        else if (t.name === "u" && t.value !== undefined && t.value >= -32768 && t.value <= 32767) { nameText += String.fromCharCode(t.value & 65535); fallback = uc; }
        else if (!["fonttbl", "fnil", "froman", "fswiss", "fmodern", "fscript", "fdecor", "ftech", "fbidi"].includes(t.name)) warn(`font-${t.name}`);
      }
    };
    visit(group.tokens, inheritedUc);
    if (id !== undefined || values.some(v => v !== 32) || nameText.trim()) warn("unterminated-font-entry");
  };
  const colorTable = (group: Group) => {
    if (bodyStarted || colors.length) warn("late-or-duplicate-color-table");
    let rgb: Partial<Record<"red" | "green" | "blue", number>> = {};
    for (const t of group.tokens) {
      if (t.kind === "byte" && t.value === 59) {
        const entries = Object.keys(rgb);
        colors.push(entries.length ? [rgb.red ?? 0, rgb.green ?? 0, rgb.blue ?? 0].map(v => v.toString(16).padStart(2, "0")).join("") : undefined); rgb = {};
      } else if (t.kind === "word" && ["red", "green", "blue"].includes(t.name)) {
        if (t.value === undefined || t.value < 0 || t.value > 255) { warn("invalid-color-table"); continue; }
        rgb[t.name as keyof typeof rgb] = t.value;
      } else if (!(t.kind === "word" && t.name === "colortbl") && !(t.kind === "byte" && t.value === 32)) warn("color-table-extension");
    }
    if (Object.keys(rgb).length) warn("unterminated-color-entry");
  };
  // RTF 1.9.1, Information Group (Microsoft's normative prose, not its sample reader):
  // https://officeprotocoldoc.z19.web.core.windows.net/files/Archive_References/[MSFT-RTF].pdf
  // Only passive properties are retained here.
  // Canonical Unicode text is essential: the body writer changes the source
  // code page and Unicode fallback count, so retaining raw metadata can corrupt it.
  const infoGroup = (group: Group, state: State): Uint8Array | undefined => {
    const textFields = new Set(["title", "subject", "author", "manager", "company", "operator", "category", "keywords", "comment", "doccomm"]);
    const timeFields = new Set(["creatim", "revtim", "printim", "buptim"]);
    const numbers = new Set(["version", "vern", "edmins", "nofpages", "nofwords", "nofchars", "nofcharsws", "id"]);
    const timeBounds: Record<string, readonly [number, number]> = { yr: [0, 9999], mo: [1, 12], dy: [1, 31], hr: [0, 23], min: [0, 59], sec: [0, 59] };
    const fields = new Set<string>();
    const pieces: string[] = [];
    const start = (value: Group) => value.tokens[0]?.kind === "symbol" && value.tokens[0].name === "*" ? 1 : 0;
    const whitespace = (token: Token) => token.kind === "byte" && [9, 32].includes(token.value);
    function propertyText(tokens: readonly Token[]): string | undefined {
      let uc = state.uc, fallback = 0, result = "", pending: number[] = [];
      const flush = () => { result += decode(pending, fontCodepage(state.font ?? defaultFont)); pending = []; };
      for (const token of tokens) {
        if (token.kind === "group" || token.kind === "binary") return;
        if (token.kind === "byte") { if (fallback) fallback--; else pending.push(token.value); continue; }
        flush();
        if (token.kind === "word" && !["uc", "u", "line", "tab"].includes(token.name)) return;
        if (token.kind === "symbol" && !["\\", "{", "}", "~", "-", "_"].includes(token.name)) return;
        if (token.kind === "word" && (token.name === "uc" ? token.value === undefined || token.value < 0 || token.value > 32
          : token.name === "u" ? token.value === undefined || token.value < -32768 || token.value > 32767 : token.value !== undefined)) return;
        if (fallback) { fallback--; continue; }
        if (token.kind === "symbol") {
          const symbols: Record<string, string> = { "\\": "\\", "{": "{", "}": "}", "~": "\u00a0", "-": "\u00ad", "_": "\u2011" };
          if (!Object.hasOwn(symbols, token.name)) return;
          result += symbols[token.name]; continue;
        }
        if (token.name === "uc" && token.value !== undefined && token.value >= 0 && token.value <= 32) uc = token.value;
        else if (token.name === "u" && token.value !== undefined && token.value >= -32768 && token.value <= 32767) { result += String.fromCharCode(token.value & 65535); fallback = uc; }
        else if (["line", "tab"].includes(token.name) && token.value === undefined) result += token.name === "line" ? "\n" : "\t";
        else return;
      }
      flush();
      if (fallback) return;
      return result;
    }
    const header = group.tokens[start(group)];
    if (header?.kind !== "word" || header.name !== "info" || header.value !== undefined) return;
    for (const token of group.tokens.slice(start(group) + 1)) {
      if (whitespace(token)) continue;
      const nested = token.kind === "group" ? token : undefined;
      const first = nested ? nested.tokens[start(nested)] : token;
      if (first?.kind !== "word" || fields.has(first.name)) return;
      const name = first.name;
      fields.add(name);
      const tail = nested?.tokens.slice(start(nested) + 1) ?? [];
      if (numbers.has(name)) {
        if (first.value === undefined || first.value < 0 || tail.some(t => !whitespace(t))) return;
        pieces.push(`\\${name}${first.value}`);
      } else if (nested && first.value === undefined && textFields.has(name)) {
        const value = propertyText(tail);
        if (value === undefined) return;
        pieces.push(`{\\${name}\\uc1 ${escapeText(value)}}`);
      } else if (nested && first.value === undefined && timeFields.has(name)) {
        const seen = new Set<string>(), time: string[] = [];
        for (const part of tail) {
          if (whitespace(part)) continue;
          if (part.kind !== "word" || seen.has(part.name) || !Object.hasOwn(timeBounds, part.name) || part.value === undefined) return;
          const [min, max] = timeBounds[part.name];
          if (part.value < min || part.value > max) return;
          seen.add(part.name); time.push(`\\${part.name}${part.value}`);
        }
        pieces.push(`{\\${name}${time.join("")}}`);
      } else return;
    }
    return new TextEncoder().encode(`{\\info${pieces.join("")}}`);
  };
  const suppressedDestinations = new Set(["info", "stylesheet", "pict", "object", "field", "footnote", "annotation", "header", "footer", "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable", "revtbl", "filetbl", "xmlnstbl", "datastore", "themedata", "colorschememapping", "upr", "ud"]);
  function visit(group: Group, inherited: State, isRoot = false) {
    const state: State = { ...inherited, style: { ...inherited.style }, paragraph: { ...inherited.paragraph } };
    if (!isRoot) {
      const dest = destination(group);
      if (dest === "fonttbl") { fontTable(group, state.uc); return; }
      if (dest === "colortbl") { colorTable(group); return; }
      if (dest === "info") {
        const info = infoGroup(group, state);
        if (info) retained.push(info); else warn("info");
        return;
      }
      if (dest === "generator") {
        // Only plain ASCII generator metadata is byte-stable under the canonical Unicode writer.
        // Other metadata remains exactly exportable but read-only, rather than changing its charset.
        const start = group.tokens[0]?.kind === "symbol" ? 2 : 1;
        if (group.tokens.slice(start).some(token => !(token.kind === "byte" && token.value < 128) && !(token.kind === "symbol" && ["\\", "{", "}"].includes(token.name)))) warn("generator-extension");
        retained.push(bytes.slice(group.start, group.end)); return;
      }
      if (suppressedDestinations.has(dest ?? "") || group.tokens[0]?.kind === "symbol" && group.tokens[0].name === "*") { warn(dest ?? "unknown-destination"); return; }
    }
    let pending: number[] = [], fallback = 0;
    const flush = () => { if (pending.length) { append(decode(pending, fontCodepage(state.font ?? defaultFont)), state); pending = []; } };
    for (const token of group.tokens) {
      if (token.kind === "byte") { if (fallback) fallback--; else pending.push(token.value); continue; }
      flush();
      if (token.kind === "group") { fallback = 0; visit(token, state); continue; }
      if (fallback) { fallback--; continue; }
      if (token.kind === "binary") { warn("binary-data"); continue; }
      if (token.kind === "symbol") {
        const symbols: Record<string, string> = { "\\": "\\", "{": "{", "}": "}", "~": "\u00a0", "-": "\u00ad", "_": "\u2011" };
        if (symbols[token.name]) append(symbols[token.name], state); else if (["\n", "\r"].includes(token.name)) finish(state); else warn(`symbol-${token.name}`);
        continue;
      }
      const { name, value } = token;
      const required = (min: number, max: number) => value !== undefined && value >= min && value <= max;
      if (value !== undefined && ["ansi", "plain", "pard", "ulnone", "ql", "qc", "qr", "qj", "par", "tab", "line", "emdash", "endash", "bullet", "lquote", "rquote", "ldblquote", "rdblquote", "enspace", "emspace", "qmspace", "landscape"].includes(name)) warn(`unexpected-${name}-parameter`);
      if (name === "rtf" && isRoot && token === root.tokens[0]) continue;
      if (name === "ansi") continue;
      if (name === "ansicpg") { if (bodyStarted || !required(1, 65535)) warn("invalid-codepage"); else codepage = value!; continue; }
      if (name === "deff") { if (bodyStarted || !required(0, 65535)) warn("invalid-default-font"); else defaultFont = value; continue; }
      if (name === "uc") { if (!required(0, 32)) return error("Invalid RTF Unicode fallback count."); state.uc = value!; continue; }
      if (name === "u") { if (!required(-32768, 32767)) return error("Invalid signed RTF Unicode code unit."); append(String.fromCharCode(value! < 0 ? value! + 65536 : value!), state); fallback = state.uc; continue; }
      if (name === "plain") { state.style = { fontSizePoints: 12 }; state.font = defaultFont; continue; }
      if (name === "pard") { state.paragraph = paragraphDefaults(); state.line = undefined; state.multiple = undefined; continue; }
      if (["b", "i", "ul"].includes(name)) { if (value !== undefined && value !== 0 && value !== 1) warn(`invalid-${name}`); state.style = { ...state.style, [name === "b" ? "bold" : name === "i" ? "italic" : "underline"]: name === "ul" ? value === 0 ? "none" : "single" : value !== 0 }; continue; }
      if (name === "ulnone") { state.style = { ...state.style, underline: "none" }; continue; }
      if (name === "fs") { if (!required(2, 800)) warn("unsupported-font-size"); else state.style = { ...state.style, fontSizePoints: value! / 2 }; continue; }
      if (name === "f") { if (!required(0, 65535)) warn("invalid-font-reference"); else state.font = value; continue; }
      if (name === "cf") { if (!required(0, colors.length - 1)) warn("missing-color"); else state.style = { ...state.style, color: colors[value!] }; continue; }
      if (["ql", "qc", "qr", "qj"].includes(name)) { state.paragraph = { ...state.paragraph, alignment: ({ ql: "left", qc: "center", qr: "right", qj: "both" } as Record<string, string>)[name] }; continue; }
      if (name === "sb" || name === "sa") { if (!required(0, 31680)) warn("unsupported-paragraph-spacing"); else state.paragraph = { ...state.paragraph, [name === "sb" ? "spacingBeforePoints" : "spacingAfterPoints"]: value! / 20 }; continue; }
      if (name === "sl") { if (!required(-31680, 31680)) warn("invalid-line-spacing"); else state.line = value; continue; }
      if (name === "slmult") { if (!required(0, 1) || state.line === undefined) warn("invalid-line-spacing-multiple"); else state.multiple = value; continue; }
      if (name === "par") { finish(state); continue; }
      const special: Record<string, string> = { tab: "\t", line: "\n", emdash: "\u2014", endash: "\u2013", bullet: "\u2022", lquote: "\u2018", rquote: "\u2019", ldblquote: "\u201c", rdblquote: "\u201d", enspace: "\u2002", emspace: "\u2003", qmspace: "\u2005" };
      if (special[name]) { if (name === "enspace" || name === "emspace") warn("nonbreaking-font-relative-space"); append(special[name], state); continue; }
      const page: Record<string, keyof DocxPageLayout> = { paperw: "widthPoints", paperh: "heightPoints", margt: "marginTopPoints", margb: "marginBottomPoints", margl: "marginLeftPoints", margr: "marginRightPoints" };
      if (page[name]) { if (bodyStarted || !required(0, 31680)) warn("unsupported-page-layout"); else Object.assign(layout, { [page[name]]: value! / 20 }); continue; }
      if (name === "landscape") { if (bodyStarted) warn("late-landscape"); else layout.orientation = "landscape"; continue; }
      warn(name);
    }
    flush();
    if (isRoot && (runs.length || !paragraphs.length)) finish(state);
  }
  visit(root, { style: { fontSizePoints: 12 }, uc: 1, paragraph: paragraphDefaults() }, true);
  if (layout.widthPoints <= 0 || layout.heightPoints <= 0 || layout.marginLeftPoints + layout.marginRightPoints >= layout.widthPoints || layout.marginTopPoints + layout.marginBottomPoints >= layout.heightPoints) warn("invalid-page-layout");
  const diagnostics = unsupported.size ? [{ code: "rtf-unsupported", severity: "warning" as const, message: `This RTF uses unsupported features (${[...unsupported].join(", ")}). It is read-only; original bytes are preserved.` }] : [];
  const document = createRichSnapshot("rtf", paragraphs, { pageLayout: layout, diagnostics, canEdit: !unsupported.size });
  owners.set(document, { bytes, retained, fonts, defaultFamily: defaultFont === undefined ? "Times New Roman" : fonts.get(defaultFont)?.name ?? "Times New Roman" });
  return document;
}

function owner(document: NativeRichDocument): Owner {
  const result = owners.get(document);
  if (document.format !== "rtf" || !result) throw new DocxError("foreign-document", "RTF operations require an owned RTF document.");
  return result;
}
export function applyRtfOperations(document: NativeRichDocument, operations: readonly DocxOperation[]): NativeRichDocument {
  const source = owner(document);
  let next = applySimpleRichOperations(document, operations);
  if (next !== document) next = rebaseSimpleRichDefaults(next, { run: { fontFamily: source.defaultFamily, fontSizePoints: 12 }, paragraph: paragraphDefaults() });
  representable(next);
  if (next !== document) lex(encodeRtf(next, source));
  owners.set(next, source); return next;
}
export function replaceRtfText(document: NativeRichDocument, edits: readonly DocxTextEdit[]): NativeRichDocument {
  const source = owner(document);
  let next = replaceSimpleRichText(document, edits);
  if (next !== document) next = rebaseSimpleRichDefaults(next, { run: { fontFamily: source.defaultFamily, fontSizePoints: 12 }, paragraph: paragraphDefaults() });
  if (next !== document) { representable(next); lex(encodeRtf(next, source)); }
  owners.set(next, source); return next;
}

export function isSameRtfSource(first: NativeRichDocument, second: NativeRichDocument): boolean {
  const source = owners.get(first);
  return source !== undefined && source === owners.get(second);
}

function representable(document: NativeRichDocument): void {
  const exact = (value: number, factor: number) => Math.abs(value * factor - Math.round(value * factor)) < 1e-7;
  for (const p of document.paragraphs) {
    for (const r of p.runs) {
      if (r.style.fontSizePoints !== undefined && !exact(r.style.fontSizePoints, 2)) throw new DocxError("unsupported-operation", "RTF font sizes must use half-point steps.");
      if (r.style.underline && !["none", "single"].includes(r.style.underline)) throw new DocxError("unsupported-operation", "This RTF editor supports single underline only.");
      if (r.style.fontFamily && /[;{}\\]/.test(r.style.fontFamily)) throw new DocxError("unsupported-operation", "This font name is outside the supported RTF subset.");
    }
    if (![p.spacingBeforePoints ?? 0, p.spacingAfterPoints ?? 0].every(v => exact(v, 20)) || p.lineSpacingMultiple !== undefined && !exact(p.lineSpacingMultiple, 240)) throw new DocxError("unsupported-operation", "This spacing cannot be represented exactly in RTF units.");
  }
  if (![document.pageLayout.widthPoints, document.pageLayout.heightPoints, document.pageLayout.marginTopPoints, document.pageLayout.marginRightPoints, document.pageLayout.marginBottomPoints, document.pageLayout.marginLeftPoints].every(v => exact(v, 20))) throw new DocxError("unsupported-operation", "This page layout cannot be represented exactly in RTF units.");
}

function escapeText(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index), character = text[index];
    if (character === "\\" || character === "{" || character === "}") result += `\\${character}`;
    else if (character === "\n") result += "\\line ";
    else if (character === "\t") result += "\\tab ";
    else if (code >= 32 && code < 127) result += character;
    else result += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return result;
}
function encodeRtf(document: NativeRichDocument, source: Owner): Uint8Array {
  const fonts = [...new Set([source.defaultFamily, ...[...source.fonts.values()].map(font => font.name), ...document.paragraphs.flatMap(p => p.runs.map(r => r.style.fontFamily).filter((v): v is string => !!v))])];
  const colors = [...new Set(document.paragraphs.flatMap(p => p.runs.map(r => r.style.color).filter((v): v is string => !!v && v !== "auto")))];
  const originalFonts = new Map([...source.fonts.values()].map(font => [font.name, font]));
  const fontIndices = new Map(fonts.map((font, index) => [font, index]));
  const colorIndices = new Map(colors.map((color, index) => [color, index + 1]));
  // Font names are table text, not executable RTF. A semicolon is a table delimiter, not escapable.
  if (fonts.some(font => /[;\r\n\t]/.test(font))) throw new DocxError("rtf-font-name", "This font name cannot be represented safely in an RTF font table.");
  let text = "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1";
  text += `{\\fonttbl${fonts.map((font, i) => {
    const original = originalFonts.get(font);
    return `{\\f${i}\\${original?.family ?? "fnil"}${original?.charset !== undefined ? `\\fcharset${original.charset}` : ""}${original?.codepage !== undefined ? `\\cpg${original.codepage}` : ""} ${escapeText(font)};}`;
  }).join("")}}`;
  text += `{\\colortbl;${colors.map(color => { if (!/^[\da-f]{6}$/i.test(color)) throw new DocxError("rtf-color", "Invalid RTF color."); return `\\red${parseInt(color.slice(0, 2), 16)}\\green${parseInt(color.slice(2, 4), 16)}\\blue${parseInt(color.slice(4, 6), 16)};`; }).join("")}}`;
  const prefix = new TextEncoder().encode(text);
  text = "";
  const layout = document.pageLayout;
  text += `\\paperw${Math.round(layout.widthPoints * 20)}\\paperh${Math.round(layout.heightPoints * 20)}\\margl${Math.round(layout.marginLeftPoints * 20)}\\margr${Math.round(layout.marginRightPoints * 20)}\\margt${Math.round(layout.marginTopPoints * 20)}\\margb${Math.round(layout.marginBottomPoints * 20)}${layout.orientation === "landscape" ? "\\landscape" : ""}`;
  for (const paragraph of document.paragraphs) {
    text += `\\pard\\${({ left: "ql", center: "qc", right: "qr", both: "qj" } as Record<string, string>)[paragraph.alignment ?? "left"] ?? "ql"}\\sb${Math.round((paragraph.spacingBeforePoints ?? 0) * 20)}\\sa${Math.round((paragraph.spacingAfterPoints ?? 0) * 20)}`;
    if (paragraph.lineSpacingMultiple !== undefined) text += `\\sl${Math.round(paragraph.lineSpacingMultiple * 240)}\\slmult1`;
    text += " ";
    for (const run of paragraph.runs) {
      const s = run.style;
      // Explicit resets make each run independent; leave its properties active for the paragraph
      // mark so an empty paragraph retains its typing/font properties after reopening.
      text += `\\plain${s.fontFamily ? `\\f${fontIndices.get(s.fontFamily)}` : ""}\\fs${Math.round((s.fontSizePoints ?? 12) * 2)}${s.bold ? "\\b" : ""}${s.italic ? "\\i" : ""}${s.underline && s.underline !== "none" ? "\\ul" : ""}${s.color && s.color !== "auto" ? `\\cf${colorIndices.get(s.color)}` : ""} ${escapeText(run.text)}`;
    }
    text += "\\par\n";
  }
  text += "}";
  const body = new TextEncoder().encode(text);
  const result = new Uint8Array(prefix.length + source.retained.reduce((sum, group) => sum + group.length, 0) + body.length);
  result.set(prefix); let offset = prefix.length;
  for (const group of source.retained) { result.set(group, offset); offset += group.length; }
  result.set(body, offset);
  if (result.length > MAX_BYTES) throw new DocxError("rtf-budget", "Edited RTF exceeds the supported byte budget.");
  return result;
}

export async function exportRtf(document: NativeRichDocument): Promise<Uint8Array> {
  const source = owner(document);
  if (!document.modified) return source.bytes.slice();
  if (!document.canEdit) throw new DocxError("rtf-read-only", "Unsupported RTF content cannot be rewritten.");
  representable(document);
  const result = encodeRtf(document, source);
  const reopened = await openRtf(result);
  if (!reopened.canEdit || reopened.text !== document.text) throw new DocxError("rtf-roundtrip", "Edited RTF cannot be reopened faithfully within the supported subset.");
  return result;
}

export async function createRtf(text = ""): Promise<NativeRichDocument> {
  return openRtf(new TextEncoder().encode(`{\\rtf1\\ansi\\ansicpg1252\\uc1 ${text.split("\n").map(part => `${escapeText(part)}\\par `).join("")}}`));
}
