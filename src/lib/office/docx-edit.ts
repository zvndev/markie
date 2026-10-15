/** Original editing of ECMA-376 WordprocessingML direct properties, paragraphs,
 * sections and rectangular tables. Values use points at this boundary and
 * twentieths of a point (twips) / 240ths of a line in the package vocabulary.
 * https://ecma-international.org/publications-and-standards/standards/ecma-376/
 */
import { DocxError, type DocxOperation, type DocxPageLayout, type DocxPageLayoutChange, type DocxParagraphFormat, type DocxRunFormat } from "./docx-types";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

export interface DocxEditState {
  source: string;
  identities: Map<number, string>;
  nextId: number;
}
export interface DocxPatch { start: number; end: number; text: string; preserveIdentity?: boolean }
export const WORD_NAMESPACES = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const R_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "color", "sz", "szCs", "u", "lang"];
const P_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "widowControl", "numPr", "spacing", "ind", "jc"];
const SECTION_ORDER = ["type", "pgSz", "pgMar", "cols", "docGrid"];

export function isWord(node: XmlElement, name?: string): boolean {
  return WORD_NAMESPACES.includes(node.namespace) && (!name || node.localName === name);
}
export function wordChild(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return node?.children.find((c) => isWord(c, name));
}
const attribute = (node: XmlElement | undefined, name: string) => node && xmlAttribute(node, name, node.namespace);
const raw = (state: DocxEditState, node: XmlElement) => state.source.slice(node.start, node.end);
const number = (value: unknown, min: number, max: number, field: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new DocxError("invalid-format", `${field} must be a number from ${min} to ${max}.`);
  return value;
};
function object(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) {
    throw new DocxError("invalid-format", `Invalid ${label} fields.`);
  }
}
function xmlString(value: unknown, field: string, max = 200000): string {
  if (typeof value !== "string" || value.length > max) throw new DocxError("invalid-format", `${field} is not a supported string.`);
  escapeXmlText(value);
  return value;
}
const attributeText = (value: string) => escapeXmlText(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
function element(namespace: string, name: string, attrs: Record<string, string | number> = {}, content?: string): string {
  const properties = Object.entries(attrs).map(([k, v]) => ` w:${k}="${attributeText(String(v))}"`).join("");
  return `<w:${name} xmlns:w="${namespace}"${properties}${content === undefined ? "/>" : `>${content}</w:${name}>`}`;
}
function wrap(state: DocxEditState, node: XmlElement, content: string): string {
  const opening = state.source.slice(node.start, node.startTagEnd).replace(/\/>$/, ">");
  return `${opening}${content}</${node.name}>`;
}

export function indexDocxIdentities(state: DocxEditState): void {
  const root = parseXml(state.source);
  let paragraphIndex = 0;
  let tableIndex = 0;
  for (const node of xmlDescendants(root)) {
    if (isWord(node, "p")) {
      if (!state.identities.has(node.start)) state.identities.set(node.start, state.nextId === 0 ? `p${paragraphIndex}` : `p~${state.nextId++}`);
      const paragraphId = state.identities.get(node.start)!;
      let runIndex = 0;
      for (const run of node.children.filter((n) => isWord(n, "r"))) {
        if (!state.identities.has(run.start)) state.identities.set(run.start, state.nextId === 0 ? `${paragraphId}:r${runIndex}` : `r~${state.nextId++}`);
        runIndex++;
      }
      paragraphIndex++;
    } else if (isWord(node, "tbl")) {
      if (!state.identities.has(node.start)) state.identities.set(node.start, state.nextId === 0 ? `table${tableIndex}` : `table~${state.nextId++}`);
      tableIndex++;
    }
  }
  if (state.nextId === 0) state.nextId = 1;
}

export function patchDocxSource(state: DocxEditState, patches: readonly DocxPatch[]): DocxEditState {
  const sorted = [...patches].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].start < 0 || sorted[i].end < sorted[i].start || sorted[i].end > state.source.length
      || (i > 0 && sorted[i].start < sorted[i - 1].end)) throw new DocxError("invalid-edit", "Overlapping source edits.");
  }
  const identities = new Map<number, string>();
  for (const [offset, id] of state.identities) {
    let displacement = 0;
    let deleted = false;
    for (const patch of sorted) {
      if (offset >= patch.end) displacement += patch.text.length - (patch.end - patch.start);
      else if (offset >= patch.start) {
        if (!(offset === patch.start && patch.preserveIdentity)) deleted = true;
        break;
      }
    }
    if (!deleted) identities.set(offset + displacement, id);
  }
  let source = state.source;
  for (const patch of [...sorted].reverse()) source = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  const next = { source, identities, nextId: state.nextId };
  indexDocxIdentities(next);
  return next;
}

function findNode(state: DocxEditState, root: XmlElement, id: string, kind: string): XmlElement {
  const node = xmlDescendants(root).find((n) => isWord(n, kind) && state.identities.get(n.start) === id);
  if (!node) throw new DocxError("invalid-edit", `Unknown ${kind} identity.`);
  return node;
}
function propertyPatch(state: DocxEditState, parent: XmlElement, kind: string, changes: Map<string, string | null>, order: readonly string[]): DocxPatch {
  const current = wordChild(parent, kind);
  const props = new Map(current?.children.map((n) => [n.localName, raw(state, n)]));
  for (const [key, xml] of changes) {
    if (xml === null) props.delete(key);
    else props.set(key, xml);
  }
  const content = [...props].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([, xml]) => xml).join("");
  if (current) return { start: current.start, end: current.end, text: content ? wrap(state, current, content) : "" };
  if (parent.endTagStart < parent.startTagEnd) return { start: parent.start, end: parent.end, text: wrap(state, parent, content ? element(parent.namespace, kind, {}, content) : ""), preserveIdentity: true };
  return { start: parent.startTagEnd, end: parent.startTagEnd, text: content ? element(parent.namespace, kind, {}, content) : "" };
}

function formatRun(state: DocxEditState, run: XmlElement, style: DocxRunFormat): DocxPatch {
  object(style, ["bold", "italic", "underline", "color", "fontFamily", "fontSizePoints"], "run format");
  const changes = new Map<string, string | null>();
  for (const name of ["bold", "italic"] as const) {
    if (style[name] === undefined) continue;
    const value = style[name];
    if (value !== null && typeof value !== "boolean") throw new DocxError("invalid-format", `${name} must be boolean or null.`);
    changes.set(name === "bold" ? "b" : "i", value === null ? null : element(run.namespace, name === "bold" ? "b" : "i", { val: value ? "1" : "0" }));
  }
  if (style.underline !== undefined) {
    const value = style.underline;
    if (value !== null && !["none", "single", "double", "dotted", "dash", "wave"].includes(value)) throw new DocxError("invalid-format", "Unsupported underline style.");
    changes.set("u", value === null ? null : element(run.namespace, "u", { val: value }));
  }
  if (style.color !== undefined) {
    const value = style.color;
    if (value !== null && !/^(?:[0-9a-f]{6}|auto)$/i.test(value)) throw new DocxError("invalid-format", "Color must be six hexadecimal digits or auto.");
    changes.set("color", value === null ? null : element(run.namespace, "color", { val: value }));
  }
  if (style.fontSizePoints !== undefined) {
    const size = style.fontSizePoints;
    if (size !== null && number(size, 1, 400, "Font size") * 2 % 1) throw new DocxError("invalid-format", "Font size must use half-point steps.");
    changes.set("sz", size === null ? null : element(run.namespace, "sz", { val: size! * 2 }));
  }
  if (style.fontFamily !== undefined) {
    const font = style.fontFamily;
    if (font !== null && (!xmlString(font, "Font family", 100).trim() || /[\r\n\t]/.test(font))) throw new DocxError("invalid-format", "Unsupported font family.");
    // Specify all four script families; theme attributes would otherwise win.
    changes.set("rFonts", font === null ? null : element(run.namespace, "rFonts", { ascii: font, hAnsi: font, eastAsia: font, cs: font }));
  }
  return propertyPatch(state, run, "rPr", changes, R_ORDER);
}

function formatParagraph(state: DocxEditState, paragraph: XmlElement, format: DocxParagraphFormat): DocxPatch {
  object(format, ["styleId", "alignment", "spacingBeforePoints", "spacingAfterPoints", "lineSpacingMultiple"], "paragraph format");
  const changes = new Map<string, string | null>();
  if (format.styleId !== undefined) {
    const id = format.styleId;
    if (id !== null && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(xmlString(id, "Style ID", 64))) throw new DocxError("invalid-format", "Unsupported style identity.");
    changes.set("pStyle", id === null ? null : element(paragraph.namespace, "pStyle", { val: id }));
  }
  if (format.alignment !== undefined) {
    if (format.alignment !== null && !["left", "center", "right", "both"].includes(format.alignment)) throw new DocxError("invalid-format", "Unsupported paragraph alignment.");
    changes.set("jc", format.alignment === null ? null : element(paragraph.namespace, "jc", { val: format.alignment }));
  }
  const spacing = wordChild(wordChild(paragraph, "pPr"), "spacing");
  const attrs: Record<string, string | number> = Object.fromEntries(spacing?.attributes.filter((a) => a.namespace === paragraph.namespace).map((a) => [a.localName, a.value]) || []);
  let changed = false;
  for (const [field, attr] of [["spacingBeforePoints", "before"], ["spacingAfterPoints", "after"], ["lineSpacingMultiple", "line"]] as const) {
    if (format[field] === undefined) continue;
    changed = true;
    const amount = format[field];
    if (amount === null) delete attrs[attr];
    else attrs[attr] = Math.round(number(amount, field === "lineSpacingMultiple" ? 0.5 : 0, field === "lineSpacingMultiple" ? 5 : 1000, field) * (attr === "line" ? 240 : 20));
    if (attr === "line") { if (amount === null) delete attrs.lineRule; else attrs.lineRule = "auto"; }
    if (attr === "before") delete attrs.beforeAutospacing;
    if (attr === "after") delete attrs.afterAutospacing;
  }
  if (changed) changes.set("spacing", Object.keys(attrs).length ? element(paragraph.namespace, "spacing", attrs) : null);
  return propertyPatch(state, paragraph, "pPr", changes, P_ORDER);
}

export function docxPageLayout(root: XmlElement): Readonly<DocxPageLayout> {
  const section = wordChild(wordChild(root, "body"), "sectPr");
  const size = wordChild(section, "pgSz");
  const margin = wordChild(section, "pgMar");
  const twips = (node: XmlElement | undefined, key: string, fallback: number, signed = false) => {
    const text = attribute(node, key);
    return text && (signed ? /^-?\d+$/ : /^\d+$/).test(text) ? Number(text) / 20 : fallback;
  };
  return Object.freeze({
    widthPoints: twips(size, "w", 612), heightPoints: twips(size, "h", 792),
    orientation: attribute(size, "orient") === "landscape" ? "landscape" : "portrait",
    marginTopPoints: twips(margin, "top", 72, true), marginRightPoints: twips(margin, "right", 72),
    marginBottomPoints: twips(margin, "bottom", 72, true), marginLeftPoints: twips(margin, "left", 72),
  });
}

function pageLayout(state: DocxEditState, root: XmlElement, change: DocxPageLayoutChange): DocxPatch {
  object(change, ["paper", "orientation", "marginTopPoints", "marginRightPoints", "marginBottomPoints", "marginLeftPoints"], "page layout");
  const previous = docxPageLayout(root);
  let width = previous.widthPoints;
  let height = previous.heightPoints;
  if (change.paper !== undefined) {
    const papers = { letter: [612, 792], a4: [595.3, 841.9], legal: [612, 1008] };
    if (!Object.hasOwn(papers, change.paper)) throw new DocxError("invalid-format", "Unsupported paper size.");
    [width, height] = papers[change.paper];
  }
  const orientation = change.orientation ?? previous.orientation;
  if (!["portrait", "landscape"].includes(orientation)) throw new DocxError("invalid-format", "Unsupported page orientation.");
  [width, height] = orientation === "landscape" ? [Math.max(width, height), Math.min(width, height)] : [Math.min(width, height), Math.max(width, height)];
  const layout = { ...previous, widthPoints: width, heightPoints: height, ...change };
  for (const key of ["marginTopPoints", "marginRightPoints", "marginBottomPoints", "marginLeftPoints"] as const) number(layout[key], key === "marginTopPoints" || key === "marginBottomPoints" ? -1000 : 0, 1000, key);
  if (layout.marginLeftPoints + layout.marginRightPoints >= width - 36 || layout.marginTopPoints + layout.marginBottomPoints >= height - 36) {
    throw new DocxError("invalid-format", "Margins must leave at least half an inch of writing space.");
  }
  const body = wordChild(root, "body")!;
  const section = wordChild(body, "sectPr");
  const oldMargin = wordChild(section, "pgMar");
  const margins = { top: layout.marginTopPoints * 20, right: layout.marginRightPoints * 20, bottom: layout.marginBottomPoints * 20, left: layout.marginLeftPoints * 20,
    header: attribute(oldMargin, "header") || 720, footer: attribute(oldMargin, "footer") || 720, gutter: attribute(oldMargin, "gutter") || 0 };
  const changes = new Map([
    ["pgSz", element(root.namespace, "pgSz", { w: Math.round(width * 20), h: Math.round(height * 20), orient: orientation })],
    ["pgMar", element(root.namespace, "pgMar", Object.fromEntries(Object.entries(margins).map(([key, v]) => [key, typeof v === "number" ? Math.round(v) : v])))],
  ]);
  if (section) {
    const props = new Map(section.children.map((n) => [n.localName, raw(state, n)]));
    for (const [key, xml] of changes) props.set(key, xml);
    return { start: section.start, end: section.end, text: wrap(state, section, [...props].sort((a, b) => SECTION_ORDER.indexOf(a[0]) - SECTION_ORDER.indexOf(b[0])).map(([, xml]) => xml).join("")) };
  }
  return { start: body.endTagStart, end: body.endTagStart, text: element(root.namespace, "sectPr", {}, [...changes.values()].join("")) };
}

function textRun(namespace: string, text: string): string {
  xmlString(text, "Paragraph text");
  if (/[\n\r\t]/.test(text)) throw new DocxError("invalid-format", "Use separate paragraphs instead of tabs or line breaks.");
  return element(namespace, "r", {}, `<w:t xmlns:w="${namespace}" xml:space="preserve">${escapeXmlText(text)}</w:t>`);
}
function insertionOffset(state: DocxEditState, root: XmlElement, after: string | null | undefined, allowCell = false): number {
  const body = wordChild(root, "body")!;
  if (after === null) return body.startTagEnd;
  if (after === undefined) return wordChild(body, "sectPr")?.start ?? body.endTagStart;
  const paragraph = findNode(state, root, after, "p");
  if (!body.children.includes(paragraph) && !(allowCell && xmlDescendants(root).some((n) => isWord(n, "tc") && n.children.includes(paragraph)))) throw new DocxError("invalid-edit", "Block insertion requires a top-level paragraph.");
  return paragraph.end;
}

export function applyDocxXmlOperation(state: DocxEditState, operation: DocxOperation): DocxEditState {
  const fields: Record<string, readonly string[]> = {
    "format-run": ["type", "runId", "style"], "format-paragraph": ["type", "paragraphId", "format"],
    "set-page-layout": ["type", "layout"], "replace-paragraph": ["type", "paragraphId", "text"],
    "insert-paragraph": ["type", "afterParagraphId", "text"], "delete-paragraph": ["type", "paragraphId"],
    "insert-table": ["type", "afterParagraphId", "rows", "columns", "cells"], "delete-table": ["type", "tableId"],
  };
  if (!operation || !Object.hasOwn(fields, operation.type)) throw new DocxError("invalid-edit", "Unsupported document operation.");
  object(operation, fields[operation.type], "document operation");
  const root = parseXml(state.source);
  const body = wordChild(root, "body")!;
  let patch: DocxPatch;
  switch (operation.type) {
    case "format-run": patch = formatRun(state, findNode(state, root, operation.runId, "r"), operation.style); break;
    case "format-paragraph": patch = formatParagraph(state, findNode(state, root, operation.paragraphId, "p"), operation.format); break;
    case "set-page-layout": patch = pageLayout(state, root, operation.layout); break;
    case "replace-paragraph": {
      const paragraph = findNode(state, root, operation.paragraphId, "p");
      if (xmlDescendants(paragraph).some((n) => isWord(n, "drawing"))) throw new DocxError("invalid-edit", "Delete inline images explicitly before replacing their paragraph.");
      const firstRun = paragraph.children.find((n) => isWord(n, "r") && wordChild(n, "t"));
      const run = firstRun ? wrap(state, firstRun, (wordChild(firstRun, "rPr") ? raw(state, wordChild(firstRun, "rPr")!) : "")
        + `<w:t xmlns:w="${paragraph.namespace}" xml:space="preserve">${escapeXmlText(xmlString(operation.text, "Paragraph text"))}</w:t>`) : textRun(paragraph.namespace, operation.text);
      if (/[\r\n\t]/.test(operation.text)) throw new DocxError("invalid-format", "Use separate paragraphs instead of tabs or line breaks.");
      const starts = paragraph.children.filter((n) => isWord(n, "commentRangeStart")).map((n) => raw(state, n)).join("");
      const ends = paragraph.children.filter((n) => isWord(n, "commentRangeEnd") || (isWord(n, "r") && wordChild(n, "commentReference"))).map((n) => raw(state, n)).join("");
      const content = (wordChild(paragraph, "pPr") ? raw(state, wordChild(paragraph, "pPr")!) : "") + starts + run + ends;
      patch = paragraph.endTagStart < paragraph.startTagEnd
        ? { start: paragraph.start, end: paragraph.end, text: wrap(state, paragraph, content), preserveIdentity: true }
        : { start: paragraph.startTagEnd, end: paragraph.endTagStart, text: content };
      break;
    }
    case "insert-paragraph": {
      const start = insertionOffset(state, root, operation.afterParagraphId, true);
      patch = { start, end: start, text: element(root.namespace, "p", {}, textRun(root.namespace, operation.text)) };
      break;
    }
    case "delete-paragraph": {
      const paragraph = findNode(state, root, operation.paragraphId, "p");
      const parent = xmlDescendants(root).find((n) => n.children.includes(paragraph))!;
      if (paragraph.children.some((n) => isWord(n, "commentRangeStart"))) throw new DocxError("invalid-edit", "Delete paragraph comments before deleting their paragraph.");
      if (xmlDescendants(paragraph).some((n) => isWord(n, "drawing"))) throw new DocxError("invalid-edit", "Delete inline images explicitly before deleting their paragraph.");
      if (parent.children.filter((n) => isWord(n, "p") || isWord(n, "tbl")).length <= 1) {
        throw new DocxError("invalid-edit", "Keep at least one paragraph in a document or table cell.");
      }
      patch = { start: paragraph.start, end: paragraph.end, text: "" };
      break;
    }
    case "insert-table": {
      const rows = number(operation.rows, 1, 100, "Table rows");
      const columns = number(operation.columns, 1, 20, "Table columns");
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows * columns > 1000) throw new DocxError("invalid-format", "Table dimensions must be integers within 1000 cells.");
      if (operation.cells && (!Array.isArray(operation.cells) || operation.cells.length !== rows || operation.cells.some((r) => !Array.isArray(r) || r.length !== columns))) throw new DocxError("invalid-format", "Table cell data must match its dimensions.");
      const layout = docxPageLayout(root);
      const cellWidth = Math.max(360, Math.floor((layout.widthPoints - layout.marginLeftPoints - layout.marginRightPoints) * 20 / columns));
      const grid = element(root.namespace, "tblGrid", {}, Array.from({ length: columns }, () => element(root.namespace, "gridCol", { w: cellWidth })).join(""));
      const tableRows = Array.from({ length: rows }, (_, r) => element(root.namespace, "tr", {}, Array.from({ length: columns }, (_, c) => element(root.namespace, "tc", {},
        element(root.namespace, "tcPr", {}, element(root.namespace, "tcW", { w: cellWidth, type: "dxa" })) + element(root.namespace, "p", {}, textRun(root.namespace, operation.cells?.[r]?.[c] ?? "")))).join(""))).join("");
      const start = insertionOffset(state, root, operation.afterParagraphId);
      patch = { start, end: start, text: element(root.namespace, "tbl", {}, element(root.namespace, "tblPr", {}, element(root.namespace, "tblW", { w: cellWidth * columns, type: "dxa" })) + grid + tableRows) };
      break;
    }
    case "delete-table": {
      const table = findNode(state, root, operation.tableId, "tbl");
      if (!body.children.includes(table)) throw new DocxError("invalid-edit", "Nested table editing is unsupported.");
      if (xmlDescendants(table).some((n) => isWord(n, "commentRangeStart"))) throw new DocxError("invalid-edit", "Delete table comments before deleting their table.");
      if (xmlDescendants(table).some((n) => isWord(n, "drawing"))) throw new DocxError("invalid-edit", "Delete inline images explicitly before deleting their table.");
      if (body.children.filter((n) => isWord(n, "p") || isWord(n, "tbl")).length <= 1) throw new DocxError("invalid-edit", "Keep at least one document block.");
      patch = { start: table.start, end: table.end, text: "" };
      break;
    }
    default: throw new DocxError("invalid-edit", "Unsupported document operation.");
  }
  return patchDocxSource(state, [patch]);
}
