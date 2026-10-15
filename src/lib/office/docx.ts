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

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const R_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const encoder = new TextEncoder();

export interface DocxDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning";
  readonly part?: string;
}

export interface DocxRunStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: string;
  readonly color?: string;
  readonly fontFamily?: string;
  readonly fontSizePoints?: number;
}

export interface DocxRun {
  readonly id: string;
  readonly text: string;
  /** Direct formatting only; styles and theme inheritance are not resolved. */
  readonly style: Readonly<DocxRunStyle>;
  readonly canEdit: boolean;
}

export interface DocxParagraph {
  readonly id: string;
  readonly text: string;
  readonly styleId?: string;
  readonly alignment?: string;
  readonly runs: readonly DocxRun[];
}

export interface DocxDocument {
  readonly format: "docx";
  readonly text: string;
  readonly paragraphs: readonly DocxParagraph[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly diagnostics: readonly DocxDiagnostic[];
  readonly canEdit: boolean;
  /** Immutable revision of this in-memory session, not Word revision markup. */
  readonly revision: number;
  readonly modified: boolean;
}

export interface DocxTextEdit {
  readonly runId: string;
  readonly text: string;
}

export class DocxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DocxError";
  }
}

interface Relationship { id: string; type: string; target: string; external: boolean }
interface State {
  original: Uint8Array;
  entries: readonly ZipEntry[];
  mainPart: string;
  source: string;
  runNodes: Map<string, XmlElement>;
  replacements: Map<string, string>;
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
  document: ["body"], body: ["p", "sectPr"], p: ["pPr", "r"],
  pPr: ["pStyle", "jc", "spacing", "ind", "keepNext", "keepLines", "pageBreakBefore", "widowControl"],
  r: ["rPr", "t"], rPr: ["b", "i", "u", "color", "sz", "szCs", "rFonts", "rStyle", "lang", "bCs", "iCs"],
  sectPr: ["pgSz", "pgMar", "cols", "docGrid", "type"],
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
};

function unsupportedMarkup(root: XmlElement): string | undefined {
  for (const node of xmlDescendants(root)) {
    if (!word(node) || !Object.hasOwn(allowedAttributes, node.localName)) return node.name;
    const allowed = allowedChildren[node.localName] || [];
    if (node.children.some((c) => !word(c) || c.namespace !== node.namespace || !allowed.includes(c.localName))) return node.name;
    if (node.localName !== "t" && hasNonWhitespace(node.text)) return node.name;
    if (node.attributes.some((a) => a.namespace !== XMLNS
      && !(node.localName === "t" && a.namespace === XML_NAMESPACE && a.localName === "space" && ["default", "preserve"].includes(a.value))
      && !(a.namespace === node.namespace && allowedAttributes[node.localName].includes(a.localName)))) return node.name;
    const names = node.children.map((c) => c.localName);
    if ((node.localName === "document" && names.join() !== "body")
      || (node.localName === "body" && (names.filter((n) => n === "sectPr").length > 1 || (names.includes("sectPr") && names.at(-1) !== "sectPr")))
      || (["p", "r"].includes(node.localName) && (names.filter((n) => n === `${node.localName}Pr`).length > 1
        || (names.includes(`${node.localName}Pr`) && names[0] !== `${node.localName}Pr`)))
      || (node.localName === "r" && names.filter((n) => n === "t").length > 1)) return node.name;
  }
  return undefined;
}

function runStyle(run: XmlElement): DocxRunStyle {
  const props = child(run, "rPr");
  const onOff = (name: string) => {
    const property = child(props, name);
    return property ? !["false", "0", "off"].includes(value(property) || "true") : undefined;
  };
  const size = value(child(props, "sz"));
  const font = child(props, "rFonts");
  return Object.freeze({
    bold: onOff("b"), italic: onOff("i"), underline: value(child(props, "u")),
    color: value(child(props, "color")), fontFamily: font && xmlAttribute(font, "ascii", font.namespace),
    fontSizePoints: size && /^\d+$/.test(size) ? Number(size) / 2 : undefined,
  });
}

function snapshot(state: State, diagnostics: readonly DocxDiagnostic[], metadata: Readonly<Record<string, string>>, revision: number): DocxDocument {
  const root = parseXml(state.source);
  const editable = !diagnostics.some((d) => d.severity === "warning");
  const paragraphs = xmlDescendants(root).filter((n) => word(n, "p")).map((p, pIndex): DocxParagraph => {
    const runs = xmlDescendants(p).filter((n) => word(n, "r")).map((r, rIndex): DocxRun => {
      const id = `p${pIndex}:r${rIndex}`;
      const textNode = child(r, "t");
      if (textNode) state.runNodes.set(id, textNode);
      const text = state.replacements.get(id) ?? xmlDescendants(r).map((n) =>
        word(n, "t") ? n.text : word(n, "tab") ? "\t" : word(n, "br") || word(n, "cr") ? "\n" : "").join("");
      return Object.freeze({ id, text, style: runStyle(r), canEdit: editable && !!textNode });
    });
    return Object.freeze({
      id: `p${pIndex}`, text: runs.map((r) => r.text).join(""), runs: Object.freeze(runs),
      styleId: value(child(child(p, "pPr"), "pStyle")), alignment: value(child(child(p, "pPr"), "jc")),
    });
  });
  const result: DocxDocument = Object.freeze({
    format: "docx", text: paragraphs.map((p) => p.text).join("\n"), paragraphs: Object.freeze(paragraphs),
    metadata, diagnostics, canEdit: editable, revision, modified: state.replacements.size > 0,
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
  const diagnostics: DocxDiagnostic[] = [{ code: "limited-foundation", severity: "info", message: "Plain-run text editing only. No pagination, style inheritance, review editing or Word compatibility guarantee." }];
  const unsupported = unsupportedMarkup(root);
  if (unsupported) diagnostics.push({ code: "unsupported-markup", severity: "warning", part: mainPart, message: `Read-only: ${unsupported} contains markup outside the safe text-editing subset.` });
  for (const [name, type] of types) {
    if (/macro|vba|oleObject|digital-signature/i.test(type) || /^_xmlsignatures\//i.test(name)
      || /(?:^|\/)vbaProject\./i.test(name)) {
      diagnostics.push({ code: "active-or-signed-content", severity: "warning", part: name, message: "Read-only: package contains executable, embedded or signed content." });
    }
  }
  // Part dependencies can carry range/field state even when body markup seems
  // simple. Only inert formatting/metadata dependencies are eligible for edits.
  const safeRelationships = new Set([
    ...[R, R_STRICT].flatMap((namespace) => ["officeDocument", "styles", "theme", "fontTable", "settings", "webSettings", "extended-properties", "custom-properties"].map((kind) => `${namespace}/${kind}`)),
    `${REL}/metadata/core-properties`,
  ]);
  for (const [part, rels] of relationships) {
    for (const rel of rels) {
      const kind = rel.type.slice(rel.type.lastIndexOf("/") + 1);
      if (rel.external || !safeRelationships.has(rel.type)) diagnostics.push({
        code: rel.external ? "external-relationship" : "unsupported-dependency", severity: "warning", part: part || "_rels/.rels",
        message: rel.external ? "Read-only: package contains an external relationship; it was not fetched." : `Read-only: ${kind} dependencies are not supported for safe editing.`,
      });
      else if (!roots.has(rel.target)) diagnostics.push({
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
  return snapshot({ original, entries, mainPart, source, runNodes: new Map(), replacements: new Map(), limits },
    Object.freeze(diagnostics.map((d) => Object.freeze(d))), Object.freeze(metadata), 0);
}

/** Edits are atomic, snapshot-local and only target supported run IDs. */
export function replaceDocxText(document: DocxDocument, edits: readonly DocxTextEdit[]): DocxDocument {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (!document.canEdit) throw new DocxError("read-only", "This package cannot be safely edited by the current engine.");
  const seen = new Set<string>();
  const replacements = new Map(state.replacements);
  for (const edit of edits) {
    const node = state.runNodes.get(edit.runId);
    if (!node || seen.has(edit.runId)) throw new DocxError("invalid-edit", "Unknown or duplicate run ID.");
    seen.add(edit.runId);
    if (typeof edit.text !== "string" || /[\t\n]/.test(edit.text)) {
      throw new DocxError("unsupported-edit", "Run replacement cannot insert tabs or paragraph breaks.");
    }
    escapeXmlText(edit.text);
    if (edit.text === node.text) replacements.delete(edit.runId);
    else replacements.set(edit.runId, edit.text);
  }
  const replacementBytes = [...replacements.values()].reduce((size, text) => size + encoder.encode(escapeXmlText(text)).length, 0);
  if (replacementBytes + encoder.encode(state.source).length > state.limits.maxEntryBytes) {
    throw new DocxError("edit-limit", "Text edits exceed the document-part size limit.");
  }
  return snapshot({ ...state, runNodes: new Map(), replacements }, document.diagnostics, document.metadata, document.revision + 1);
}

/** Untouched (or reverted) snapshots return an owned byte-identical original. */
export async function exportDocx(document: DocxDocument): Promise<Uint8Array> {
  const state = states.get(document);
  if (!state) throw new DocxError("invalid-session", "DOCX snapshot did not originate from this engine.");
  if (!state.replacements.size) return new Uint8Array(state.original);
  if (!document.canEdit) throw new DocxError("read-only", "Cannot export edits to an unsupported package.");
  const patches = [...state.replacements].map(([id, text]) => ({ node: state.runNodes.get(id)!, text }))
    .sort((a, b) => b.node.start - a.node.start);
  let source = state.source;
  for (const { node, text } of patches) {
    const replacement = `<${node.name} xml:space="preserve">${escapeXmlText(text)}</${node.name}>`;
    source = source.slice(0, node.start) + replacement + source.slice(node.end);
  }
  const bytes = writeZip(state.entries.map((part) => part.name === state.mainPart ? { name: part.name, data: encoder.encode(source) } : part), state.limits);
  // Re-read output before releasing it; size/relationship/XML guarantees apply
  // equally to output. This is not an independent Word fidelity verifier.
  await openDocx(bytes, state.limits);
  return bytes;
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
