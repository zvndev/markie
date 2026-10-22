/**
 * Lossless dotenv parsing for the vault's environment key editor.
 *
 * Every logical line keeps its exact source text and its own line ending, so a
 * file that is parsed and serialized without edits comes back byte-identical
 * (comments, blank lines, quoting, spacing, order and CRLF/LF/CR included).
 * An edit rebuilds only the line it touches, from that line's own pieces.
 * Lines that are not valid `KEY=value` assignments are kept verbatim as
 * malformed lines rather than being repaired or dropped.
 */

export const DOTENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export type DotenvNewline = "\n" | "\r\n" | "\r";
export type DotenvQuote = "\"" | "'" | "`" | "";

type DotenvLineBase = {
  /** Stable identity for UI rows. Not part of the file. */
  readonly id: number;
  /** Exact source text of the line, without its terminator. Multi-line quoted values keep their inner line breaks. */
  readonly raw: string;
  /** Exact terminator that followed the line; empty only for a last line without one. */
  readonly eol: "" | DotenvNewline;
};

export type DotenvBlankLine = DotenvLineBase & { readonly kind: "blank" };
export type DotenvCommentLine = DotenvLineBase & { readonly kind: "comment"; readonly text: string };
export type DotenvMalformedLine = DotenvLineBase & { readonly kind: "malformed"; readonly reason: string };
export type DotenvEntryLine = DotenvLineBase & {
  readonly kind: "entry";
  readonly key: string;
  readonly value: string;
  readonly exported: boolean;
  readonly quote: DotenvQuote;
  /** raw === lead + key + separator + valueSource + trail */
  readonly lead: string;
  readonly separator: string;
  readonly valueSource: string;
  readonly trail: string;
};
export type DotenvLine = DotenvBlankLine | DotenvCommentLine | DotenvMalformedLine | DotenvEntryLine;

export type DotenvDocument = {
  readonly lines: readonly DotenvLine[];
  /** Terminator used for lines added by edits: the file's first line ending, or LF. */
  readonly newline: DotenvNewline;
  readonly nextId: number;
};

/** Upper bound on how far an open quote may reach, so a stray quote cannot make parsing quadratic. */
const MAX_QUOTED_LINES = 1000;

type EntryParts = Pick<DotenvEntryLine, "key" | "value" | "exported" | "quote" | "lead" | "separator" | "valueSource" | "trail">;
type Logical =
  | { kind: "blank" }
  | { kind: "comment"; text: string }
  | { kind: "malformed"; reason: string }
  | { kind: "unclosed"; quote: Exclude<DotenvQuote, ""> }
  | ({ kind: "entry" } & EntryParts);

export function isValidDotenvKey(key: string): boolean {
  return DOTENV_KEY_PATTERN.test(key);
}

/** `.env`, `prod.env`, `Untitled.env`, `.env.local`, `.env.production.local`. */
export function isEnvFileName(name: string): boolean {
  const basename = (name.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  return basename === ".env" || basename.endsWith(".env") || (basename.startsWith(".env.") && basename.length > 5);
}

function unescapeDoubleQuoted(inner: string): string {
  return inner.replace(/\\([\s\S])/g, (escape, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    if (character === "\"" || character === "\\") return character;
    return escape;
  });
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/[\\"\n\r]/g, (character) => character === "\n" ? "\\n" : character === "\r" ? "\\r" : `\\${character}`);
}

function closingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index++) {
    if (quote === "\"" && value[index] === "\\") { index++; continue; }
    if (value[index] === quote) return index;
  }
  return -1;
}

function parseLogical(source: string): Logical {
  const indent = /^[ \t]*/.exec(source)![0];
  const rest = source.slice(indent.length);
  if (rest === "") return { kind: "blank" };
  if (rest.startsWith("#")) return { kind: "comment", text: rest };
  const exportPrefix = /^export[ \t]+/.exec(rest)?.[0] ?? "";
  const lead = indent + exportPrefix;
  const afterLead = source.slice(lead.length);
  const equals = afterLead.indexOf("=");
  if (equals < 0) return { kind: "malformed", reason: "This line has no = sign." };
  const keySource = afterLead.slice(0, equals);
  const key = keySource.replace(/[ \t]+$/, "");
  if (!isValidDotenvKey(key)) return { kind: "malformed", reason: "This line's key is not a valid name." };
  const afterEquals = afterLead.slice(equals + 1);
  const gap = /^[ \t]*/.exec(afterEquals)![0];
  const separator = keySource.slice(key.length) + "=" + gap;
  const valueText = afterEquals.slice(gap.length);
  const first = valueText[0];
  if (first === "\"" || first === "'" || first === "`") {
    const close = closingQuote(valueText, first);
    if (close < 0) return { kind: "unclosed", quote: first };
    const valueSource = valueText.slice(0, close + 1);
    const trail = valueText.slice(close + 1);
    if (!/^[ \t]*(?:#.*)?$/.test(trail)) return { kind: "malformed", reason: "This line has text after its closing quote." };
    const inner = valueSource.slice(1, -1);
    return { kind: "entry", key, exported: exportPrefix !== "", lead, separator, valueSource, trail, quote: first,
      value: first === "\"" ? unescapeDoubleQuoted(inner) : inner };
  }
  // An unquoted `#` starts a comment only after whitespace, so URL fragments survive.
  const comment = gap !== "" && valueText.startsWith("#") ? 0 : valueText.search(/[ \t]#/);
  const beforeComment = comment >= 0 ? valueText.slice(0, comment) : valueText;
  const value = beforeComment.replace(/[ \t]+$/, "");
  return { kind: "entry", key, exported: exportPrefix !== "", lead, separator, valueSource: value, trail: valueText.slice(value.length), quote: "", value };
}

function physicalLines(text: string): { text: string; eol: "" | DotenvNewline }[] {
  const lines: { text: string; eol: "" | DotenvNewline }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] as DotenvNewline });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

function toLine(id: number, raw: string, eol: "" | DotenvNewline, logical: Exclude<Logical, { kind: "unclosed" }>): DotenvLine {
  if (logical.kind === "blank") return { id, raw, eol, kind: "blank" };
  if (logical.kind === "comment") return { id, raw, eol, kind: "comment", text: logical.text };
  if (logical.kind === "malformed") return { id, raw, eol, kind: "malformed", reason: logical.reason };
  return { ...logical, id, raw, eol };
}

export function parseDotenv(text: string): DotenvDocument {
  const physical = physicalLines(text);
  const lines: DotenvLine[] = [];
  for (let index = 0; index < physical.length;) {
    const id = lines.length;
    const line = physical[index];
    const logical = parseLogical(line.text);
    if (logical.kind !== "unclosed") {
      lines.push(toLine(id, line.text, line.eol, logical));
      index++;
      continue;
    }
    let joined = line.text;
    let closed: { end: number; logical: Logical } | null = null;
    for (let next = index + 1; next < physical.length && next - index <= MAX_QUOTED_LINES; next++) {
      joined += physical[next - 1].eol + physical[next].text;
      if (!physical[next].text.includes(logical.quote)) continue;
      const attempt = parseLogical(joined);
      if (attempt.kind === "unclosed") continue;
      closed = { end: next, logical: attempt };
      break;
    }
    if (closed?.logical.kind === "entry") {
      lines.push(toLine(id, joined, physical[closed.end].eol, closed.logical));
      index = closed.end + 1;
    } else {
      lines.push({ id, raw: line.text, eol: line.eol, kind: "malformed", reason: "This line's quoted value is never closed." });
      index++;
    }
  }
  const newline = physical.find((line) => line.eol !== "")?.eol || "\n";
  return { lines, newline, nextId: lines.length };
}

export function serializeDotenv(document: DotenvDocument): string {
  let text = "";
  for (const line of document.lines) text += line.raw + line.eol;
  return text;
}

function needsQuoting(value: string): boolean {
  return /[\s#"'`\\]/.test(value);
}

/** Source text for a value, keeping the line's previous quote style when it can hold the value. */
export function formatDotenvValue(value: string, previous: DotenvQuote = ""): string {
  if (previous === "'" && !/['\r\n]/.test(value)) return `'${value}'`;
  if (previous === "`" && !/[`\r\n]/.test(value)) return `\`${value}\``;
  if (previous === "" && !needsQuoting(value)) return value;
  return `"${escapeDoubleQuoted(value)}"`;
}

function quoteOf(valueSource: string): DotenvQuote {
  const first = valueSource[0];
  return first === "\"" || first === "'" || first === "`" ? first : "";
}

function rebuildEntry(line: DotenvEntryLine, parts: Partial<Pick<DotenvEntryLine, "key" | "value">>): DotenvEntryLine {
  const key = parts.key ?? line.key;
  const value = parts.value ?? line.value;
  const valueSource = parts.value === undefined ? line.valueSource : formatDotenvValue(value, line.quote);
  const quote = quoteOf(valueSource);
  // A bare value written directly before a `# comment` would swallow it, so keep them apart.
  const trail = quote === "" && valueSource !== "" && line.trail.startsWith("#") ? ` ${line.trail}` : line.trail;
  return { ...line, key, value, valueSource, quote, trail, raw: line.lead + key + line.separator + valueSource + trail };
}

export function updateDotenvEntry(document: DotenvDocument, id: number, parts: Partial<Pick<DotenvEntryLine, "key" | "value">>): DotenvDocument {
  return { ...document, lines: document.lines.map((line) => line.id === id && line.kind === "entry" ? rebuildEntry(line, parts) : line) };
}

export function addDotenvEntry(document: DotenvDocument, key = "", value = ""): DotenvDocument {
  const lines = [...document.lines];
  const last = lines.at(-1);
  // Keep whether the file ends with a line break: the old last line gains one, the new line inherits its absence.
  let eol: "" | DotenvNewline = document.newline;
  if (last && last.eol === "") {
    lines[lines.length - 1] = { ...last, eol: document.newline };
    eol = "";
  }
  const valueSource = formatDotenvValue(value);
  lines.push({ id: document.nextId, kind: "entry", key, value, exported: false, quote: quoteOf(valueSource),
    lead: "", separator: "=", valueSource, trail: "", raw: `${key}=${valueSource}`, eol });
  return { ...document, lines, nextId: document.nextId + 1 };
}

export function removeDotenvLine(document: DotenvDocument, id: number): DotenvDocument {
  const index = document.lines.findIndex((line) => line.id === id);
  if (index < 0) return document;
  const lines = document.lines.filter((line) => line.id !== id);
  if (index === lines.length && document.lines[index].eol === "" && lines.length > 0) {
    lines[lines.length - 1] = { ...lines[lines.length - 1], eol: "" };
  }
  return { ...document, lines };
}

/** Keys assigned by more than one line. With most loaders the last assignment wins. */
export function duplicateDotenvKeys(document: DotenvDocument): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of document.lines) {
    if (line.kind !== "entry" || line.key === "") continue;
    if (seen.has(line.key)) duplicates.add(line.key); else seen.add(line.key);
  }
  return duplicates;
}
