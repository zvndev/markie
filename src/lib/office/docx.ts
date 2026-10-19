/**
 * Clean-room DOCX foundation. Original implementation from public specifications:
 * ECMA-376 Parts 1/2 (WordprocessingML / OPC), W3C XML, PKWARE APPNOTE.
 * https://ecma-international.org/publications-and-standards/standards/ecma-376/
 * https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document
 * No competing editor source, SDK, demo or engine artifact is used.
 *
 * This is NOT a Word-compatible layout/review engine. It safely edits plain
 * paragraphs/runs in a deliberately narrow subset; other documents are read-only.
 */
import { DEFAULT_ZIP_LIMITS, readZip, resolveZipLimits, writeZip, type ZipEntry, type ZipLimits } from "./zip";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants, XML_NAMESPACE, type XmlElement } from "./xml";
import { DocxError, type DocxDiagnostic, type DocxRun, type DocxParagraph, type DocxDocument, type DocxTextEdit, type DocxOperation } from "./docx-types";
import { applyDocxXmlOperation, docxPageLayout, indexDocxIdentities, patchDocxSource, type DocxPatch } from "./docx-edit";
import { docxEntries, docxPart, ensureDocxNamedStyle, readDocxStyles, readDocxRunStyle, docxStyleResolver } from "./docx-parts";
import { applyDocxCommentOperation, inspectDocxComments } from "./docx-comments";
import { inspectDocxNumbering, setDocxList } from "./docx-numbering";
import { deleteDocxImage, inspectDocxImages, insertDocxImage, type DocxMediaState } from "./docx-media";
import { formatDocxTextRange } from "./docx-revisions-range";
import { applyDocxRevisionOperation, inspectDocxRevisions, projectDocxRevisionView, type DocxRevisionState } from "./docx-revisions";
import { inspectDocxHyperlinks, removeDocxHyperlink, setDocxHyperlink, updateDocxHyperlink } from "./docx-hyperlinks";
import { inspectDocxPageBreaks, insertDocxPageBreak, removeDocxPageBreak } from "./docx-page-breaks";
import { cachedTextRun, invalidateDocxDerived, validDerivedMarker } from "./docx-derived";
import { normalizeDocxRange, replaceDocxSourceRange } from "./docx-structure";
import type { RichTextRange, RichRangeResult } from "./rich-range-types";
export * from "./docx-types";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const R_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const VML = "urn:schemas-microsoft-com:vml";
const OFFICE = "urn:schemas-microsoft-com:office:office";
const encoder = new TextEncoder();

interface Relationship { id: string; type: string; target: string; external: boolean }
interface State extends DocxMediaState, DocxRevisionState {
  original: Uint8Array;
  entries: readonly ZipEntry[];
  mainPart: string;
  originalSource: string;
  runNodes: Map<string, XmlElement>;
  originalRunNodes: Map<string, { text: string; xml: string }>;
  limits: ZipLimits;
}
const states = new WeakMap<DocxDocument, State>();

function word(node: XmlElement, name?: string): boolean {
  return (node.namespace === W || node.namespace === W_STRICT) && (!name || node.localName === name);
}
function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return node?.children.find((c) => word(c, name));
}
function value(node: XmlElement | undefined): string | undefined {
  return node && xmlAttribute(node, "val", node.namespace);
}
function hasNonWhitespace(text: string): boolean {
  return !/^[\x20\t\r\n]*$/.test(text);
}
function readXml(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DocxError("unsupported-encoding", "Only UTF-8 XML parts are currently supported."); }
}

function relationshipSource(name: string): string {
  if (name === "_rels/.rels") return "";
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name);
  if (!match) throw new DocxError("invalid-relationships", `Invalid relationships part: ${name}`);
  return `${match[1] || ""}${match[2]}`;
}

function resolveTarget(source: string, target: string): string {
  // OPC relative part URIs may walk to a parent directory, but not outside the
  // package. Percent aliases, schemes, query/fragment and backslashes fail shut.
  if (!target || /[\\\x00-\x20\x7f:%?#]/.test(target) || target.startsWith("//")) {
    throw new DocxError("invalid-relationships", "Unsupported or unsafe internal relationship target.");
  }
  const pieces = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const piece of target.replace(/^\//, "").split("/")) {
    if (!piece || piece === ".") throw new DocxError("invalid-relationships", "Ambiguous relationship target.");
    if (piece === "..") {
      if (!pieces.length) throw new DocxError("invalid-relationships", "Relationship escapes the package.");
      pieces.pop();
    } else pieces.push(piece);
  }
  return pieces.join("/");
}

function parseRelationships(name: string, root: XmlElement, parts: Map<string, ZipEntry>): Relationship[] {
  const source = relationshipSource(name);
  if (source && !parts.has(source)) throw new DocxError("invalid-relationships", "Relationships source part is missing.");
  if (root.namespace !== REL || root.localName !== "Relationships" || hasNonWhitespace(root.text)) {
    throw new DocxError("invalid-relationships", "Invalid package relationships root.");
  }
  const ids = new Set<string>();
  return root.children.map((node) => {
    const id = xmlAttribute(node, "Id");
    const type = xmlAttribute(node, "Type");
    const target = xmlAttribute(node, "Target");
    const mode = xmlAttribute(node, "TargetMode");
    if (node.namespace !== REL || node.localName !== "Relationship" || node.children.length || hasNonWhitespace(node.text)
      || !id || /\s/.test(id) || ids.has(id) || !type || !/^[a-z][a-z0-9+.-]*:\/\//i.test(type)
      || !target || (mode && mode !== "Internal" && mode !== "External")
      || node.attributes.some((a) => a.namespace !== XMLNS && (a.namespace || !["Id", "Type", "Target", "TargetMode"].includes(a.name)))) {
      throw new DocxError("invalid-relationships", "Invalid, duplicate or unsupported package relationship.");
    }
    ids.add(id);
    const external = mode === "External";
    const resolved = external ? target : resolveTarget(source, target);
    if (!external && (!parts.has(resolved) || resolved.endsWith("/") || resolved === "[Content_Types].xml" || resolved.endsWith(".rels"))) {
      throw new DocxError("invalid-relationships", `Relationship points to a missing or invalid part: ${resolved}`);
    }
    return { id, type, target: resolved, external };
  });
}

function contentTypes(root: XmlElement, parts: Map<string, ZipEntry>): Map<string, string> {
  if (root.namespace !== CT || root.localName !== "Types" || hasNonWhitespace(root.text)) {
    throw new DocxError("invalid-content-types", "DOCX has no valid content-types manifest.");
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const node of root.children) {
    const type = xmlAttribute(node, "ContentType");
    if (node.namespace !== CT || !type || !/^[^\s/]+\/[^\s/]+$/.test(type) || node.children.length || hasNonWhitespace(node.text)) {
      throw new DocxError("invalid-content-types", "Invalid content-type declaration.");
    }
    const allowed = node.localName === "Default" ? ["Extension", "ContentType"] : ["PartName", "ContentType"];
    if (node.attributes.some((a) => a.namespace !== XMLNS && (a.namespace || !allowed.includes(a.name)))) {
      throw new DocxError("invalid-content-types", "Unsupported content-type attributes.");
    }
    if (node.localName === "Default") {
      const extension = xmlAttribute(node, "Extension");
      if (!extension || !/^[a-z0-9_-]+$/i.test(extension) || defaults.has(extension.toLowerCase())) {
        throw new DocxError("invalid-content-types", "Invalid or duplicate default content type.");
      }
      defaults.set(extension.toLowerCase(), type);
    } else if (node.localName === "Override") {
      const name = xmlAttribute(node, "PartName");
      if (!name?.startsWith("/") || !parts.has(name.slice(1)) || overrides.has(name.slice(1))) {
        throw new DocxError("invalid-content-types", "Invalid or duplicate content-type override.");
      }
      overrides.set(name.slice(1), type);
    } else throw new DocxError("invalid-content-types", "Unknown content-type declaration.");
  }
  const result = new Map<string, string>();
  for (const name of parts.keys()) {
    if (name === "[Content_Types].xml" || name.endsWith("/")) continue;
    const type = overrides.get(name) || defaults.get(name.split(".").pop()!.toLowerCase());
    if (!type) throw new DocxError("invalid-content-types", `Part has no declared content type: ${name}`);
    result.set(name, type);
    if (name.endsWith(".rels") && type !== "application/vnd.openxmlformats-package.relationships+xml") {
      throw new DocxError("invalid-content-types", "Relationships part has an invalid content type.");
    }
  }
  return result;
}

const allowedChildren: Record<string, readonly string[]> = {
  document: ["body"], body: ["p", "tbl", "sectPr"], p: ["pPr", "commentRangeStart", "bookmarkStart", "bookmarkEnd", "r", "hyperlink", "ins", "del", "commentRangeEnd", "proofErr"],
  pPr: ["pStyle", "numPr", "jc", "spacing", "ind", "keepNext", "keepLines", "pageBreakBefore", "widowControl"],
  numPr: ["ilvl", "numId"],
  r: ["rPr", "t", "delText", "br", "commentReference", "drawing", "pict", "lastRenderedPageBreak"], rPr: ["b", "i", "u", "color", "sz", "szCs", "rFonts", "rStyle", "lang", "bCs", "iCs", "noProof"],
  hyperlink: ["r"],
  ins: ["r"], del: ["r"],
  sectPr: ["pgSz", "pgMar", "cols", "docGrid", "type"],
  tbl: ["tblPr", "tblGrid", "tr"], tblPr: ["tblW"], tblGrid: ["gridCol"], tr: ["tc"], tc: ["tcPr", "p"], tcPr: ["tcW"],
};
const allowedAttributes: Record<string, readonly string[]> = {
  document: [], body: [], p: ["rsidR", "rsidRDefault", "rsidP", "rsidDel"],
  r: ["rsidR", "rsidRPr", "rsidDel"], pPr: [], rPr: [], sectPr: ["rsidR", "rsidRPr", "rsidSect"],
  t: [], pStyle: ["val"], jc: ["val"], rStyle: ["val"],
  b: ["val"], i: ["val"], bCs: ["val"], iCs: ["val"], u: ["val", "color", "themeColor", "themeTint", "themeShade"],
  color: ["val", "themeColor", "themeTint", "themeShade"], sz: ["val"], szCs: ["val"],
  rFonts: ["ascii", "hAnsi", "eastAsia", "cs", "hint", "asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"],
  lang: ["val", "eastAsia", "bidi"], spacing: ["before", "after", "line", "lineRule", "beforeAutospacing", "afterAutospacing"],
  ind: ["left", "right", "start", "end", "firstLine", "hanging", "leftChars", "rightChars", "firstLineChars", "hangingChars"],
  keepNext: ["val"], keepLines: ["val"], pageBreakBefore: ["val"], widowControl: ["val"],
  pgSz: ["w", "h", "orient", "code"], pgMar: ["top", "right", "bottom", "left", "header", "footer", "gutter"],
  cols: ["equalWidth", "space", "num", "sep"], docGrid: ["type", "linePitch", "charSpace"], type: ["val"],
  tbl: [], tblPr: [], tblGrid: [], gridCol: ["w"], tblW: ["w", "type"], tr: [], tc: [], tcPr: [], tcW: ["w", "type"],
  commentRangeStart: ["id"], commentRangeEnd: ["id"], commentReference: ["id"],
  bookmarkStart: ["id", "name", "colFirst", "colLast"], bookmarkEnd: ["id"], noProof: ["val"],
  numPr: [], ilvl: ["val"], numId: ["val"],
  ins: ["id", "author", "date"], del: ["id", "author", "date"], delText: [],
  hyperlink: ["history", "tooltip"], br: ["type"],
  proofErr: ["type"], lastRenderedPageBreak: [],
};

/** A legacy VML horizontal rule (<w:pict><v:rect o:hr="t"/>) is an opaque,
 * text-free shape. It is preserved byte-for-byte inside its run; any other
 * VML picture (images, text boxes, freeform shapes) stays read-only. */
function isHorizontalRulePict(node: XmlElement): boolean {
  if (!word(node, "pict") || node.children.length !== 1) return false;
  const shape = node.children[0];
  if (shape.namespace !== VML || !["rect", "shape"].includes(shape.localName)) return false;
  const hr = xmlAttribute(shape, "hr", OFFICE);
  if (!hr || !["t", "true", "1", "on"].includes(hr.toLowerCase())) return false;
  return xmlDescendants(node).every((n) => !hasNonWhitespace(n.text) && n.localName !== "imagedata" && n.localName !== "textbox");
}

function safeHorizontalRules(root: XmlElement): XmlElement[] {
  return xmlDescendants(root).filter((n) => word(n, "pict") && isHorizontalRulePict(n));
}

/** Generator templates ship footnotes/endnotes parts holding only separator
 * stubs. Those carry no user content, so the part may ride along untouched;
 * a single real note entry makes the package read-only again. */
function isSeparatorOnlyNotes(root: XmlElement, kind: "footnotes" | "endnotes"): boolean {
  const noteName = kind === "footnotes" ? "footnote" : "endnote";
  if (!word(root, kind) || root.children.length > 8) return false;
  return root.children.every((n) => word(n, noteName)
    && ["separator", "continuationSeparator", "continuationNotice"].includes(xmlAttribute(n, "type", n.namespace) ?? ""));
}

function unsupportedMarkup(root: XmlElement, safeDrawings: readonly XmlElement[] = []): string | undefined {
  const bookmarkStarts = new Map<string, XmlElement>();
  const bookmarkEnds = new Map<string, XmlElement>();
  for (const node of xmlDescendants(root)) {
    if (safeDrawings.some((drawing) => node.start >= drawing.start && node.end <= drawing.end)) continue;
    if (word(node, "bookmarkStart") || word(node, "bookmarkEnd")) {
      const id = xmlAttribute(node, "id", node.namespace);
      const seen = word(node, "bookmarkStart") ? bookmarkStarts : bookmarkEnds;
      if (!id || !/^-?\d{1,10}$/.test(id) || seen.has(id)) return node.name;
      if (word(node, "bookmarkStart") && !xmlAttribute(node, "name", node.namespace)) return node.name;
      seen.set(id, node);
    }
    if (!word(node) || !Object.hasOwn(allowedAttributes, node.localName)) return node.name;
    if (["proofErr", "lastRenderedPageBreak"].includes(node.localName) && !validDerivedMarker(node)) return node.name;
    const allowed = allowedChildren[node.localName] || [];
    if (node.children.some((c) => !word(c) || c.namespace !== node.namespace || !allowed.includes(c.localName))) return node.name;
    if (!["t", "delText"].includes(node.localName) && hasNonWhitespace(node.text)) return node.name;
    if (node.attributes.some((a) => a.namespace !== XMLNS
      && !(["t", "delText"].includes(node.localName) && a.namespace === XML_NAMESPACE && a.localName === "space" && ["default", "preserve"].includes(a.value))
      && !(a.namespace === node.namespace && allowedAttributes[node.localName].includes(a.localName))
      && !(node.localName === "hyperlink" && [R, R_STRICT].includes(a.namespace) && a.localName === "id")
      && !(node.localName === "document" && a.namespace === "http://schemas.openxmlformats.org/markup-compatibility/2006" && a.localName === "Ignorable" && /^[A-Za-z_][A-Za-z0-9_.-]*(?:[\x20\t\r\n]+[A-Za-z_][A-Za-z0-9_.-]*)*$/.test(a.value))
      && !(node.localName === "p" && a.namespace === "http://schemas.microsoft.com/office/word/2010/wordml" && ["paraId", "textId"].includes(a.localName) && /^[0-9A-Fa-f]{8}$/.test(a.value)))) return node.name;
    const names = node.children.map((c) => c.localName);
    if ((node.localName === "document" && names.join() !== "body")
      || (node.localName === "body" && (names.filter((n) => n === "sectPr").length > 1 || (names.includes("sectPr") && names.at(-1) !== "sectPr")))
      || (["p", "r"].includes(node.localName) && (names.filter((n) => n === `${node.localName}Pr`).length > 1
        || (names.includes(`${node.localName}Pr`) && names[0] !== `${node.localName}Pr`)))
      || (node.localName === "r" && names.filter((n) => n === "t").length > 1 && !cachedTextRun(node))) return node.name;
    if (node.localName === "r" && names.includes("commentReference") && (names.includes("t") || names.filter((n) => n === "commentReference").length !== 1)) return node.name;
    if (["pPr", "rPr", "sectPr", "tblPr", "tcPr"].includes(node.localName) && new Set(names).size !== names.length) return node.name;
    if (node.localName === "tbl") {
      const rows = node.children.filter((n) => word(n, "tr"));
      const columns = child(node, "tblGrid")?.children.length || 0;
      if (!columns || columns > 20 || !rows.length || rows.length > 100 || rows.length * columns > 1000
        || names[0] !== "tblPr" || names[1] !== "tblGrid" || rows.some((r) => r.children.length !== columns)) return node.name;
    }
    if (node.localName === "tc" && (!names.includes("p") || names.at(-1) !== "p" || names.filter((n) => n === "tcPr").length > 1 || (names.includes("tcPr") && names[0] !== "tcPr"))) return node.name;
  }
  for (const [id, start] of bookmarkStarts) {
    const end = bookmarkEnds.get(id);
    if (!end || end.start <= start.start) return start.name;
  }
  for (const [id, end] of bookmarkEnds) if (!bookmarkStarts.has(id)) return end.name;
  return undefined;
}

function snapshot(state: State, diagnostics: readonly DocxDiagnostic[], metadata: Readonly<Record<string, string>>, revision: number): DocxDocument {
  const root = parseXml(state.source);
  indexDocxIdentities(state);
  const editable = !diagnostics.some((d) => d.severity === "warning");
  const revisionInspection = inspectDocxRevisions(state);
  const hyperlinks = inspectDocxHyperlinks(state);
  const pageBreaks = inspectDocxPageBreaks(state);
  const revisionForRun = (r: XmlElement) => revisionInspection.ranges.find((range) => r.start > range.node.start && r.end < range.node.end);
  const paragraphByOffset = new Map<number, DocxParagraph>();
  const numbering = inspectDocxNumbering(state).definitions;
  const resolvedStyles = docxStyleResolver(state);
  const listCounts = new Map<string, Map<number, number>>();
  const paragraphs = xmlDescendants(root).filter((n) => word(n, "p")).map((p): DocxParagraph => {
    const styleId = value(child(child(p, "pPr"), "pStyle"));
    const inheritedParagraph = resolvedStyles.paragraph(styleId);
    const pendingParagraph = revisionInspection.ranges.some((range) => range.paragraph.start === p.start);
    const allRuns = xmlDescendants(p).filter((n) => word(n, "r"));
    const readRun = (r: XmlElement, original = false): DocxRun => {
      if (!state.identities.has(r.start)) state.identities.set(r.start, `r~${state.nextId++}`);
      const id = state.identities.get(r.start)!;
      const textNode = child(r, "t");
      const tracked = revisionForRun(r);
      const hyperlink = hyperlinks.links.find((l) => l.runIds.includes(id));
      if (textNode && !tracked && !pendingParagraph) state.runNodes.set(id, textNode);
      const text = xmlDescendants(r).map((n) =>
        word(n, "t") || (original && word(n, "delText")) ? n.text : word(n, "tab") ? "\t" : word(n, "br") ? xmlAttribute(n, "type", n.namespace) === "page" ? "" : "\n" : word(n, "cr") ? "\n" : "").join("");
      const props = child(r, "rPr"), style = Object.freeze(readDocxRunStyle(props));
      return Object.freeze({ id, text, style, resolvedStyle: resolvedStyles.run(styleId, value(child(props, "rStyle")), style, props, text), canEdit: editable && !!textNode && !tracked && !original && !pendingParagraph,
        hyperlinkId: hyperlink?.id, target: hyperlink?.target,
        pageBreaks: Object.freeze(pageBreaks.breaks.filter((b) => b.run.start === r.start).map((b) => Object.freeze({ id: b.id, offset: b.localOffset }))),
      });
    };
    const runs = allRuns.filter((r) => revisionForRun(r)?.type !== "deletion").map((r) => readRun(r));
    const originalRuns = revisionInspection.problem ? undefined : Object.freeze(allRuns.filter((r) => revisionForRun(r)?.type !== "insertion").map((r) => readRun(r, true)));
    const spacing = child(child(p, "pPr"), "spacing");
    const numPr = child(child(p, "pPr"), "numPr");
    const numId = value(child(numPr, "numId"));
    const ilvlText = value(child(numPr, "ilvl"));
    const listLevel = ilvlText && /^\d$/.test(ilvlText) ? Number(ilvlText) : 0;
    const definition = numId ? numbering.get(numId) : undefined;
    const level = definition?.levels.get(listLevel);
    let listNumber: number | undefined;
    if (definition && level) {
      const counters = listCounts.get(definition.id) ?? new Map<number, number>();
      listCounts.set(definition.id, counters);
      listNumber = counters.has(listLevel) ? counters.get(listLevel)! + 1 : level.start;
      counters.set(listLevel, listNumber);
      // Deeper counters restart under a new shallower item unless their own
      // lvlRestart says they only restart after an even shallower change.
      for (const deeper of [...counters.keys()]) {
        if (deeper <= listLevel) continue;
        const restart = definition.levels.get(deeper)?.restart;
        if (restart === undefined || restart > listLevel) counters.delete(deeper);
      }
    }
    const spacingNumber = (name: string, divisor: number) => {
      const text = spacing && xmlAttribute(spacing, name, spacing.namespace);
      return text && /^\d+$/.test(text) ? Number(text) / divisor : undefined;
    };
    const paragraph = Object.freeze({
      id: state.identities.get(p.start)!, text: runs.map((r) => r.text).join(""), runs: Object.freeze(runs),
      styleId, alignment: value(child(child(p, "pPr"), "jc")) ?? inheritedParagraph.alignment ?? undefined,
      spacingBeforePoints: spacingNumber("before", 20) ?? inheritedParagraph.spacingBeforePoints ?? undefined, spacingAfterPoints: spacingNumber("after", 20) ?? inheritedParagraph.spacingAfterPoints ?? undefined,
      lineSpacingMultiple: !spacing || [undefined, "auto"].includes(xmlAttribute(spacing, "lineRule", spacing.namespace)) ? spacingNumber("line", 240) ?? inheritedParagraph.lineSpacingMultiple ?? undefined : undefined,
      listKind: level?.kind, listLevel: level ? listLevel : undefined, listNumber: level?.kind === "numbered" ? listNumber : undefined,
      originalText: originalRuns?.map((r) => r.text).join(""), originalRuns,
      revisionIds: Object.freeze(revisionInspection.ranges.filter((range) => range.paragraph.start === p.start).map((range) => range.id)),
    });
    paragraphByOffset.set(p.start, paragraph);
    return paragraph;
  });
  const body = child(root, "body")!;
  const tables = body.children.filter((n) => word(n, "tbl")).map((table) => Object.freeze({
    id: state.identities.get(table.start)!, rows: Object.freeze(table.children.filter((n) => word(n, "tr")).map((row) => Object.freeze({
      cells: Object.freeze(row.children.filter((n) => word(n, "tc")).map((cell) => Object.freeze({
        paragraphs: Object.freeze(cell.children.filter((n) => word(n, "p")).map((p) => paragraphByOffset.get(p.start)!)),
      }))),
    }))),
  }));
  const blocks = body.children.flatMap((node): DocxDocument["blocks"][number][] => word(node, "p")
    ? [{ kind: "paragraph", paragraphId: state.identities.get(node.start)! }]
    : word(node, "tbl") ? [{ kind: "table", tableId: state.identities.get(node.start)! }] : []);
  const result: DocxDocument = Object.freeze({
    format: "docx", text: paragraphs.map((p) => p.text).join("\n"), paragraphs: Object.freeze(paragraphs),
    tables: Object.freeze(tables), blocks: Object.freeze(blocks.map((b) => Object.freeze(b))), pageLayout: docxPageLayout(root),
    comments: inspectDocxComments(revisionInspection.problem ? state : projectDocxRevisionView(state, "final")).comments, styles: readDocxStyles(state),
    originalText: revisionInspection.problem ? undefined : paragraphs.map((p) => p.originalText).join("\n"),
    revisions: Object.freeze(revisionInspection.ranges.map(({ id, paragraphId, type, author, date, text }) => Object.freeze({ id, paragraphId, type, author, date, text }))),
    images: Object.freeze(inspectDocxImages(state).images.map(({ id, paragraphId, widthPoints, heightPoints, altText, contentType }) => Object.freeze({ id, paragraphId, widthPoints, heightPoints, altText, contentType }))),
    hyperlinks: Object.freeze(hyperlinks.links.map(({ id, paragraphId, text, target, runIds }) => Object.freeze({ id, paragraphId, text, target, runIds }))),
    pageBreaks: Object.freeze(pageBreaks.breaks.map(({ id, paragraphId, runId, offset }) => Object.freeze({ id, paragraphId, runId, offset }))),
    metadata, diagnostics, canEdit: editable, revision, modified: state.source !== state.originalSource || state.partOverrides.size > 0 || state.deletedParts.size > 0,
  });
  states.set(result, state);
  return result;
}

/** Full package preflight precedes exposure of text; no links/resources are fetched. */
export async function openDocx(input: Uint8Array, options: Partial<ZipLimits> = {}): Promise<DocxDocument> {
  const limits = resolveZipLimits(options);
  if (input.length > limits.maxArchiveBytes) throw new DocxError("archive-limit", "DOCX exceeds the archive size limit.");
  const original = new Uint8Array(input);
  const entries = await readZip(original, limits);
  const parts = new Map(entries.map((e) => [e.name, e]));
  const roots = new Map<string, XmlElement>();
  const sources = new Map<string, string>();
  const manifestPart = parts.get("[Content_Types].xml");
  if (!manifestPart) throw new DocxError("invalid-content-types", "DOCX content-types manifest is missing.");
  const manifest = parseXml(readXml(manifestPart.data));
  const types = contentTypes(manifest, parts);
  roots.set("[Content_Types].xml", manifest);
  let xmlCharacters = 0;
  let xmlNodes = 0;
  for (const part of entries) {
    const type = types.get(part.name) || "";
    if (/\.(?:xml|rels)$/i.test(part.name) || /(?:\+xml|\/xml)$/i.test(type)) {
      const source = readXml(part.data);
      xmlCharacters += source.length;
      if (xmlCharacters > 16 * 1024 * 1024) throw new DocxError("xml-limit", "DOCX exceeds the total XML size limit.");
      const partRoot = part.name === "[Content_Types].xml" ? manifest : parseXml(source);
      xmlNodes += xmlDescendants(partRoot).length;
      if (xmlNodes > 200000) throw new DocxError("xml-limit", "DOCX exceeds the total XML structure limit.");
      sources.set(part.name, source);
      roots.set(part.name, partRoot);
    }
  }
  const relationships = new Map<string, Relationship[]>();
  for (const [name, root] of roots) {
    if (name.endsWith(".rels")) relationships.set(relationshipSource(name), parseRelationships(name, root, parts));
  }
  const mainRelationships = relationships.get("")?.filter((r) => r.type === `${R}/officeDocument` || r.type === `${R_STRICT}/officeDocument`);
  if (mainRelationships?.length !== 1 || mainRelationships[0].external) {
    throw new DocxError("missing-document", "Package must have exactly one internal Word document relationship.");
  }
  const mainPart = mainRelationships[0].target;
  if (types.get(mainPart) !== MAIN_TYPE) throw new DocxError("unsupported-document", "Only non-macro DOCX documents are supported.");
  const source = sources.get(mainPart);
  const root = roots.get(mainPart);
  if (source === undefined || !root || !word(root, "document") || root.children.filter((n) => word(n, "body")).length !== 1) {
    throw new DocxError("missing-document", "Word document body is missing or malformed.");
  }
  for (const [name, xmlRoot] of roots) {
    if (name.endsWith(".rels")) continue;
    const ids = new Set(relationships.get(name)?.map((r) => r.id));
    for (const node of xmlDescendants(xmlRoot)) {
      for (const attribute of node.attributes) {
        if ((attribute.namespace === R || attribute.namespace === R_STRICT) && !ids.has(attribute.value)) {
          throw new DocxError("invalid-relationships", `Unresolved relationship reference in ${name}.`);
        }
      }
    }
  }
  const diagnostics: DocxDiagnostic[] = [{ code: "limited-foundation", severity: "info", message: "Supported direct formatting, bounded style/theme display resolution, paragraphs, page properties and basic rectangular tables. No pagination or generic Word compatibility guarantee." }];
  const initialMediaState: DocxMediaState = { source, entries, mainPart, identities: new Map(), nextId: 0, partOverrides: new Map(), deletedParts: new Set() };
  indexDocxIdentities(initialMediaState);
  const hyperlinks = inspectDocxHyperlinks(initialMediaState);
  const pageBreaks = inspectDocxPageBreaks(initialMediaState);
  const media = inspectDocxImages(initialMediaState);
  const unsupported = unsupportedMarkup(root, [...(media.problem ? [] : media.images.map((image) => image.drawing)), ...safeHorizontalRules(root)]);
  if (unsupported) diagnostics.push({ code: "unsupported-markup", severity: "warning", part: mainPart, message: `Read-only: ${unsupported} contains markup outside the safe text-editing subset.` });
  if (media.problem) diagnostics.push({ code: "unsupported-image", severity: "warning", part: mainPart, message: `Read-only: ${media.problem}` });
  if (hyperlinks.problem) diagnostics.push({ code: "unsupported-hyperlink", severity: "warning", part: mainPart, message: `Read-only: ${hyperlinks.problem}` });
  if (pageBreaks.problem) diagnostics.push({ code: "unsupported-page-break", severity: "warning", part: mainPart, message: `Read-only: ${pageBreaks.problem}` });
  for (const [name, type] of types) {
    if (/macro|vba|oleObject|digital-signature/i.test(type) || /^_xmlsignatures\//i.test(name)
      || /(?:^|\/)vbaProject\./i.test(name)) {
      diagnostics.push({ code: "active-or-signed-content", severity: "warning", part: name, message: "Read-only: package contains executable, embedded or signed content." });
    }
  }
  // Part dependencies can carry range/field state even when body markup seems
  // simple. Only inert formatting/metadata dependencies are eligible for edits.
  const safeRelationships = new Set([
    ...[R, R_STRICT].flatMap((namespace) => ["officeDocument", "styles", "theme", "fontTable", "settings", "webSettings", "extended-properties", "custom-properties", "comments", "numbering", "image"].map((kind) => `${namespace}/${kind}`)),
    `${REL}/metadata/core-properties`,
  ]);
  for (const [part, rels] of relationships) {
    for (const rel of rels) {
      const kind = rel.type.slice(rel.type.lastIndexOf("/") + 1);
      if (rel.external && part === mainPart && [R, R_STRICT].some((namespace) => rel.type === `${namespace}/hyperlink`) && hyperlinks.links.some((link) => link.relationshipId === rel.id)) continue;
      if ((kind === "footnotes" || kind === "endnotes") && !rel.external && roots.has(rel.target) && isSeparatorOnlyNotes(roots.get(rel.target)!, kind)) continue;
      if (rel.external || !safeRelationships.has(rel.type)) diagnostics.push({
        code: rel.external ? "external-relationship" : "unsupported-dependency", severity: "warning", part: part || "_rels/.rels",
        message: rel.external ? "Read-only: package contains an external relationship; it was not fetched." : `Read-only: ${kind} dependencies are not supported for safe editing.`,
      });
      else if (kind !== "image" && !roots.has(rel.target)) diagnostics.push({
        code: "opaque-formatting-dependency", severity: "warning", part: rel.target,
        message: "Read-only: a formatting or settings dependency was not inspectable as declared XML.",
      });
    }
  }
  // Protection and tracked-revision settings are honored even without ranges.
  for (const [part, xmlRoot] of roots) {
    if (xmlDescendants(xmlRoot).some((n) => word(n) && ["documentProtection", "writeProtection", "trackRevisions"].includes(n.localName))) {
      diagnostics.push({ code: "protected-or-review-document", severity: "warning", part, message: "Read-only: document protection or tracked-revision settings require a fuller engine." });
    }
  }
  const metadata: Record<string, string> = {};
  const coreRel = relationships.get("")?.find((r) => r.type === `${REL}/metadata/core-properties` && !r.external);
  const core = coreRel && roots.get(coreRel.target);
  if (core) {
    const namespaces = new Set(["http://purl.org/dc/elements/1.1/", "http://purl.org/dc/terms/", "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"]);
    for (const node of core.children) {
      if (namespaces.has(node.namespace) && !node.children.length) metadata[node.localName] = node.text;
    }
  }
  const state: State = { ...initialMediaState, original, originalSource: source, runNodes: new Map(), originalRunNodes: new Map(), limits };
  indexDocxIdentities(state);
  const revisionInspection = inspectDocxRevisions(state);
  if (revisionInspection.problem) diagnostics.push({ code: "unsupported-revisions", severity: "warning", message: `Read-only: ${revisionInspection.problem}` });
  const commentProblem = inspectDocxComments(revisionInspection.problem ? state : projectDocxRevisionView(state, "final")).problem;
  if (commentProblem) diagnostics.push({ code: "unsupported-comments", severity: "warning", message: commentProblem.startsWith("Read-only:") ? commentProblem : `Read-only: ${commentProblem}` });
  const numbering = inspectDocxNumbering(state);
  const unresolvedNumbering = xmlDescendants(root).filter((n) => word(n, "numPr")).some((n) => {
    const definition = numbering.definitions.get(value(child(n, "numId")) || "");
    const ilvl = value(child(n, "ilvl")) ?? "0";
    return !definition || !/^\d$/.test(ilvl) || !definition.levels.has(Number(ilvl));
  });
  if (numbering.problem || unresolvedNumbering) diagnostics.push({ code: "unsupported-numbering", severity: "warning", message: `Read-only: ${numbering.problem || "Paragraph numbering is unresolved or outside the supported levels."}` });
  const document = snapshot(state, Object.freeze(diagnostics.map((d) => Object.freeze(d))), Object.freeze(metadata), 0);
  for (const [id, node] of state.runNodes) state.originalRunNodes.set(id, { text: node.text, xml: source.slice(node.start, node.end) });
  return document;
}

/** Edits are atomic, snapshot-local and only target supported run IDs. */
export function replaceDocxText(document: DocxDocument, edits: readonly DocxTextEdit[]): DocxDocument {
  let state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (!document.canEdit) throw new DocxError("read-only", "This package cannot be safely edited by the current engine.");
  // Validate identities before treating an identical-text edit as a no-op.
  const currentRuns = new Map(document.paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => [run.id, run] as const)));
  if (new Set(edits.map((edit) => edit.runId)).size !== edits.length || edits.some((edit) => !state!.runNodes.has(edit.runId))) throw new DocxError("invalid-edit", "Unknown or duplicate run ID.");
  if (edits.every((edit) => edit.text === currentRuns.get(edit.runId)?.text)) return document;
  state = invalidateDocxDerived(state, true);
  // Derived page markers may have split one logical run into several t nodes.
  // Re-index text targets after coalescing, retaining the original run IDs.
  const refreshed = snapshot({ ...state, runNodes: new Map() }, document.diagnostics, document.metadata, document.revision);
  state = states.get(refreshed)!;
  const seen = new Set<string>();
  const patches: DocxPatch[] = [];
  for (const edit of edits) {
    const node = state.runNodes.get(edit.runId);
    if (!node || seen.has(edit.runId)) throw new DocxError("invalid-edit", "Unknown or duplicate run ID.");
    seen.add(edit.runId);
    if (typeof edit.text !== "string" || /[\t\n]/.test(edit.text)) {
      throw new DocxError("unsupported-edit", "Run replacement cannot insert tabs or paragraph breaks.");
    }
    escapeXmlText(edit.text);
    const original = state.originalRunNodes.get(edit.runId);
    let opening = state.source.slice(node.start, node.startTagEnd);
    // Keep locally declared namespaces on the text node; rebuilding only its
    // QName would unbind a perfectly valid prefix declared here, not on the run.
    opening = /xml:space[\x20\t\r\n]*=/.test(opening)
      ? opening.replace(/xml:space[\x20\t\r\n]*=[\x20\t\r\n]*(["'])[^]*?\1/, 'xml:space="preserve"').replace(/\/>$/, ">")
      : opening.replace(/\/?>$/, ' xml:space="preserve">');
    const text = original?.text === edit.text ? original.xml : `${opening}${escapeXmlText(edit.text)}</${node.name}>`;
    patches.push({ start: node.start, end: node.end, text });
  }
  const next = patchDocxSource(state, patches);
  if (encoder.encode(next.source).length > state.limits.maxEntryBytes) {
    throw new DocxError("edit-limit", "Text edits exceed the document-part size limit.");
  }
  return snapshot({ ...state, ...next, runNodes: new Map() }, document.diagnostics, document.metadata, document.revision + 1);
}

/** Atomic source-preserving split/join/range replacement with mapped selection. */
export function replaceDocxRange(document: DocxDocument, range: RichTextRange, text: string): RichRangeResult<DocxDocument> {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (!document.canEdit) throw new DocxError("read-only", "This package cannot be safely edited by the current engine.");
  if (typeof text !== "string" || text.length > 200000 || /[\r\t]/.test(text)) throw new DocxError("invalid-edit", "Range replacement requires LF-normalized text without tabs.");
  escapeXmlText(text);
  const [start, end] = normalizeDocxRange(document.paragraphs, range);
  const first = document.paragraphs.findIndex((p) => p.id === start.paragraphId), last = document.paragraphs.findIndex((p) => p.id === end.paragraphId);
  const selected = document.paragraphs.slice(first, last + 1).map((p, i, items) => p.text.slice(i === 0 ? start.offset : 0, i === items.length - 1 ? end.offset : undefined)).join("\n");
  if (selected === text) return { document, selection: { anchor: end, focus: end } };
  // Derived-cache invalidation is immutable; failures never alter the input.
  const prepared = invalidateDocxDerived({ ...state, identities: new Map(state.identities) }, true);
  const result = replaceDocxSourceRange(prepared, start, end, text);
  if (encoder.encode(result.state.source).length > state.limits.maxEntryBytes) throw new DocxError("edit-limit", "Range edit exceeds the document-part size limit.");
  const candidate = { ...prepared, ...result.state, runNodes: new Map<string, XmlElement>() };
  const candidateRoot = parseXml(candidate.source);
  const unsupported = unsupportedMarkup(candidateRoot, [...inspectDocxImages(candidate).images.map((image) => image.drawing), ...safeHorizontalRules(candidateRoot)]);
  if (unsupported) throw new DocxError("unsupported-edit", `Range edit produced unsupported markup: ${unsupported}.`);
  const next = snapshot(candidate, document.diagnostics, document.metadata, document.revision + 1);
  const position = { paragraphId: result.paragraphId, offset: result.offset };
  return { document: next, selection: { anchor: position, focus: position } };
}

/** Atomic, immutable rich operations; input snapshots remain usable as undo history. */
export function applyDocxOperations(document: DocxDocument, operations: readonly DocxOperation[]): DocxDocument {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (!document.canEdit) throw new DocxError("read-only", "This package cannot be safely edited by the current engine.");
  if (!Array.isArray(operations) || operations.length > 1000) throw new DocxError("invalid-edit", "Invalid operation batch.");
  let next: State = { ...state, identities: new Map(state.identities), partOverrides: new Map(state.partOverrides) };
  for (const operation of operations) {
    const before = next;
    const textChange = ["replace-paragraph", "delete-paragraph", "insert-paragraph", "insert-table", "delete-table", "track-paragraph-text", "accept-revision", "reject-revision", "accept-all-revisions", "reject-all-revisions"].includes(operation.type);
    next = invalidateDocxDerived(next, textChange);
    const preparedSource = next.source;
    if (["replace-paragraph", "delete-paragraph", "track-paragraph-text"].includes(operation.type) && "paragraphId" in operation) {
      const paragraph = xmlDescendants(parseXml(next.source)).find((n) => word(n, "p") && next.identities.get(n.start) === operation.paragraphId);
      if (paragraph && xmlDescendants(paragraph).some((n) => word(n, "hyperlink") || word(n, "br") || word(n, "pict") || word(n, "bookmarkStart") || word(n, "bookmarkEnd"))) throw new DocxError("unsupported-inline-content", "Remove hyperlinks, bookmarks, horizontal rules and explicit page breaks before replacing, deleting or tracking all paragraph text.");
    }
    if (operation.type === "delete-table") {
      const table = xmlDescendants(parseXml(next.source)).find((n) => word(n, "tbl") && next.identities.get(n.start) === operation.tableId);
      if (table && xmlDescendants(table).some((n) => word(n, "hyperlink") || word(n, "br"))) throw new DocxError("unsupported-inline-content", "Remove table hyperlinks and explicit page breaks before deleting the table.");
    }
    const pending = inspectDocxRevisions(next).ranges;
    const resolves = ["track-paragraph-text", "accept-revision", "reject-revision", "accept-all-revisions", "reject-all-revisions"].includes(operation.type);
    if (!resolves && pending.length) {
      if ((operation.type === "add-comment" || operation.type === "delete-comment")) throw new DocxError("unsupported-revision", "Resolve text revisions before changing comment annotations.");
      if (["replace-paragraph", "delete-paragraph", "format-range"].includes(operation.type) && "paragraphId" in operation && pending.some((r) => r.paragraphId === operation.paragraphId)) throw new DocxError("unsupported-revision", "Resolve paragraph revisions before an untracked replacement, deletion or inline format edit.");
      if (operation.type === "format-run") {
        const run = xmlDescendants(parseXml(next.source)).find((n) => word(n, "r") && next.identities.get(n.start) === operation.runId);
        if (run && pending.some((r) => run.start > r.paragraph.start && run.end < r.paragraph.end)) throw new DocxError("unsupported-revision", "Resolve paragraph revisions before changing run formatting.");
      }
      if (operation.type === "delete-table") {
        const table = xmlDescendants(parseXml(next.source)).find((n) => word(n, "tbl") && next.identities.get(n.start) === operation.tableId);
        if (table && pending.some((r) => r.paragraph.start > table.start && r.paragraph.end < table.end)) throw new DocxError("unsupported-revision", "Resolve table text revisions before deleting the table.");
      }
    }
    if (operation.type === "format-paragraph" && operation.format.styleId) next = ensureDocxNamedStyle(next, operation.format.styleId);
    if (resolves) next = applyDocxRevisionOperation(next, operation as Parameters<typeof applyDocxRevisionOperation>[1]);
    else if (operation.type === "add-comment" || operation.type === "delete-comment") next = applyDocxCommentOperation(next, operation);
    else if (operation.type === "set-list") next = setDocxList(next, operation.paragraphId, operation.kind);
    else if (operation.type === "insert-image") next = insertDocxImage(next, operation);
    else if (operation.type === "delete-image") next = deleteDocxImage(next, operation.imageId);
    else if (operation.type === "format-range") next = formatDocxTextRange(next, operation.paragraphId, operation.start, operation.end, operation.style);
    else if (operation.type === "set-hyperlink") next = setDocxHyperlink(next, operation.paragraphId, operation.start, operation.end, operation.target);
    else if (operation.type === "update-hyperlink") next = updateDocxHyperlink(next, operation.hyperlinkId, operation.target);
    else if (operation.type === "remove-hyperlink") next = removeDocxHyperlink(next, operation.hyperlinkId);
    else if (operation.type === "insert-page-break") next = insertDocxPageBreak(next, operation.paragraphId, operation.offset);
    else if (operation.type === "remove-page-break") next = removeDocxPageBreak(next, operation.pageBreakId);
    else next = { ...next, ...applyDocxXmlOperation(next, operation) };
    // No mutation means no invalidation of the original analysis caches.
    if (next.source === preparedSource && next.partOverrides === before.partOverrides && next.deletedParts === before.deletedParts) next = before;
    if (encoder.encode(next.source).length > state.limits.maxEntryBytes) throw new DocxError("edit-limit", "Document edits exceed the part size limit.");
    for (const part of next.partOverrides.values()) if (part.length > state.limits.maxEntryBytes) throw new DocxError("edit-limit", "Document part edits exceed the size limit.");
    const media = inspectDocxImages(next);
    if (media.problem) throw new DocxError("unsupported-image", media.problem);
    const links = inspectDocxHyperlinks(next);
    if (links.problem) throw new DocxError("unsupported-hyperlink", links.problem);
    const breaks = inspectDocxPageBreaks(next);
    if (breaks.problem) throw new DocxError("unsupported-page-break", breaks.problem);
    const nextRoot = parseXml(next.source);
    const unsupported = unsupportedMarkup(nextRoot, [...media.images.map((image) => image.drawing), ...safeHorizontalRules(nextRoot)]);
    if (unsupported) throw new DocxError("unsupported-edit", `Operation produced unsupported markup: ${unsupported}.`);
    const revisions = inspectDocxRevisions(next);
    if (revisions.problem) throw new DocxError("unsupported-revisions", revisions.problem);
    const commentsProblem = inspectDocxComments(projectDocxRevisionView(next, "final")).problem;
    if (commentsProblem) throw new DocxError("unsupported-comments", commentsProblem);
  }
  return snapshot({ ...state, ...next, runNodes: new Map() }, document.diagnostics, document.metadata, document.revision + 1);
}

/** Untouched (or reverted) snapshots return an owned byte-identical original. */
export async function exportDocx(document: DocxDocument): Promise<Uint8Array> {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (state.source === state.originalSource && !state.partOverrides.size && !state.deletedParts.size) return new Uint8Array(state.original);
  if (!document.canEdit) throw new DocxError("read-only", "Cannot export edits to an unsupported package.");
  const bytes = writeZip(docxEntries(state).map((part) => part.name === state.mainPart ? { name: part.name, data: encoder.encode(state.source) } : part), state.limits);
  // Re-read output before releasing it; size/relationship/XML guarantees apply
  // equally to output. This is not an independent Word fidelity verifier.
  await openDocx(bytes, state.limits);
  return bytes;
}

/** Returns an owned copy for a host-managed Blob URL; never a remote URL. */
export function getDocxImageBytes(document: DocxDocument, imageId: string): Uint8Array {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  const image = inspectDocxImages(state).images.find((i) => i.id === imageId);
  if (!image) throw new DocxError("invalid-image", "Unknown image identity.");
  return new Uint8Array(docxPart(state, image.partName)!);
}

/** Minimal interoperable package authored from the public OPC/WordML vocabulary. */
export async function createDocx(text = ""): Promise<DocxDocument> {
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (line.includes("\t")) throw new DocxError("unsupported-edit", "New plain documents do not support tabs yet.");
    return `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r></w:p>`;
  }).join("");
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${MAIN_TYPE}"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return openDocx(writeZip(Object.entries(parts).map(([name, source]) => ({ name, data: encoder.encode(source) })), DEFAULT_ZIP_LIMITS));
}
