/** Passive Word analysis caches, authored from ISO/IEC 29500 descriptions:
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.prooferror
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.lastrenderedpagebreak
 * Unmatched proofing anchors are explicitly ignorable. These are not authored
 * breaks, bookmarks or permission ranges, and never add visible text.
 */
import { isWord, patchDocxSource, type DocxEditState, type DocxPatch } from "./docx-edit";
import { escapeXmlText, parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";

export function validDerivedMarker(node: XmlElement): boolean {
  if (!isWord(node) || node.children.length || node.text) return false;
  return node.localName === "lastRenderedPageBreak" || (node.localName === "proofErr"
    && ["spellStart", "spellEnd", "gramStart", "gramEnd"].includes(xmlAttribute(node, "type", node.namespace) ?? ""));
}

/** A calculated page boundary may split a single logical text run into t nodes. */
export function cachedTextRun(node: XmlElement): boolean {
  const content = node.children.filter((child) => !isWord(child, "rPr"));
  return content.some((child) => isWord(child, "lastRenderedPageBreak"))
    && content.every((child) => isWord(child, "t") || isWord(child, "lastRenderedPageBreak"))
    && content.every((child, index) => !isWord(child, "t") || index === 0 || !isWord(content[index - 1], "t"));
}

/** Mutations invalidate calculated pagination; text changes also invalidate
 * proofing. Work on a new source only, so failed edits and undo keep originals.
 */
export function invalidateDocxDerived<T extends DocxEditState>(state: T, proofing: boolean): T {
  const root = parseXml(state.source), nodes = xmlDescendants(root), patches: DocxPatch[] = [];
  const merged = nodes.filter((node) => isWord(node, "r") && cachedTextRun(node) && node.children.filter((child) => isWord(child, "t")).length > 1);
  const mergedChildren = new Set(merged.flatMap((run) => run.children));
  for (const run of merged) {
    const texts = run.children.filter((node) => isWord(node, "t")), first = texts[0];
    // Keep the first text node's namespace bindings while combining only the
    // marker-separated text. All run properties remain verbatim.
    const opening = `<${first.name}${state.source.slice(first.start + 1 + first.name.length, first.startTagEnd)}`.replace(/\/>$/, ">");
    const spaced = /xml:space[\x20\t\r\n]*=/.test(opening)
      ? opening.replace(/xml:space[\x20\t\r\n]*=[\x20\t\r\n]*(["'])[^]*?\1/, 'xml:space="preserve"')
      : opening.replace(/>$/, ' xml:space="preserve">');
    const contents = run.children.map((node) => node === first ? spaced + escapeXmlText(texts.map((text) => text.text).join("")) + `</${first.name}>`
      : isWord(node, "t") || isWord(node, "lastRenderedPageBreak") ? "" : state.source.slice(node.start, node.end)).join("");
    patches.push({ start: run.startTagEnd, end: run.endTagStart, text: contents });
  }
  for (const node of nodes) {
    if ((isWord(node, "lastRenderedPageBreak") || (proofing && isWord(node, "proofErr")))
      && !mergedChildren.has(node)) patches.push({ start: node.start, end: node.end, text: "" });
  }
  return patches.length ? { ...state, ...patchDocxSource(state, patches) } : state;
}
