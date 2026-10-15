/** Original ECMA-376 §17.13.5 inline insertion/deletion support. This explicitly
 * edits authored w:ins/w:del ranges, not undo history or comment annotations.
 * Paragraph marks, moves, format changes and nested revisions are unsupported.
 * https://ecma-international.org/publications-and-standards/standards/ecma-376/
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/
 */
import { DocxError, type DocxRevision, type DocxRevisionOperation } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState, type DocxPatch } from "./docx-edit";
import { xmlAttributeText } from "./docx-parts";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

export interface DocxRevisionState extends DocxEditState { nextRevisionId?: number }
export interface RevisionRange extends DocxRevision { node: XmlElement; paragraph: XmlElement }
export interface DocxRevisionInspection { ranges: readonly RevisionRange[]; problem?: string }
const attr = (node: XmlElement, name: string) => xmlAttribute(node, name, node.namespace);
const canonicalId = /^(?:0|[1-9]\d{0,9})$/;
const whitespace = /^[\x20\t\r\n]*$/;
const XMLNS = "http://www.w3.org/2000/xmlns/";

function validDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 59 && (m[7] === "Z" || (Number(m[9]) <= 14 && Number(m[10]) <= 59 && (Number(m[9]) !== 14 || Number(m[10]) === 0)));
}

export function inspectDocxRevisions(state: DocxEditState): DocxRevisionInspection {
  const root = parseXml(state.source);
  const all = xmlDescendants(root);
  const revisionNodes = all.filter((n) => isWord(n) && ["ins", "del"].includes(n.localName));
  if (revisionNodes.length > 2000) return { ranges: [], problem: "Too many tracked ranges." };
  const ranges: RevisionRange[] = [];
  const ids = new Set<string>();
  for (const node of revisionNodes) {
    const paragraph = all.find((n) => isWord(n, "p") && n.children.includes(node));
    const id = attr(node, "id"), author = attr(node, "author"), date = attr(node, "date");
    const kind = node.localName === "ins" ? "t" : "delText";
    if (!paragraph || node.namespace !== paragraph.namespace || !id || !canonicalId.test(id) || Number(id) > 2147483647 || ids.has(id)
      || !author?.trim() || author.length > 255 || /[\r\n\t]/.test(author) || !date || !validDate(date)
      || !whitespace.test(node.text) || !node.children.length
      || node.attributes.some((a) => a.namespace !== XMLNS && !(a.namespace === node.namespace && ["id", "author", "date"].includes(a.localName)))
      || node.children.some((r) => !isWord(r, "r") || r.namespace !== node.namespace || r.children.filter((c) => isWord(c, kind)).length !== 1
        || r.children.some((c) => !isWord(c, "rPr") && !isWord(c, kind)))) {
      return { ranges: [], problem: "Only direct, authored and dated plain-run insertion/deletion ranges are editable." };
    }
    ids.add(id);
    ranges.push({ id, paragraphId: state.identities.get(paragraph.start)!, type: node.localName === "ins" ? "insertion" : "deletion", author, date,
      text: node.children.map((r) => wordChild(r, kind)!.text).join(""), node, paragraph });
  }
  for (const text of all.filter((n) => isWord(n, "delText"))) {
    if (!ranges.some((r) => r.type === "deletion" && text.start > r.node.start && text.end < r.node.end)) return { ranges: [], problem: "Deleted text has no supported deletion owner." };
  }
  return { ranges };
}

function renameText(source: string, run: XmlElement, from: string, to: string): string {
  let result = source.slice(run.start, run.end);
  for (const text of xmlDescendants(run).filter((n) => isWord(n, from)).reverse()) {
    const prefix = text.name.includes(":") ? `${text.name.split(":")[0]}:` : "";
    const name = `${prefix}${to}`;
    const opening = `<${name}${source.slice(text.start + 1 + text.name.length, text.startTagEnd)}`;
    const raw = text.endTagStart < text.startTagEnd ? opening : opening + source.slice(text.startTagEnd, text.endTagStart) + `</${name}${source.slice(text.endTagStart + 2 + text.name.length, text.end)}`;
    result = result.slice(0, text.start - run.start) + raw + result.slice(text.end - run.start);
  }
  return result;
}

function ownRunNamespaces(source: string, run: XmlElement, owner: XmlElement, deleted: boolean): string {
  const raw = deleted ? renameText(source, run, "delText", "t") : source.slice(run.start, run.end);
  return attachRunNamespaces(raw, run, owner);
}
function attachRunNamespaces(raw: string, run: XmlElement, owner: XmlElement): string {
  const own = new Set(run.attributes.filter((a) => a.namespace === XMLNS).map((a) => a.name));
  const additions = owner.attributes.filter((a) => a.namespace === XMLNS && !own.has(a.name)).map((a) => ` ${a.name}="${xmlAttributeText(a.value)}"`).join("");
  if (additions) {
    const openingEnd = run.startTagEnd - run.start - 1;
    raw = raw.slice(0, openingEnd).replace(/\/$/, "") + additions + ">" + raw.slice(openingEnd + 1);
  }
  return raw;
}

function restoredRange(source: string, range: RevisionRange, disposition: "accept" | "reject"): string {
  const keep = disposition === "accept" ? range.type === "insertion" : range.type === "deletion";
  return keep ? range.node.children.map((run) => ownRunNamespaces(source, run, range.node, range.type === "deletion")).join("") : "";
}

/** Derived display/validation view only; never exported instead of source. */
export function projectDocxRevisionView<T extends DocxEditState>(state: T, view: "final" | "original"): T {
  const inspected = inspectDocxRevisions(state);
  if (inspected.problem) throw new DocxError("unsupported-revisions", inspected.problem);
  if (!inspected.ranges.length) return state;
  const patches = inspected.ranges.map((range) => ({ start: range.node.start, end: range.node.end, text: restoredRange(state.source, range, view === "final" ? "accept" : "reject") }));
  let next = { ...state, ...patchDocxSource(state, patches) };
  // A whole-paragraph deletion can leave a point comment with no text runs.
  // An empty derived run makes that anchor inspectable without flattening the
  // authoritative deletion, or adding fake visible content to the package.
  const root = parseXml(next.source);
  const empty: DocxPatch[] = [];
  for (const paragraph of xmlDescendants(root).filter((n) => isWord(n, "p"))) {
    if (!paragraph.children.some((n) => isWord(n, "r") && wordChild(n, "t"))) {
      const end = paragraph.children.find((n) => isWord(n, "commentRangeEnd"))?.start ?? paragraph.endTagStart;
      if (end >= paragraph.startTagEnd) empty.push({ start: end, end, text: `<w:r xmlns:w="${paragraph.namespace}"><w:t xml:space="preserve"/></w:r>` });
    }
  }
  if (empty.length) next = { ...next, ...patchDocxSource(next, empty) };
  return next;
}

function replaceTextRun(source: string, run: XmlElement | undefined, namespace: string, text: string): string {
  if (!run) return `<w:r xmlns:w="${namespace}"><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
  const properties = wordChild(run, "rPr");
  const opening = source.slice(run.start, run.startTagEnd).replace(/\/>$/, ">");
  return opening + (properties ? source.slice(properties.start, properties.end) : "") + `<w:t xmlns:w="${namespace}" xml:space="preserve">${escapeXmlText(text)}</w:t></${run.name}>`;
}

export function applyDocxRevisionOperation<T extends DocxRevisionState>(state: T, operation: DocxRevisionOperation): T {
  const inspected = inspectDocxRevisions(state);
  if (inspected.problem) throw new DocxError("unsupported-revisions", inspected.problem);
  if (operation.type !== "track-paragraph-text") {
    const all = operation.type === "accept-all-revisions" || operation.type === "reject-all-revisions";
    const accept = operation.type === "accept-revision" || operation.type === "accept-all-revisions";
    const id = "revisionId" in operation ? operation.revisionId : undefined;
    const selected = all ? inspected.ranges : inspected.ranges.filter((r) => r.id === id);
    if (!all && !selected.length) throw new DocxError("invalid-revision", "Unknown revision identity.");
    const patches = selected.map((range) => ({ start: range.node.start, end: range.node.end, text: restoredRange(state.source, range, accept ? "accept" : "reject") }));
    let next = { ...state, ...patchDocxSource(state, patches) };
    const root = parseXml(next.source);
    const empties: DocxPatch[] = [];
    for (const paragraph of xmlDescendants(root).filter((n) => isWord(n, "p") && selected.some((r) => r.paragraphId === next.identities.get(n.start)))) {
      if (!paragraph.children.some((n) => isWord(n, "ins") || isWord(n, "del") || (isWord(n, "r") && wordChild(n, "t")))) {
        const range = selected.find((r) => r.paragraphId === next.identities.get(paragraph.start))!;
        const run = range.node.children[0];
        const empty = attachRunNamespaces(replaceTextRun(state.source, run, paragraph.namespace, ""), run, range.node);
        const offset = paragraph.children.find((n) => isWord(n, "commentRangeEnd"))?.start ?? paragraph.endTagStart;
        empties.push({ start: offset, end: offset, text: empty });
      }
    }
    if (empties.length) next = { ...next, ...patchDocxSource(next, empties) };
    return next;
  }
  if (typeof operation.text !== "string" || operation.text.length > 200000 || /[\r\n\t]/.test(operation.text)
    || typeof operation.author !== "string" || !operation.author.trim() || operation.author.length > 255 || /[\r\n\t]/.test(operation.author)) throw new DocxError("invalid-revision", "Tracked paragraph text requires one paragraph and a valid author.");
  escapeXmlText(operation.text); escapeXmlText(operation.author);
  const root = parseXml(state.source);
  const paragraph = xmlDescendants(root).find((n) => isWord(n, "p") && state.identities.get(n.start) === operation.paragraphId);
  if (!paragraph) throw new DocxError("invalid-revision", "Unknown paragraph identity.");
  if (xmlDescendants(paragraph).some((n) => isWord(n, "drawing"))) throw new DocxError("unsupported-revision", "Paragraph text tracking cannot replace inline pictures.");
  const current = inspected.ranges.filter((r) => r.paragraphId === operation.paragraphId);
  const directRuns = paragraph.children.filter((n) => isWord(n, "r") && wordChild(n, "t"));
  if (current.length && (current.length > 2 || current.some((r) => r.author !== operation.author) || new Set(current.map((r) => r.type)).size !== current.length || directRuns.some((r) => wordChild(r, "t")!.text))) {
    throw new DocxError("unsupported-revision", "Resolve existing paragraph revisions before tracking another author's replacement.");
  }
  const previousDeleted = current.find((r) => r.type === "deletion");
  const previousInserted = current.find((r) => r.type === "insertion");
  const originalText = previousDeleted?.text ?? (current.length ? "" : directRuns.map((r) => wordChild(r, "t")!.text).join(""));
  const displayed = previousInserted?.text ?? (current.length ? "" : originalText);
  if (displayed === operation.text) return state;
  const namespace = paragraph.namespace;
  let nextId = state.nextRevisionId ?? inspected.ranges.reduce((max, r) => Math.max(max, Number(r.id)), -1) + 1;
  const allocate = () => { if (nextId > 2147483647) throw new DocxError("revision-limit", "Revision identity limit reached."); return String(nextId++); };
  const date = new Date().toISOString();
  const deletionId = previousDeleted?.id ?? (originalText ? allocate() : undefined);
  const insertionId = previousInserted?.id ?? (operation.text ? allocate() : undefined);
  const deletionRuns = previousDeleted ? previousDeleted.node.children.map((r) => ownRunNamespaces(state.source, r, previousDeleted.node, false)).join("") : directRuns.map((run) => renameText(state.source, run, "t", "delText")).join("");
  const baselineRun = previousDeleted?.node.children[0] || directRuns[0] || previousInserted?.node.children[0];
  const baselineOwner = previousDeleted?.node || previousInserted?.node;
  const insertionRun = replaceTextRun(state.source, baselineRun, namespace, operation.text);
  const ownedInsertionRun = baselineRun && baselineOwner ? attachRunNamespaces(insertionRun, baselineRun, baselineOwner) : insertionRun;
  const deleted = deletionId === undefined ? "" : `<w:del xmlns:w="${namespace}" w:id="${deletionId}" w:author="${xmlAttributeText(operation.author)}" w:date="${previousDeleted?.date || date}">${deletionRuns}</w:del>`;
  const inserted = insertionId === undefined || !operation.text ? "" : `<w:ins xmlns:w="${namespace}" w:id="${insertionId}" w:author="${xmlAttributeText(operation.author)}" w:date="${date}">${ownedInsertionRun}</w:ins>`;
  const emptyRun = !deleted && !inserted
    ? baselineRun && baselineOwner ? attachRunNamespaces(replaceTextRun(state.source, baselineRun, namespace, ""), baselineRun, baselineOwner) : replaceTextRun(state.source, baselineRun, namespace, "")
    : "";
  const properties = wordChild(paragraph, "pPr");
  const starts = paragraph.children.filter((n) => isWord(n, "commentRangeStart")).map((n) => state.source.slice(n.start, n.end)).join("");
  const ends = paragraph.children.filter((n) => isWord(n, "commentRangeEnd") || (isWord(n, "r") && wordChild(n, "commentReference"))).map((n) => state.source.slice(n.start, n.end)).join("");
  const contents = (properties ? state.source.slice(properties.start, properties.end) : "") + starts + deleted + inserted + emptyRun + ends;
  const patch = paragraph.endTagStart < paragraph.startTagEnd
    ? { start: paragraph.start, end: paragraph.end, text: state.source.slice(paragraph.start, paragraph.startTagEnd).replace(/\/>$/, ">") + contents + `</${paragraph.name}>`, preserveIdentity: true }
    : { start: paragraph.startTagEnd, end: paragraph.endTagStart, text: contents };
  return { ...state, ...patchDocxSource(state, [patch]), nextRevisionId: nextId };
}
