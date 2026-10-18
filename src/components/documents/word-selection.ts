import type { RichDocument } from "@/lib/office/rich-text-types";
import type { RichTextPosition, RichTextRange } from "@/lib/office/rich-range-types";

/** Session-only DOM bookmarks. Source positions never depend on span/run identities. */
export function readWordSelection(host: HTMLElement): RichTextRange | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return null;
  const position = (node: Node, offset: number): RichTextPosition | null => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
    const paragraph = element?.closest<HTMLElement>("[data-paragraph-id]");
    if (!paragraph || !host.contains(paragraph)) return null;
    const range = document.createRange(); range.selectNodeContents(paragraph); range.setEnd(node, offset);
    return { paragraphId: paragraph.dataset.paragraphId!, offset: range.toString().length };
  };
  const anchor = position(selection.anchorNode, selection.anchorOffset), focus = position(selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

export function restoreWordSelection(host: HTMLElement, selection: RichTextRange): void {
  const point = (position: RichTextPosition) => {
    const paragraph = [...host.querySelectorAll<HTMLElement>("[data-paragraph-id]")].find((node) => node.dataset.paragraphId === position.paragraphId);
    if (!paragraph) return null;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode(), offset = position.offset;
    while (node && offset > (node.textContent?.length ?? 0)) { offset -= node.textContent?.length ?? 0; node = walker.nextNode(); }
    return { paragraph, node: node ?? paragraph, offset: node ? Math.min(offset, node.textContent?.length ?? 0) : 0 };
  };
  const anchor = point(selection.anchor), focus = point(selection.focus);
  if (!anchor || !focus) return;
  anchor.paragraph.focus();
  const dom = window.getSelection();
  dom?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

export function orderedWordRange(document: RichDocument, range: RichTextRange): [RichTextPosition, RichTextPosition] {
  const a = document.paragraphs.findIndex((paragraph) => paragraph.id === range.anchor.paragraphId);
  const b = document.paragraphs.findIndex((paragraph) => paragraph.id === range.focus.paragraphId);
  return a < b || a === b && range.anchor.offset <= range.focus.offset ? [range.anchor, range.focus] : [range.focus, range.anchor];
}

export function wordRangeText(document: RichDocument, range: RichTextRange): string {
  const [start, end] = orderedWordRange(document, range);
  const first = document.paragraphs.findIndex((paragraph) => paragraph.id === start.paragraphId), last = document.paragraphs.findIndex((paragraph) => paragraph.id === end.paragraphId);
  return document.paragraphs.slice(first, last + 1).map((paragraph, index, paragraphs) => paragraph.text.slice(index === 0 ? start.offset : 0, index === paragraphs.length - 1 ? end.offset : paragraph.text.length)).join("\n");
}
