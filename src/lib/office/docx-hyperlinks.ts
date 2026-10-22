/** Original ECMA-376 §17.16.22 text hyperlinks + OPC external relationships.
 * Only explicit web/simple-mail destinations are represented; nothing is
 * fetched, launched or interpreted as active content by this package layer.
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/df06e423-11a6-4a36-bfb3-82139e531781
 */
import { DocxError, type DocxHyperlink } from "./docx-types";
import { docxInlineText, isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { appendDocxXml, declareDocxRelationshipPart, DOCX_R, DOCX_R_STRICT, DOCX_REL, docxPartSource, docxRelationshipsPart, xmlAttributeText, type DocxPartsState } from "./docx-parts";
import { docxRunTextFragment } from "./docx-revisions-range";
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

const encoder = new TextEncoder();
const XMLNS = "http://www.w3.org/2000/xmlns/";
type LinkState = DocxEditState & DocxPartsState;
interface Link extends DocxHyperlink { node: XmlElement; relationshipId: string }

export function safeDocxHyperlinkTarget(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\s\x00-\x20\x7f\\]/u.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw new DocxError("unsafe-link", "Link destination contains unsupported whitespace or control characters.");
  let target: URL;
  try { target = new URL(value); } catch { throw new DocxError("unsafe-link", "Link must be an explicit HTTP, HTTPS or simple mailto URL."); }
  if (["https:", "http:"].includes(target.protocol) && /^https?:\/\//i.test(value) && target.hostname && !target.username && !target.password) return target.href;
  if (target.protocol === "mailto:" && !target.search && !target.hash && !value.includes("%") && /^mailto:[A-Za-z0-9.!$&'*+\/=^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/i.test(value)) return target.href;
  throw new DocxError("unsafe-link", "Only credential-free HTTP/HTTPS and simple mailto destinations are supported.");
}

/** A destination that may be preserved untouched (never fetched or followed
 * here). Script, data and file-system schemes run or open something when
 * clicked in Word, so they keep the package read-only. Scheme-less targets are
 * what some generators write for bare web addresses. */
export function preservableDocxHyperlinkTarget(value: string | undefined): boolean {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1].toLowerCase();
  return scheme === undefined ? !/^[\\/]|\.\.|^[A-Za-z]:/.test(value) : ["http", "https", "mailto", "tel"].includes(scheme);
}

export function inspectDocxHyperlinks(state: LinkState): { links: readonly Link[]; problem?: string } {
  const root = parseXml(state.source);
  const all = xmlDescendants(root);
  const links: Link[] = [];
  const source = docxPartSource(state, docxRelationshipsPart(state.mainPart));
  const rels = source ? parseXml(source).children : [];
  const nodes = all.filter((n) => isWord(n, "hyperlink"));
  if (nodes.length > 2000) return { links: [], problem: "Too many text hyperlinks." };
  for (const node of nodes) {
    const paragraph = all.find((p) => isWord(p, "p") && p.children.includes(node));
    const r = node.namespace.includes("purl.oclc.org") ? DOCX_R_STRICT : DOCX_R;
    const id = xmlAttribute(node, "id", r);
    const relation = rels.find((rel) => xmlAttribute(rel, "Id") === id && xmlAttribute(rel, "Type") === `${r}/hyperlink` && xmlAttribute(rel, "TargetMode") === "External");
    const history = xmlAttribute(node, "history", node.namespace);
    const tooltip = xmlAttribute(node, "tooltip", node.namespace);
    if (!paragraph || !node.children.length || !/^[\x20\t\r\n]*$/.test(node.text)
      || node.attributes.some((a) => a.namespace !== XMLNS && !(a.namespace === r && a.localName === "id") && !(a.namespace === node.namespace && ["history", "tooltip", "anchor", "docLocation", "tgtFrame"].includes(a.localName)))
      || node.children.some((run) => !isWord(run, "r") || run.namespace !== node.namespace)) return { links: [], problem: "Only direct ordinary text hyperlinks are editable." };
    // Internal anchors (tables of contents, cross references), non-web
    // destinations and links over mixed run content are kept as opaque
    // containers: preserved verbatim, never followed or exposed as a target,
    // while their plain text runs stay editable like any other run.
    if (relation && !preservableDocxHyperlinkTarget(xmlAttribute(relation, "Target"))) return { links: [], problem: "Hyperlink destination is unsafe or unsupported." };
    let target: string | undefined;
    try { target = relation && !xmlAttribute(node, "anchor", node.namespace) && !xmlAttribute(node, "docLocation", node.namespace) ? safeDocxHyperlinkTarget(xmlAttribute(relation, "Target")) : undefined; } catch { target = undefined; }
    const ordinary = !!target && (!history || ["true", "false", "on", "off", "0", "1"].includes(history)) && (tooltip?.length ?? 0) <= 260
      && node.children.every((run) => wordChild(run, "t") && run.children.every((c) => isWord(c, "rPr") || isWord(c, "t")) && run.children.filter((c) => isWord(c, "t")).length === 1);
    if (!ordinary || !target || !id) {
      for (const run of node.children) if (!state.identities.has(run.start)) state.identities.set(run.start, `r~${state.nextId++}`);
      continue;
    }
    if (!state.identities.has(node.start)) state.identities.set(node.start, `hyperlink~${state.nextId++}`);
    for (const run of node.children) if (!state.identities.has(run.start)) state.identities.set(run.start, `r~${state.nextId++}`);
    links.push({ id: state.identities.get(node.start)!, paragraphId: state.identities.get(paragraph.start)!, text: node.children.map((run) => wordChild(run, "t")!.text).join(""), target,
      runIds: Object.freeze(node.children.map((run) => state.identities.get(run.start)!)), node, relationshipId: id });
  }
  return { links };
}

function addRelationship<T extends LinkState>(state: T, target: string): { state: T; id: string } {
  const name = docxRelationshipsPart(state.mainPart);
  const source = docxPartSource(state, name) || `<Relationships xmlns="${DOCX_REL}"/>`;
  const ids = new Set(parseXml(source).children.map((n) => xmlAttribute(n, "Id")));
  let id = "rIdLink1";
  for (let n = 2; ids.has(id); n++) id = `rIdLink${n}`;
  const r = parseXml(state.source).namespace.includes("purl.oclc.org") ? DOCX_R_STRICT : DOCX_R;
  const partOverrides = new Map(state.partOverrides);
  partOverrides.set(name, encoder.encode(appendDocxXml(source, `<Relationship xmlns="${DOCX_REL}" Id="${id}" Type="${r}/hyperlink" Target="${xmlAttributeText(target)}" TargetMode="External"/>`)));
  const manifest = docxPartSource(state, "[Content_Types].xml")!;
  const updatedManifest = declareDocxRelationshipPart(manifest, name);
  if (updatedManifest !== manifest) partOverrides.set("[Content_Types].xml", encoder.encode(updatedManifest));
  return { state: { ...state, partOverrides }, id };
}
function removeUnusedRelationship<T extends LinkState>(state: T, id: string): T {
  if (xmlDescendants(parseXml(state.source)).some((n) => n.attributes.some((a) => [DOCX_R, DOCX_R_STRICT].includes(a.namespace) && a.value === id))) return state;
  const name = docxRelationshipsPart(state.mainPart);
  const source = docxPartSource(state, name)!;
  const relation = parseXml(source).children.find((n) => xmlAttribute(n, "Id") === id)!;
  const partOverrides = new Map(state.partOverrides);
  partOverrides.set(name, encoder.encode(source.slice(0, relation.start) + source.slice(relation.end)));
  return { ...state, partOverrides };
}

export function setDocxHyperlink<T extends LinkState>(state: T, paragraphId: string, start: number, end: number, targetValue: string): T {
  const target = safeDocxHyperlinkTarget(targetValue);
  const root = parseXml(state.source);
  const paragraph = xmlDescendants(root).find((n) => isWord(n, "p") && state.identities.get(n.start) === paragraphId);
  if (!paragraph) throw new DocxError("invalid-link", "Unknown paragraph identity.");
  const runs = xmlDescendants(paragraph).filter((n) => isWord(n, "r"));
  const text = runs.map((r) => docxInlineText(r)).join("");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length
    || [start, end].some((offset) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) throw new DocxError("invalid-link", "Select a valid nonempty text range inside one paragraph.");
  let cursor = 0;
  const selected: { run: XmlElement; start: number; end: number }[] = [];
  for (const run of runs) {
    const value = docxInlineText(run);
    if (cursor < end && cursor + value.length > start) {
      if (!paragraph.children.includes(run) || run.children.some((n) => !isWord(n, "rPr") && !isWord(n, "t")) || run.children.filter((n) => isWord(n, "t")).length !== 1) throw new DocxError("unsupported-link", "Selection intersects an existing link, revision or inline object.");
      selected.push({ run, start: Math.max(0, start - cursor), end: Math.min(value.length, end - cursor) });
    }
    cursor += value.length;
  }
  const first = selected[0], last = selected.at(-1)!;
  const interior = paragraph.children.filter((n) => n.start > first.run.start && n.end < last.run.end);
  if (interior.some((n) => !isWord(n, "r") || n.children.some((c) => !isWord(c, "rPr") && !isWord(c, "t")))) throw new DocxError("unsupported-link", "A link cannot absorb comments, breaks or other inline containers.");
  const slice = (entry: typeof first, from: number, to: number) => docxRunTextFragment(state.source, entry.run, wordChild(entry.run, "t")!, wordChild(entry.run, "t")!.text.slice(from, to));
  const prefix = first.start ? slice(first, 0, first.start) : "";
  const suffix = last.end < wordChild(last.run, "t")!.text.length ? slice(last, last.end, wordChild(last.run, "t")!.text.length) : "";
  const contents = first === last ? slice(first, first.start, first.end)
    : slice(first, first.start, wordChild(first.run, "t")!.text.length) + state.source.slice(first.run.end, last.run.start) + slice(last, 0, last.end);
  const rel = addRelationship(state, target);
  const r = paragraph.namespace.includes("purl.oclc.org") ? DOCX_R_STRICT : DOCX_R;
  const xml = `${prefix}<w:hyperlink xmlns:w="${paragraph.namespace}" xmlns:r="${r}" r:id="${rel.id}">${contents}</w:hyperlink>${suffix}`;
  const next = { ...rel.state, ...patchDocxSource(state, [{ start: first.run.start, end: last.run.end, text: xml }]) };
  inspectDocxHyperlinks(next);
  return next;
}

export function updateDocxHyperlink<T extends LinkState>(state: T, id: string, targetValue: string): T {
  const target = safeDocxHyperlinkTarget(targetValue);
  const inspected = inspectDocxHyperlinks(state);
  const link = inspected.links.find((l) => l.id === id);
  if (inspected.problem || !link) throw new DocxError("invalid-link", inspected.problem || "Unknown hyperlink identity.");
  const rel = addRelationship(state, target);
  const attrs = link.node.attributes.map((a) => `${a.name}="${xmlAttributeText([DOCX_R, DOCX_R_STRICT].includes(a.namespace) && a.localName === "id" ? rel.id : a.value)}"`).join(" ");
  const opening = `<${link.node.name}${attrs ? ` ${attrs}` : ""}>`;
  return removeUnusedRelationship({ ...rel.state, ...patchDocxSource(state, [{ start: link.node.start, end: link.node.startTagEnd, text: opening, preserveIdentity: true }]) }, link.relationshipId);
}

export function removeDocxHyperlink<T extends LinkState>(state: T, id: string): T {
  const inspected = inspectDocxHyperlinks(state);
  const link = inspected.links.find((l) => l.id === id);
  if (inspected.problem || !link) throw new DocxError("invalid-link", inspected.problem || "Unknown hyperlink identity.");
  const contents = link.node.children.map((run) => {
    const raw = state.source.slice(run.start, run.end);
    const own = new Set(run.attributes.filter((a) => a.namespace === XMLNS).map((a) => a.name));
    const attrs = link.node.attributes.filter((a) => a.namespace === XMLNS && !own.has(a.name)).map((a) => ` ${a.name}="${xmlAttributeText(a.value)}"`).join("");
    const offset = run.startTagEnd - run.start - 1;
    return attrs ? raw.slice(0, offset) + attrs + raw.slice(offset) : raw;
  }).join("");
  return removeUnusedRelationship({ ...state, ...patchDocxSource(state, [{ start: link.node.start, end: link.node.end, text: contents }]) }, link.relationshipId);
}
