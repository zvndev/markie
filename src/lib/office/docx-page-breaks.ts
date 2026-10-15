/** Original ECMA-376 §17.3.3.1 explicit w:br w:type="page". This is semantic
 * break data only, not font-aware pagination or a promise of identical layout.
 */
import { DocxError, type DocxPageBreak } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { docxRunTextFragment } from "./docx-revisions-range";
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";
interface PageBreak extends DocxPageBreak { node: XmlElement; run: XmlElement; localOffset: number }

export function inspectDocxPageBreaks(state: DocxEditState): { breaks: readonly PageBreak[]; problem?: string } {
  const root = parseXml(state.source);
  const all = xmlDescendants(root);
  const result: PageBreak[] = [];
  for (const paragraph of all.filter((n) => isWord(n, "p"))) {
    let offset = 0;
    for (const run of xmlDescendants(paragraph).filter((n) => isWord(n, "r"))) {
      let localOffset = 0;
      for (const child of run.children) {
        if (isWord(child, "t")) { offset += child.text.length; localOffset += child.text.length; }
        else if (isWord(child, "br")) {
          if (!paragraph.children.includes(run) || xmlAttribute(child, "type", child.namespace) !== "page" || child.children.length || child.text
            || child.attributes.some((a) => a.namespace !== "http://www.w3.org/2000/xmlns/" && !(a.namespace === child.namespace && a.localName === "type"))) return { breaks: [], problem: "Only ordinary direct-run explicit page breaks are editable." };
          if (!state.identities.has(child.start)) state.identities.set(child.start, `page-break~${state.nextId++}`);
          if (!state.identities.has(run.start)) state.identities.set(run.start, `r~${state.nextId++}`);
          result.push({ id: state.identities.get(child.start)!, paragraphId: state.identities.get(paragraph.start)!, runId: state.identities.get(run.start)!, offset,
            node: child, run, localOffset });
          if (result.length > 2000) return { breaks: [], problem: "Too many explicit page breaks." };
        }
      }
    }
  }
  if (all.filter((n) => isWord(n, "br")).length !== result.length) return { breaks: [], problem: "Break is outside a supported paragraph run." };
  return { breaks: result };
}

export function insertDocxPageBreak<T extends DocxEditState>(state: T, paragraphId: string, offset: number): T {
  const root = parseXml(state.source);
  const paragraph = xmlDescendants(root).find((p) => isWord(p, "p") && state.identities.get(p.start) === paragraphId);
  if (!paragraph) throw new DocxError("invalid-break", "Unknown paragraph identity.");
  if (xmlDescendants(paragraph).some((n) => isWord(n) && ["ins", "del"].includes(n.localName))) throw new DocxError("unsupported-break", "Resolve paragraph revisions before inserting a page break.");
  const textOf = (node: XmlElement) => xmlDescendants(node).filter((n) => isWord(n, "t")).map((n) => n.text).join("");
  const text = textOf(paragraph);
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length || (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) throw new DocxError("invalid-break", "Page break offset must be a valid paragraph text boundary.");
  const xml = `<w:r xmlns:w="${paragraph.namespace}"><w:br w:type="page"/></w:r>`;
  let cursor = 0;
  for (const child of paragraph.children) {
    if (!isWord(child, "r") && !isWord(child, "hyperlink")) continue;
    const value = textOf(child);
    if (!value && (wordChild(child, "commentReference") || wordChild(child, "drawing"))) continue;
    if (offset === cursor) return { ...state, ...patchDocxSource(state, [{ start: child.start, end: child.start, text: xml }]) };
    if (offset === cursor + value.length) return { ...state, ...patchDocxSource(state, [{ start: child.end, end: child.end, text: xml }]) };
    if (offset > cursor && offset < cursor + value.length) {
      const textNode = wordChild(child, "t");
      if (!isWord(child, "r") || !textNode || child.children.some((n) => !isWord(n, "rPr") && !isWord(n, "t"))) throw new DocxError("unsupported-break", "Cannot split a hyperlink or mixed object run with a page break.");
      const index = offset - cursor;
      const before = docxRunTextFragment(state.source, child, textNode, textNode.text.slice(0, index));
      const after = docxRunTextFragment(state.source, child, textNode, textNode.text.slice(index));
      return { ...state, ...patchDocxSource(state, [{ start: child.start, end: child.end, text: before + xml + after, preserveIdentity: true }]) };
    }
    cursor += value.length;
  }
  const empty = `<w:r xmlns:w="${paragraph.namespace}"><w:t xml:space="preserve"/></w:r>`;
  if (paragraph.endTagStart < paragraph.startTagEnd) return { ...state, ...patchDocxSource(state, [{ start: paragraph.start, end: paragraph.end, text: state.source.slice(paragraph.start, paragraph.startTagEnd).replace(/\/>$/, ">") + xml + empty + `</${paragraph.name}>`, preserveIdentity: true }]) };
  const end = paragraph.children.find((n) => isWord(n, "commentRangeEnd"))?.start ?? paragraph.endTagStart;
  return { ...state, ...patchDocxSource(state, [{ start: end, end, text: xml }]) };
}

export function removeDocxPageBreak<T extends DocxEditState>(state: T, id: string): T {
  const inspected = inspectDocxPageBreaks(state);
  const selected = inspected.breaks.find((b) => b.id === id);
  if (inspected.problem || !selected) throw new DocxError("invalid-break", inspected.problem || "Unknown page break identity.");
  return { ...state, ...patchDocxSource(state, [{ start: selected.node.start, end: selected.node.end, text: "" }]) };
}
