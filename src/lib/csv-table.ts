// The lossless model behind the CSV table (src/components/csv-table).
//
// A CSV file is kept as the exact tokens it was written with: every field as
// its raw source slice (quotes included) and every row with the line ending
// that followed it. Serializing joins those tokens back, so a file that was
// opened and saved without edits is byte for byte the file that was opened,
// whatever its delimiter, quoting, line endings, BOM or trailing newline.
// An edit rewrites only the tokens of the cells it touched.

export type CsvDelimiter = "," | ";" | "\t" | "|";

export interface CsvDocument {
  /** The text began with U+FEFF. */
  readonly bom: boolean;
  readonly delimiter: CsvDelimiter;
  /** Raw field tokens, exactly as written. Read a cell with `cellValue`. */
  readonly rows: readonly (readonly string[])[];
  /** What ended each row: "\n", "\r\n", "\r", or "" for a last row with no newline. */
  readonly eols: readonly string[];
  /** The line ending new rows get: the file's most common one. */
  readonly newline: string;
  /** Every field in the file is quoted, so new and edited cells are too. */
  readonly quoteAll: boolean;
  /** The widest row. */
  readonly columnCount: number;
}

const QUOTE = 34, LF = 10, CR = 13;
const DELIMITERS: readonly CsvDelimiter[] = [",", "\t", ";", "|"];

interface Tokens { rows: string[][]; eols: string[] }

// One pass, quote aware. A field that opens with a quote runs to its closing
// quote; anything after that up to the delimiter stays in the same token, so
// malformed input still round-trips.
function tokenize(text: string, start: number, delimiter: string, maxRows = Infinity): Tokens {
  const rows: string[][] = [], eols: string[] = [];
  const delim = delimiter.charCodeAt(0), length = text.length;
  let row: string[] = [], i = start, fieldStart = start;
  while (i < length) {
    let code = text.charCodeAt(i);
    if (code === QUOTE && i === fieldStart) {
      i++;
      while (i < length) {
        if (text.charCodeAt(i) === QUOTE) {
          if (text.charCodeAt(i + 1) === QUOTE) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      if (i >= length) break;
      code = text.charCodeAt(i);
    }
    if (code === delim) {
      row.push(text.slice(fieldStart, i));
      fieldStart = ++i;
    } else if (code === LF || code === CR) {
      row.push(text.slice(fieldStart, i));
      const eol = code === CR && text.charCodeAt(i + 1) === LF ? "\r\n" : code === CR ? "\r" : "\n";
      rows.push(row); eols.push(eol);
      row = [];
      i += eol.length;
      fieldStart = i;
      if (rows.length >= maxRows) return { rows, eols };
    } else {
      i++;
    }
  }
  if (fieldStart < length || row.length > 0) {
    row.push(text.slice(fieldStart));
    rows.push(row); eols.push("");
  }
  return { rows, eols };
}

/** The delimiter a file uses, read from its first rows. A `.tsv` name prefers tabs. */
export function sniffDelimiter(text: string, name?: string): CsvDelimiter {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const tsv = !!name && /\.(?:tsv|tab)$/i.test(name);
  let best: CsvDelimiter = tsv ? "\t" : ",", bestShare = 0, bestWidth = 1;
  for (const delimiter of DELIMITERS) {
    const sample = tokenize(text, start, delimiter, 40).rows.filter((row) => !(row.length === 1 && row[0] === ""));
    if (sample.length === 0) continue;
    const counts = new Map<number, number>();
    for (const row of sample) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    let width = 1, rowsAtWidth = 0;
    for (const [size, count] of counts) if (size > 1 && (count > rowsAtWidth || (count === rowsAtWidth && size > width))) { width = size; rowsAtWidth = count; }
    if (width <= 1) continue;
    if (tsv && delimiter === "\t") return "\t";
    const share = rowsAtWidth / sample.length;
    // Anything but a comma has to hold for most rows: one cell with a "|" or a
    // ";" in it does not make a file pipe or semicolon separated.
    if (delimiter !== "," && share <= 0.5) continue;
    if (share > bestShare || (share === bestShare && width > bestWidth)) { best = delimiter; bestShare = share; bestWidth = width; }
  }
  return best;
}

function finish(bom: boolean, delimiter: CsvDelimiter, rows: readonly (readonly string[])[], eols: readonly string[], newline: string, quoteAll: boolean): CsvDocument {
  let columnCount = 0;
  for (const row of rows) if (row.length > columnCount) columnCount = row.length;
  return { bom, delimiter, rows, eols, newline, quoteAll, columnCount };
}

export function parseCsvDocument(text: string, options: { name?: string; delimiter?: CsvDelimiter } = {}): CsvDocument {
  const bom = text.charCodeAt(0) === 0xfeff;
  const delimiter = options.delimiter ?? sniffDelimiter(text, options.name);
  const { rows, eols } = tokenize(text, bom ? 1 : 0, delimiter);
  let lf = 0, crlf = 0, cr = 0;
  for (const eol of eols) { if (eol === "\n") lf++; else if (eol === "\r\n") crlf++; else if (eol === "\r") cr++; }
  const newline = crlf > lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n";
  // Sampled: a style question, not a correctness one.
  let fields = 0, quoted = 0;
  for (let r = 0; r < rows.length && r < 200; r++) {
    for (const raw of rows[r]) { if (raw === "") continue; fields++; if (raw.charCodeAt(0) === QUOTE) quoted++; }
  }
  return finish(bom, delimiter, rows, eols, newline, fields > 0 && quoted === fields);
}

export function serializeCsvDocument(doc: CsvDocument): string {
  const parts: string[] = new Array(doc.rows.length);
  for (let r = 0; r < doc.rows.length; r++) parts[r] = doc.rows[r].join(doc.delimiter) + doc.eols[r];
  return (doc.bom ? "﻿" : "") + parts.join("");
}

/** A raw token as the value a person reads. */
export function decodeField(raw: string): string {
  if (raw.charCodeAt(0) !== QUOTE) return raw;
  let out = "", i = 1;
  while (i < raw.length) {
    const next = raw.indexOf('"', i);
    if (next < 0) return out + raw.slice(i);
    out += raw.slice(i, next);
    if (raw.charCodeAt(next + 1) === QUOTE) { out += '"'; i = next + 2; continue; }
    return out + raw.slice(next + 1);
  }
  return out;
}

export function encodeField(value: string, delimiter: string, forceQuote = false): string {
  if (!forceQuote && !value.includes(delimiter) && !/["\r\n]/.test(value)) return value;
  return '"' + value.replace(/"/g, '""') + '"';
}

export function cellValue(doc: CsvDocument, row: number, column: number): string {
  const raw = doc.rows[row]?.[column];
  return raw === undefined ? "" : decodeField(raw);
}

const isBlankLine = (row: readonly string[]) => row.length === 1 && row[0] === "";

/** The same document when the value is what the cell already says. */
export function setCell(doc: CsvDocument, row: number, column: number, value: string): CsvDocument {
  const current = doc.rows[row];
  if (!current || column < 0) return doc;
  const raw = current[column];
  if ((raw === undefined ? "" : decodeField(raw)) === value) return doc;
  const next = current.slice();
  // A short row grows to reach the cell; the cells between stay empty.
  while (next.length < column) next.push(doc.quoteAll ? '""' : "");
  const wasQuoted = raw !== undefined && raw.charCodeAt(0) === QUOTE;
  next[column] = encodeField(value, doc.delimiter, wasQuoted || (doc.quoteAll && (raw === undefined || raw === "")));
  const rows = doc.rows.slice();
  rows[row] = next;
  return { ...doc, rows, columnCount: Math.max(doc.columnCount, next.length) };
}

/** Several cells in one step. */
export function setCells(doc: CsvDocument, edits: readonly { row: number; column: number; value: string }[]): CsvDocument {
  let next = doc;
  for (const edit of edits) next = setCell(next, edit.row, edit.column, edit.value);
  return next;
}

/** A new empty row before `at` (rows.length appends). */
export function insertRow(doc: CsvDocument, at: number, values: readonly string[] = []): CsvDocument {
  const index = Math.max(0, Math.min(at, doc.rows.length));
  const width = Math.max(doc.columnCount, values.length, 1);
  const row: string[] = [];
  for (let c = 0; c < width; c++) row.push(encodeField(values[c] ?? "", doc.delimiter, doc.quoteAll));
  const rows = doc.rows.slice(), eols = doc.eols.slice();
  if (index === rows.length && rows.length > 0 && eols[rows.length - 1] === "") {
    // The file has no trailing newline, and still has none afterwards.
    eols[rows.length - 1] = doc.newline;
    rows.push(row); eols.push("");
  } else {
    rows.splice(index, 0, row); eols.splice(index, 0, doc.newline);
  }
  return finish(doc.bom, doc.delimiter, rows, eols, doc.newline, doc.quoteAll);
}

export function deleteRows(doc: CsvDocument, indices: readonly number[]): CsvDocument {
  const drop = new Set(indices.filter((index) => index >= 0 && index < doc.rows.length));
  if (drop.size === 0) return doc;
  const endedWithoutNewline = doc.eols[doc.rows.length - 1] === "";
  const rows: (readonly string[])[] = [], eols: string[] = [];
  for (let r = 0; r < doc.rows.length; r++) if (!drop.has(r)) { rows.push(doc.rows[r]); eols.push(doc.eols[r]); }
  if (endedWithoutNewline && rows.length > 0) eols[rows.length - 1] = "";
  return finish(doc.bom, doc.delimiter, rows, eols, doc.newline, doc.quoteAll);
}

/** A new empty column before `at` (columnCount appends). Blank lines stay blank. */
export function insertColumn(doc: CsvDocument, at: number): CsvDocument {
  const index = Math.max(0, Math.min(at, doc.columnCount));
  const empty = doc.quoteAll ? '""' : "";
  const rows = doc.rows.map((row) => {
    if (isBlankLine(row) && doc.rows.length > 1) return row;
    if (row.length < index) return row;
    const next = row.slice();
    next.splice(index, 0, empty);
    return next;
  });
  return finish(doc.bom, doc.delimiter, rows, doc.eols, doc.newline, doc.quoteAll);
}

export function deleteColumns(doc: CsvDocument, columns: readonly number[]): CsvDocument {
  const drop = new Set(columns.filter((column) => column >= 0 && column < doc.columnCount));
  if (drop.size === 0) return doc;
  const rows = doc.rows.map((row) => {
    if (isBlankLine(row)) return row;
    const next = row.filter((_raw, column) => !drop.has(column));
    return next.length === row.length ? row : next.length === 0 ? [""] : next;
  });
  return finish(doc.bom, doc.delimiter, rows, doc.eols, doc.newline, doc.quoteAll);
}

// ---------------------------------------------------------------------------
// Reading values: numbers, headers, sorting, filtering. View only.

const NUMBER = /^[-+]?(?:[$€£¥]\s?)?(\d[\d.,'  ]*|[.,]\d+)(?:\s?[%$€£¥])?$/;
const GROUPED_BY_SPACE = /^\d{1,3}(?:[  ']\d{3})+(?:[.,]\d+)?$/;

/** The number a cell shows, or null. `decimalComma` settles "1,234" for files that use ";" between fields. */
export function parseNumber(value: string, decimalComma = false): number | null {
  const text = value.trim();
  if (text === "" || text.length > 40) return null;
  const match = NUMBER.exec(text);
  if (!match) return null;
  let digits = match[1].trim();
  if (/[  ']/.test(digits)) {
    if (!GROUPED_BY_SPACE.test(digits)) return null;
    digits = digits.replace(/[  ']/g, "");
  }
  const lastComma = digits.lastIndexOf(","), lastDot = digits.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    digits = lastComma > lastDot ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const grouped = /^\d{1,3}(?:,\d{3})+$/.test(digits);
    if (grouped && !decimalComma) digits = digits.replace(/,/g, "");
    else if (digits.indexOf(",") === lastComma) digits = digits.replace(",", ".");
    else if (grouped) digits = digits.replace(/,/g, "");
    else return null;
  } else if (lastDot >= 0 && digits.indexOf(".") !== lastDot) {
    if (!/^\d{1,3}(?:\.\d{3})+$/.test(digits)) return null;
    digits = digits.replace(/\./g, "");
  } else if (lastDot >= 0 && decimalComma && /^\d{1,3}\.\d{3}$/.test(digits)) {
    digits = digits.replace(".", "");
  }
  const number = Number(digits);
  if (!Number.isFinite(number)) return null;
  return text.charCodeAt(0) === 45 ? -number : number;
}

const SAMPLE_ROWS = 400;

/** Which columns hold numbers, from a sample of the rows after `firstRow`. */
export function numericColumns(doc: CsvDocument, firstRow: number): boolean[] {
  const decimalComma = doc.delimiter === ";";
  const filled = new Array<number>(doc.columnCount).fill(0), numeric = new Array<number>(doc.columnCount).fill(0);
  const end = Math.min(doc.rows.length, firstRow + SAMPLE_ROWS);
  for (let r = firstRow; r < end; r++) {
    const row = doc.rows[r];
    for (let c = 0; c < row.length; c++) {
      const value = decodeField(row[c]);
      if (value.trim() === "") continue;
      filled[c]++;
      if (parseNumber(value, decimalComma) !== null) numeric[c]++;
    }
  }
  return filled.map((count, c) => count > 0 && numeric[c] >= count * 0.9);
}

/**
 * Whether the first row reads as column names. It does unless it is clearly
 * data: one of its cells is a number in a column whose other rows are numbers.
 */
export function firstRowIsHeader(doc: CsvDocument): boolean {
  if (doc.rows.length < 2) return doc.rows.length === 1;
  const numeric = numericColumns(doc, 1), decimalComma = doc.delimiter === ";", first = doc.rows[0];
  for (let c = 0; c < first.length; c++) {
    if (numeric[c] && parseNumber(decodeField(first[c]), decimalComma) !== null) return false;
  }
  return true;
}

/** "A", "B", ... "Z", "AA": the name of a column with no header. */
export function columnLetter(index: number): string {
  let name = "", n = index;
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return name;
}

export interface CsvSort { column: number; direction: "asc" | "desc" }

/**
 * The rows to show, as indices into `doc.rows`: those after `firstRow` that
 * match the filter, in sorted order. The document is never changed.
 */
export function viewRows(doc: CsvDocument, firstRow: number, filter: string, sort: CsvSort | null, numeric: readonly boolean[] = []): number[] {
  const needle = filter.trim().toLowerCase();
  const order: number[] = [];
  for (let r = firstRow; r < doc.rows.length; r++) {
    if (needle) {
      const row = doc.rows[r];
      let hit = false;
      for (let c = 0; c < row.length && !hit; c++) hit = (row[c].charCodeAt(0) === QUOTE ? decodeField(row[c]) : row[c]).toLowerCase().includes(needle);
      if (!hit) continue;
    }
    order.push(r);
  }
  if (!sort) return order;
  const flip = sort.direction === "desc" ? -1 : 1;
  // Empty cells sort last in both directions; ties keep file order.
  if (numeric[sort.column]) {
    const decimalComma = doc.delimiter === ";";
    const keys = new Map<number, number | null>();
    for (const r of order) keys.set(r, parseNumber(cellValue(doc, r, sort.column), decimalComma));
    return order.sort((a, b) => {
      const x = keys.get(a) ?? null, y = keys.get(b) ?? null;
      if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
      return x === y ? a - b : (x - y) * flip;
    });
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keys = new Map<number, string>();
  for (const r of order) keys.set(r, cellValue(doc, r, sort.column));
  return order.sort((a, b) => {
    const x = keys.get(a)!, y = keys.get(b)!;
    if (x === "" || y === "") return x === y ? a - b : x === "" ? 1 : -1;
    return collator.compare(x, y) * flip || a - b;
  });
}

// ---------------------------------------------------------------------------
// Clipboard

/** A block of cells as delimited text: tab for a spreadsheet, comma for CSV. */
export function cellsToText(doc: CsvDocument, rows: readonly number[], columns: readonly number[], delimiter: "\t" | ","): string {
  return rows.map((row) => columns.map((column) => encodeField(cellValue(doc, row, column), delimiter)).join(delimiter)).join("\n");
}

/** Pasted text as rows of cells: tab separated when it has tabs, otherwise one cell per line. */
export function clipboardToCells(text: string): string[][] {
  const body = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!body.includes("\t") && !body.includes("\n")) return [[body]];
  return tokenize(body, 0, "\t").rows.map((row) => row.map(decodeField));
}

// ---------------------------------------------------------------------------
// The raw text view

/**
 * Text typed in an editor that only knows "\n" (a textarea, CodeMirror), put
 * back in the shape the file had: its line ending and its BOM.
 */
export function restoreTextShape(original: string, edited: string): string {
  const bom = original.charCodeAt(0) === 0xfeff;
  let crlf = 0, lf = 0, cr = 0;
  for (const match of original.matchAll(/\r\n|\r|\n/g)) { if (match[0] === "\r\n") crlf++; else if (match[0] === "\n") lf++; else cr++; }
  const newline = crlf > lf && crlf >= cr ? "\r\n" : cr > lf ? "\r" : "\n";
  let text = edited.replace(/\r\n?/g, "\n");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (newline !== "\n") text = text.replace(/\n/g, newline);
  return (bom ? "﻿" : "") + text;
}

/** The text an "\n"-only editor is given: no BOM, one kind of line ending. */
export function plainEditorText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export const isCsvName = (name: string | null | undefined): boolean => !!name && /\.(?:csv|tsv)$/i.test(name);
