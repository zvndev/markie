/** Source-splice paragraph transactions, not projection serialization.
 * ECMA-376 §17.3.1/17.3.2: paragraph properties supply inherited run context.
 * https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document
 * MS-DOCX §2.6: paraId/textId identify paragraphs, so cloned fragments omit them.
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-docx/a0e7d2e2-2246-44c6-96e8-1cf009823615
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.runproperties
 */
import { DocxError, type DocxParagraph } from "./docx-types";
import { isWord, patchDocxSource, wordChild, type DocxEditState } from "./docx-edit";
import { docxRunTextFragment } from "./docx-revisions-range";
import { escapeXmlText, parseXml, xmlDescendants, type XmlElement } from "./xml";
import type { RichTextRange, RichTextPosition } from "./rich-range-types";

const XMLNS = "http://www.w3.org/2000/xmlns/";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const fail = (message: string): never => { throw new DocxError("unsupported-structure", message); };

export function normalizeDocxRange(paragraphs: readonly DocxParagraph[], range: RichTextRange): [RichTextPosition, RichTextPosition] {
  const check = (position: RichTextPosition) => {
    const index = paragraphs.findIndex((p) => p.id === position?.paragraphId);
    const paragraph = paragraphs[index];
    if (!paragraph || !Number.isInteger(position.offset) || position.offset < 0 || position.offset > paragraph.text.length) throw new DocxError("invalid-range", "Selection endpoint is outside the document.");
    const boundaries = new Set([0, paragraph.text.length, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph.text), (part) => part.index)]);
    if (!boundaries.has(position.offset)) throw new DocxError("invalid-range", "Selection cannot split a grapheme.");
    return index;
  };
  if (!range) throw new DocxError("invalid-range", "A document selection is required.");
  const a = check(range.anchor), b = check(range.focus);
  return a < b || (a === b && range.anchor.offset <= range.focus.offset) ? [range.anchor, range.focus] : [range.focus, range.anchor];
}

/** Validates every owner before preparing a single immutable source patch. */
export function replaceDocxSourceRange(state: DocxEditState, start: RichTextPosition, end: RichTextPosition, text: string): { state: DocxEditState; paragraphId: string; offset: number } {
  const root = parseXml(state.source), all = xmlDescendants(root);
  const paragraphs = all.filter((n) => isWord(n, "p"));
  const first = paragraphs.find((p) => state.identities.get(p.start) === start.paragraphId)!;
  const last = paragraphs.find((p) => state.identities.get(p.start) === end.paragraphId)!;
  if (!first || !last) throw new DocxError("invalid-range", "Unknown source paragraph.");
  const parent = all.find((n) => n.children.includes(first));
  if (!parent) throw new DocxError("invalid-range", "Source paragraph owner is missing.");
  if ((!isWord(parent, "body") && !isWord(parent, "tc")) || !parent.children.includes(last)) fail("Selection must stay within one document body or table cell.");
  const siblings = parent.children.slice(parent.children.indexOf(first), parent.children.indexOf(last) + 1);
  if (!siblings.length || siblings.some((n) => !isWord(n, "p"))) fail("Selection cannot cross a table or another structural owner.");
  const raw = (node: XmlElement) => state.source.slice(node.start, node.end);
  const hasSourceGaps = (node: XmlElement) => {
    let cursor = node.startTagEnd;
    for (const child of node.children) {
      if (/\S/.test(state.source.slice(cursor, child.start))) return true;
      cursor = child.end;
    }
    return /\S/.test(state.source.slice(cursor, node.endTagStart));
  };
  for (let index = 1; index < siblings.length; index++) {
    if (/\S/.test(state.source.slice(siblings[index - 1].end, siblings[index].start))) fail("Unmodeled source gaps between paragraphs require preservation before structural editing.");
  }
  for (const paragraph of siblings) {
    if (hasSourceGaps(paragraph) || raw(paragraph).includes("<!--")) fail("Unmodeled paragraph source gaps or XML comments require preservation before structural editing.");
    if (wordChild(wordChild(paragraph, "pPr"), "sectPr")) fail("Paragraph section boundaries require explicit mapping before structural editing.");
    if (paragraph.children.filter((n) => isWord(n, "r")).some((run) => run.children.filter((n) => isWord(n, "t")).length > 1)) fail("Normalize multiple text nodes before structural editing.");
    if (paragraph.children.some((n) => !isWord(n, "pPr") && !isWord(n, "r"))
      || paragraph.children.filter((n) => isWord(n, "r")).some((run) => run.children.some((n) => !isWord(n, "rPr") && !isWord(n, "t")))) {
      fail("Resolve comments, revisions, hyperlinks, images or authored breaks before structural editing in their paragraph.");
    }
  }
  const property = (paragraph: XmlElement) => { const p = wordChild(paragraph, "pPr"); return p ? raw(p) : ""; };
  const lines = text.split("\n");
  // A suffix moved under a different pPr could silently change named-style
  // inheritance. Until that dependency can be mapped exactly, reject the join.
  const lastLength = last.children.filter((n) => isWord(n, "r")).reduce((length, run) => length + (wordChild(run, "t")?.text.length ?? 0), 0);
  if (first !== last && lines.length === 1 && end.offset < lastLength
    && property(first) !== property(last)) fail("Joining paragraphs with different paragraph properties would change suffix formatting.");
  const fragment = (paragraph: XmlElement, from: number, to: number) => {
    let cursor = 0;
    return paragraph.children.filter((n) => isWord(n, "r")).map((run) => {
      const node = wordChild(run, "t"), value = node?.text ?? "";
      // Empty formatting runs are authored source too. Assign a boundary run
      // to the suffix (right affinity), so split/join cannot silently drop it.
      if (!value.length) return cursor >= from && cursor < to ? raw(run) : "";
      const a = Math.max(from - cursor, 0), b = Math.min(to - cursor, value.length);
      cursor += value.length;
      if (a >= b) return "";
      return a === 0 && b === value.length ? raw(run) : docxRunTextFragment(state.source, run, node!, value.slice(a, b));
    }).join("");
  };
  const runs = first.children.filter((n) => isWord(n, "r"));
  let cursor = 0;
  const prototype = runs.find((run) => { cursor += wordChild(run, "t")?.text.length ?? 0; return cursor >= start.offset; }) ?? runs.at(-1);
  const namespaces = new Map<string, string>();
  for (const ancestor of all.filter((n) => n.start <= first.start && n.end >= first.end)) {
    for (const attr of ancestor.attributes.filter((a) => a.namespace === XMLNS)) namespaces.set(attr.name, attr.value);
  }
  // The insertion run may enter a paragraph with different prefix bindings.
  // Capture its original lexical scope on that run, without rebuilding rPr.
  const insert = (value: string, retainEmpty = false) => {
    if (!value && !retainEmpty) return "";
    if (!prototype) return `<w:r xmlns:w="${first.namespace}"><w:t xml:space="preserve">${escapeXmlText(value)}</w:t></w:r>`;
    const textNode = wordChild(prototype, "t"), props = wordChild(prototype, "rPr");
    let xml = textNode ? docxRunTextFragment(state.source, prototype, textNode, value)
      : state.source.slice(prototype.start, prototype.startTagEnd).replace(/\/>$/, ">") + (props ? raw(props) : "")
        + `<w:t xmlns:w="${first.namespace}" xml:space="preserve">${escapeXmlText(value)}</w:t></${prototype.name}>`;
    const existing = new Set(prototype.attributes.filter((a) => a.namespace === XMLNS).map((a) => a.name));
    const bindings = [...namespaces].filter(([name]) => !existing.has(name)).map(([name, uri]) => ` ${name}="${escapeXmlText(uri).replace(/"/g, "&quot;")}"`).join("");
    xml = xml.replace(/^<[^\s/>]+/, (opening) => opening + bindings);
    return xml;
  };
  const prefix = fragment(first, 0, start.offset), suffix = fragment(last, end.offset, Infinity);
  const paragraphXml = (paragraph: XmlElement, content: string, clone: boolean) => {
    let opening = state.source.slice(paragraph.start, paragraph.startTagEnd).replace(/\/>$/, ">");
    if (clone) {
      for (const attr of paragraph.attributes.filter((a) => a.namespace === W14 && ["paraId", "textId"].includes(a.localName))) {
        opening = opening.replace(new RegExp(`\\s+${attr.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(["'])[^]*?\\1`), "");
      }
    }
    return opening + property(paragraph) + content + `</${paragraph.name}>`;
  };
  // For a join, suffix lexical bindings must match the first paragraph's scope.
  // Different paragraph-local declarations are guarded rather than unbound.
  if (first !== last && lines.length === 1 && suffix && last.attributes.some((a) => a.namespace === XMLNS && namespaces.get(a.name) !== a.value)) fail("Joining these paragraph namespace scopes is not yet supported.");
  const output = lines.map((line, index) => {
    const owner = index === lines.length - 1 && index > 0 ? last : first;
    const lastLine = index === lines.length - 1;
    const length = (index === 0 ? start.offset : 0) + line.length + (lastLine ? lastLength - end.offset : 0);
    // A blank paragraph needs an actual editable source owner for the next
    // input transaction; a projected empty paragraph alone is not typeable.
    const emptyOwner = length === 0 ? insert("", true) : "";
    return paragraphXml(owner, emptyOwner + (index === 0 ? prefix : "") + insert(line) + (lastLine ? suffix : ""), index > 0);
  });
  const next = patchDocxSource(state, [{ start: first.start, end: last.end, text: output.join(""), preserveIdentity: true }]);
  const lastStart = first.start + output.slice(0, -1).join("").length;
  return { state: next, paragraphId: next.identities.get(lastStart)!, offset: (lines.length === 1 ? start.offset : 0) + lines.at(-1)!.length };
}
