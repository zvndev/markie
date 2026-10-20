import { DocxError, type DocxRunFormat } from "./docx-types";
import { applyDocxXmlOperation, docxInlineText, isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { escapeXmlText, parseXml, xmlDescendants, type XmlElement } from "./xml";

/** UTF-16 offsets match browser Range text offsets; surrogate pairs are atomic. */
export function formatDocxTextRange<T extends DocxEditState>(state: T, paragraphId: string, start: number, end: number, style: DocxRunFormat): T {
  const root = parseXml(state.source);
  const paragraph = xmlDescendants(root).find((p) => isWord(p, "p") && state.identities.get(p.start) === paragraphId);
  if (!paragraph) throw new DocxError("invalid-edit", "Unknown paragraph identity.");
  if (xmlDescendants(paragraph).some((n) => isWord(n) && ["ins", "del"].includes(n.localName))) throw new DocxError("unsupported-edit", "Resolve paragraph revisions before changing inline formatting.");
  // Offsets are the snapshot's visible paragraph text: tab, line-break and
  // other non-typeable runs count, but can never be part of a formatted range.
  const runs = xmlDescendants(paragraph).filter((n) => isWord(n, "r"));
  const text = runs.map((r) => docxInlineText(r)).join("");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) throw new DocxError("invalid-range", "Select a nonempty text range inside one paragraph.");
  const splitsSurrogate = (offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
  if (splitsSurrogate(start) || splitsSurrogate(end)) throw new DocxError("invalid-range", "Selection cannot split a Unicode character.");
  let cursor = 0;
  const selected: { id: string; start: number; end: number }[] = [];
  for (const run of runs) {
    const content = docxInlineText(run);
    const localStart = Math.max(0, start - cursor), localEnd = Math.min(content.length, end - cursor);
    if (localStart < localEnd) {
      if (run.children.some((c) => !isWord(c, "rPr") && !isWord(c, "t")) || run.children.filter((c) => isWord(c, "t")).length !== 1) throw new DocxError("unsupported-edit", "Selection intersects a mixed text/object run.");
      selected.push({ id: state.identities.get(run.start)!, start: localStart, end: localEnd });
    }
    cursor += content.length;
  }
  let next = state;
  for (const selectedRun of selected.reverse()) {
    const current = xmlDescendants(parseXml(next.source)).find((r) => isWord(r, "r") && next.identities.get(r.start) === selectedRun.id)!;
    const textNode = wordChild(current, "t")!;
    const makeFragment = (text: string) => docxRunTextFragment(next.source, current, textNode, text);
    const prefix = selectedRun.start ? makeFragment(textNode.text.slice(0, selectedRun.start)) : "";
    const middle = makeFragment(textNode.text.slice(selectedRun.start, selectedRun.end));
    const suffix = selectedRun.end < textNode.text.length ? makeFragment(textNode.text.slice(selectedRun.end)) : "";
    const selectedOffset = current.start + prefix.length;
    const split = patchDocxSource(next, [{ start: current.start, end: current.end, text: prefix + middle + suffix, preserveIdentity: true }]);
    if (!split.identities.has(selectedOffset)) split.identities.set(selectedOffset, `r~${split.nextId++}`);
    const selectedId = split.identities.get(selectedOffset)!;
    next = { ...next, ...applyDocxXmlOperation(split, { type: "format-run", runId: selectedId, style }) };
  }
  return next;
}

export function docxRunTextFragment(source: string, run: XmlElement, textNode: XmlElement, text: string): string {
  let opening = source.slice(textNode.start, textNode.startTagEnd);
  opening = /xml:space[\x20\t\r\n]*=/.test(opening)
    ? opening.replace(/xml:space[\x20\t\r\n]*=[\x20\t\r\n]*(["'])[^]*?\1/, 'xml:space="preserve"').replace(/\/>$/, ">")
    : opening.replace(/\/?>$/, ' xml:space="preserve">');
  return source.slice(run.start, textNode.start) + opening + escapeXmlText(text) + `</${textNode.name}>` + source.slice(textNode.end, run.end);
}
