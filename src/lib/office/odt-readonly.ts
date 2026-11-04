/** Original read-only display reader for OpenDocument text the bounded
 * editable codec (odt.ts) refuses: ODF 1.0/1.1/1.4 files, TextEdit and
 * LibreOffice output, lists, tables, headings and richer styles.
 * OASIS ODF 1.3 Part 3 §§5.1-5.3 (paragraphs, headings, lists), 9.1-9.2 (tables),
 * 16 (styles) and 20 (formatting properties):
 * https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html
 * Nothing here is ever written back. Properties outside the shared rich model are
 * ignored rather than rejected, because the document opens read-only and export
 * keeps the original bytes. Hidden, tracked-deleted, annotation, note, script,
 * drawing and foreign-namespace content is left out, never fetched or run.
 */
import { DocxError, type DocxRunStyle } from "./docx-types";
import type { RichBlockInput, RichParagraphInput, RichRunInput } from "./rich-text-types";
import { parseXml, xmlAttribute, type XmlElement } from "./xml";

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const FO = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const SVG = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
const MAX_TEXT = 1_000_000;
const MAX_PARAGRAPHS = 10_000;
const MAX_REPEAT = 64;
const MAX_CELLS = 1024;
// Every row and cell visit, counted across the whole read. Nested tables are
// flattened into the outer cell, so their empty cells add no paragraph and no
// cell to the limits above, and each level of 64 x 64 repeats multiplied the
// work by 4096: a 1 KB file hung the reader. 200k visits is far past any real
// document and still a fraction of a second.
const MAX_TABLE_WORK = 200_000;
// Containers whose children are ordinary body blocks.
const SECTIONS = new Set(["section", "index-body", "table-of-content", "illustration-index", "table-index", "object-index", "user-index", "alphabetical-index", "bibliography", "index-title"]);
// Inline content that is hidden, private, deleted or executable in the source.
const OMITTED_INLINE = new Set(["note", "hidden-text", "hidden-paragraph", "conditional-text", "script", "tracked-changes", "changed-region", "deletion"]);

type ParagraphProperties = Omit<RichParagraphInput, "runs">;
type Resolved = { run: DocxRunStyle; paragraph: ParagraphProperties };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const is = (node: XmlElement, ns: string, name: string) => node.namespace === ns && node.localName === name;
function fail(message: string): never { throw new DocxError("unsupported-odt", message); }

function points(value: string | undefined, base?: number): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)(pt|in|cm|mm|pc|px|%)$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const factor = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, px: 0.75, "%": base === undefined ? NaN : base / 100 }[match[2]]!;
  const result = Number(match[1]) * factor;
  return Number.isFinite(result) ? result : undefined;
}
function family(value: string | undefined): string | undefined {
  const name = value?.split(",")[0]?.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  return name && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name) ? name : undefined;
}

function styleResolver(roots: readonly XmlElement[]) {
  const fonts = new Map<string, string>();
  const styles = new Map<string, XmlElement>();
  const defaults = new Map<string, XmlElement>();
  const lists = new Map<string, XmlElement>();
  for (const root of roots) for (const container of root.children) {
    if (is(container, OFFICE, "font-face-decls")) {
      for (const face of container.children) {
        const name = xmlAttribute(face, "name", STYLE), value = family(xmlAttribute(face, "font-family", SVG));
        if (is(face, STYLE, "font-face") && name && value) fonts.set(name, value);
      }
    } else if (is(container, OFFICE, "styles") || is(container, OFFICE, "automatic-styles")) {
      for (const node of container.children) {
        const name = xmlAttribute(node, "name", STYLE), kind = xmlAttribute(node, "family", STYLE);
        if (is(node, STYLE, "style") && name && kind) styles.set(`${kind}|${name}`, node);
        else if (is(node, STYLE, "default-style") && kind) defaults.set(kind, node);
        else if (is(node, TEXT, "list-style") && name) lists.set(name, node);
      }
    }
  }
  function apply(node: XmlElement, base: Resolved): Resolved {
    const run: Mutable<DocxRunStyle> = { ...base.run };
    const paragraph: Mutable<ParagraphProperties> = { ...base.paragraph };
    for (const properties of node.children) {
      if (is(properties, STYLE, "text-properties")) {
        const weight = xmlAttribute(properties, "font-weight", FO);
        if (weight === "bold" || weight === "bolder" || (weight && /^\d+$/.test(weight) && Number(weight) >= 600)) run.bold = true;
        else if (weight === "normal" || weight === "lighter" || (weight && /^\d+$/.test(weight))) run.bold = false;
        const style = xmlAttribute(properties, "font-style", FO);
        if (style === "italic" || style === "oblique") run.italic = true;
        else if (style === "normal") run.italic = false;
        const size = points(xmlAttribute(properties, "font-size", FO), base.run.fontSizePoints ?? 12);
        if (size !== undefined && size >= 1 && size <= 400) run.fontSizePoints = Math.round(size * 100) / 100;
        const font = fonts.get(xmlAttribute(properties, "font-name", STYLE) ?? "") ?? family(xmlAttribute(properties, "font-family", FO));
        if (font) run.fontFamily = font;
        const color = xmlAttribute(properties, "color", FO);
        if (color && /^#[0-9a-f]{6}$/i.test(color)) run.color = color.slice(1);
        const underline = xmlAttribute(properties, "text-underline-style", STYLE);
        if (underline !== undefined) run.underline = underline === "none" ? "none" : "single";
      } else if (is(properties, STYLE, "paragraph-properties")) {
        const align = xmlAttribute(properties, "text-align", FO);
        const alignment = ({ start: "left", left: "left", end: "right", right: "right", center: "center", justify: "both" } as Record<string, string>)[align ?? ""];
        if (alignment) paragraph.alignment = alignment;
        for (const [attribute, field] of [["margin-top", "spacingBeforePoints"], ["margin-bottom", "spacingAfterPoints"]] as const) {
          const value = points(xmlAttribute(properties, attribute, FO));
          if (value !== undefined && value >= 0 && value <= 1000) paragraph[field] = Math.round(value * 100) / 100;
        }
        const line = xmlAttribute(properties, "line-height", FO);
        if (line && /^\d+(?:\.\d+)?%$/.test(line)) {
          const multiple = Number(line.slice(0, -1)) / 100;
          if (multiple >= 0.5 && multiple <= 5) paragraph.lineSpacingMultiple = multiple;
        }
      }
    }
    return { run, paragraph };
  }
  const cache = new Map<string, Resolved>();
  function resolve(kind: string, name: string | undefined, base: Resolved): Resolved {
    const key = `${kind}|${name ?? ""}|${JSON.stringify(base)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const chain: XmlElement[] = [];
    const seen = new Set<string>();
    for (let current = name; current && !seen.has(current) && seen.size < 128;) {
      seen.add(current);
      const node = styles.get(`${kind}|${current}`);
      if (!node) break;
      chain.unshift(node);
      current = xmlAttribute(node, "parent-style-name", STYLE);
    }
    let result = base;
    const fallback = defaults.get(kind);
    if (fallback) {
      const resolved = apply(fallback, { run: {}, paragraph: {} });
      result = { run: { ...resolved.run, ...base.run }, paragraph: { ...resolved.paragraph, ...base.paragraph } };
    }
    for (const node of chain) result = apply(node, result);
    if (cache.size < 10_000) cache.set(key, result);
    return result;
  }
  function listLevel(name: string | undefined, level: number): { kind: "bullet" | "numbered"; start: number } {
    const style = name ? lists.get(name) : undefined;
    const node = style?.children.find((child) => child.namespace === TEXT && xmlAttribute(child, "level", TEXT) === String(level + 1));
    if (!node || node.localName !== "list-level-style-number" || !xmlAttribute(node, "num-format", STYLE)) return { kind: "bullet", start: 1 };
    const start = Number(xmlAttribute(node, "start-value", TEXT) ?? "1");
    return { kind: "numbered", start: Number.isInteger(start) && start >= 0 && start <= 1_000_000 ? start : 1 };
  }
  return { resolve, listLevel };
}

export interface OdtDisplayBody { readonly paragraphs: RichParagraphInput[]; readonly blocks?: RichBlockInput[]; readonly omitted: boolean }

/** Reads office:text into display paragraphs and, where present, table blocks. */
export function readOdtDisplayBody(source: string, text: XmlElement, styleRoots: readonly XmlElement[]): OdtDisplayBody {
  const { resolve, listLevel } = styleResolver(styleRoots);
  const paragraphs: RichParagraphInput[] = [];
  const layout: RichBlockInput[] = [];
  let characters = 0, omitted = false, tableWork = 0;
  const spend = () => {
    if (++tableWork > MAX_TABLE_WORK) fail("This OpenDocument file has tables larger than Markie can show.");
  };
  const hidden = (node: XmlElement) => ["none", "condition"].includes(xmlAttribute(node, "display", TEXT) ?? "") || xmlAttribute(node, "condition", TEXT) !== undefined;
  const repeat = (node: XmlElement, attribute: string) => {
    const value = Number(xmlAttribute(node, attribute, TABLE) ?? "1");
    return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_REPEAT) : 1;
  };

  function paragraph(node: XmlElement, marker?: { kind: "bullet" | "numbered"; level: number; number?: number }): number {
    if (paragraphs.length >= MAX_PARAGRAPHS) fail("This OpenDocument file has more paragraphs than Markie can show.");
    let base = resolve("paragraph", xmlAttribute(node, "style-name", TEXT), { run: {}, paragraph: {} });
    if (node.localName === "h") {
      // Headings whose styles say nothing about emphasis still read as headings.
      const level = Math.min(Math.max(Number(xmlAttribute(node, "outline-level", TEXT) ?? "1") || 1, 1), 6);
      base = { ...base, run: { bold: true, fontSizePoints: [20, 16, 14, 13, 12, 12][level - 1], ...base.run } };
    }
    const runs: RichRunInput[] = [];
    let pending: DocxRunStyle | undefined;
    const emit = (value: string, style: DocxRunStyle) => {
      if (!value) return;
      characters += value.length;
      if (characters > MAX_TEXT) fail("This OpenDocument file has more text than Markie can show.");
      const previous = runs.at(-1);
      if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) runs[runs.length - 1] = { text: previous.text + value, style };
      else runs.push({ text: value, style });
    };
    // ODF §6.1.2: runs of literal white space collapse to one space, and leading space is dropped.
    const literal = (value: string, style: DocxRunStyle) => {
      for (const token of value.split(/([ \t\r\n]+)/)) {
        if (!token) continue;
        if (/^[ \t\r\n]+$/.test(token)) pending ??= style;
        else { if (pending && runs.length) emit(" ", pending); pending = undefined; emit(token, style); }
      }
    };
    const explicit = (value: string, style: DocxRunStyle) => {
      if (pending && runs.length) emit(" ", pending);
      pending = undefined;
      emit(value, style);
    };
    const inline = (element: XmlElement, style: DocxRunStyle) => {
      let cursor = element.startTagEnd;
      const between = (end: number) => { if (end > cursor) literal(parseXml(`<x>${source.slice(cursor, end)}</x>`).text, style); };
      for (const child of element.children) {
        between(child.start);
        cursor = child.end;
        if (child.namespace !== TEXT) { omitted = true; continue; }
        if (OMITTED_INLINE.has(child.localName) || hidden(child)) { omitted = true; continue; }
        if (child.localName === "s") {
          const count = Number(xmlAttribute(child, "c", TEXT) ?? "1");
          if (!Number.isInteger(count) || count < 1) continue;
          if (characters + count > MAX_TEXT) fail("This OpenDocument file has more text than Markie can show.");
          explicit(" ".repeat(count), style);
        } else if (child.localName === "tab") explicit("\t", style);
        else if (child.localName === "line-break") explicit("\n", style);
        else if (child.localName === "span") inline(child, resolve("text", xmlAttribute(child, "style-name", TEXT), { run: style, paragraph: {} }).run);
        // Links, fields, bookmarks, ruby and other text-namespace marks show their displayed text.
        else inline(child, style);
      }
      if (element.endTagStart > cursor) between(element.endTagStart);
    };
    inline(node, base.run);
    const index = paragraphs.length;
    const list = marker ? { listKind: marker.kind, listLevel: Math.min(marker.level, 8), ...(marker.number !== undefined ? { listNumber: marker.number } : {}) } : {};
    paragraphs.push({ ...base.paragraph, ...list, runs: runs.length ? runs : [{ text: "", style: base.run }] });
    return index;
  }

  function emptyParagraph(): number {
    if (paragraphs.length >= MAX_PARAGRAPHS) fail("This OpenDocument file has more paragraphs than Markie can show.");
    paragraphs.push({ runs: [{ text: "" }] });
    return paragraphs.length - 1;
  }

  function blocks(children: readonly XmlElement[], sink: (index: number) => void, list?: { style?: string; level: number }) {
    for (const node of children) {
      if (node.namespace === TEXT && (node.localName === "p" || node.localName === "h")) sink(paragraph(node));
      else if (is(node, TEXT, "list")) items(node, sink, { style: xmlAttribute(node, "style-name", TEXT) ?? list?.style, level: list ? list.level + 1 : 0 });
      else if (node.namespace === TEXT && SECTIONS.has(node.localName)) { if (hidden(node)) omitted = true; else blocks(node.children, sink, list); }
      else if (is(node, TABLE, "table")) table(node, sink);
      else if (node.namespace === TEXT && /-decls$|^soft-page-break$|-source$/.test(node.localName)) continue;
      else omitted = true;
    }
  }

  function items(node: XmlElement, sink: (index: number) => void, list: { style?: string; level: number }) {
    const level = listLevel(list.style, list.level);
    let number = level.start;
    for (const item of node.children) {
      const header = is(item, TEXT, "list-header");
      if (!header && !is(item, TEXT, "list-item")) { omitted = true; continue; }
      const override = Number(xmlAttribute(item, "start-value", TEXT));
      if (!header && Number.isInteger(override) && override >= 0 && override <= 1_000_000) number = override;
      let first = !header;
      for (const child of item.children) {
        if (first && child.namespace === TEXT && (child.localName === "p" || child.localName === "h")) {
          sink(paragraph(child, { kind: level.kind, level: list.level, number: level.kind === "numbered" ? number : undefined }));
          first = false;
        } else blocks([child], sink, list);
      }
      if (!header) number++;
    }
  }

  function table(node: XmlElement, sink: (index: number) => void) {
    const rows: number[][][] = [];
    const nested = sink !== topLevel;
    const rowGroup = (children: readonly XmlElement[]) => {
      for (const child of children) {
        if (is(child, TABLE, "table-row")) for (let copy = repeat(child, "number-rows-repeated"); copy > 0; copy--) { spend(); row(child); }
        else if (child.namespace === TABLE && ["table-header-rows", "table-rows", "table-row-group"].includes(child.localName)) rowGroup(child.children);
      }
    };
    const row = (node: XmlElement) => {
      const cells: number[][] = [];
      for (const child of node.children) {
        if (!is(child, TABLE, "table-cell")) continue; // Covered cells sit under a spanning cell.
        for (let copy = repeat(child, "number-columns-repeated"); copy > 0 && cells.length < MAX_CELLS; copy--) {
          spend();
          const cell: number[] = [];
          blocks(child.children, nested ? sink : (index) => cell.push(index));
          if (!nested) {
            if (!cell.length) cell.push(emptyParagraph());
            cells.push(cell);
          }
        }
      }
      if (cells.length) rows.push(cells);
    };
    // A table inside a cell is shown flattened, cell by cell, in the outer cell.
    rowGroup(node.children);
    if (rows.length) layout.push({ kind: "table", rows });
  }

  const topLevel = (index: number) => { layout.push({ kind: "paragraph", index }); };
  blocks(text.children, topLevel);
  if (!paragraphs.length) paragraphs.push({ runs: [{ text: "" }] });
  return { paragraphs, blocks: layout.some((block) => block.kind === "table") ? layout : undefined, omitted };
}
