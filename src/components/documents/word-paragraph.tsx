import { useLayoutEffect, useRef } from "react";
import type { DocxParagraph, DocxTextEdit } from "@/lib/office/docx";

function caretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(root); range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}
function placeCaret(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode(), remaining = offset;
  while (node && remaining > (node.textContent?.length ?? 0)) { remaining -= node.textContent?.length ?? 0; node = walker.nextNode(); }
  const range = document.createRange();
  if (node) range.setStart(node, Math.min(remaining, node.textContent?.length ?? 0));
  else { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
function selectionOffsets(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return { start: root.textContent?.length ?? 0, end: root.textContent?.length ?? 0 };
  const selected = selection.getRangeAt(0);
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return { start: 0, end: 0 };
  const before = document.createRange(); before.selectNodeContents(root); before.setEnd(selected.startContainer, selected.startOffset);
  const through = document.createRange(); through.selectNodeContents(root); through.setEnd(selected.endContainer, selected.endOffset);
  return { start: before.toString().length, end: through.toString().length };
}
interface WordParagraphProps {
  paragraph: DocxParagraph;
  index: number;
  readOnly: boolean;
  selected: boolean;
  onSelect: (paragraphId: string, runId?: string) => void;
  onReplace: (paragraphId: string, text: string) => void;
  onRuns: (edits: DocxTextEdit[]) => void;
  onSplit: (paragraphId: string, offset: number) => void;
  onPasteParagraphs: (paragraphId: string, start: number, end: number, text: string) => void;
  onSelection?: (paragraphId: string, start: number, end: number) => void;
  trackText?: boolean;
  reconcileToken?: number;
  onRemovePageBreaks: (ids: string[]) => void;
  onRejectStructure: (message: string) => void;
}
export function WordParagraph({ paragraph, index, readOnly, selected, onSelect, onReplace, onRuns, onSplit, onPasteParagraphs, onSelection, trackText = false, reconcileToken = 0, onRemovePageBreaks, onRejectStructure }: WordParagraphProps) {
  const root = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const offset = pendingCaret.current ?? (document.activeElement === node ? caretOffset(node) : null);
    pendingCaret.current = null;
    node.replaceChildren(...paragraph.runs.map((run) => {
      const span = document.createElement("span");
      span.dataset.runId = run.id;
      if (run.hyperlinkId) { span.dataset.hyperlinkId = run.hyperlinkId; span.title = `Link: ${run.target ?? ""}. Use the Insert menu or command palette to open or update.`; }
      let textOffset = 0;
      for (const pageBreak of run.pageBreaks) {
        span.append(document.createTextNode(run.text.slice(textOffset, pageBreak.offset)));
        const marker = document.createElement("span"); marker.dataset.pageBreakId = pageBreak.id; marker.className = "docs-page-break-marker"; marker.contentEditable = "false"; marker.setAttribute("role", "separator"); marker.setAttribute("aria-label", "Page break"); span.append(marker); textOffset = pageBreak.offset;
      }
      span.append(document.createTextNode(run.text.slice(textOffset)));
      if (!run.canEdit && !(trackText && run.text)) span.contentEditable = "false";
      Object.assign(span.style, {
        fontWeight: run.style.bold ? "700" : "400", fontStyle: run.style.italic ? "italic" : "normal",
        textDecoration: run.style.underline === "none" ? "none" : run.style.underline || run.hyperlinkId ? "underline" : "none",
        color: run.style.color && /^[0-9a-f]{6}$/i.test(run.style.color) ? `#${run.style.color}` : run.hyperlinkId ? "#2563eb" : "",
        fontFamily: run.style.fontFamily ?? "", fontSize: run.style.fontSizePoints ? `${run.style.fontSizePoints}pt` : "",
      });
      span.dataset.expectedStyle = span.getAttribute("style") ?? "";
      return span;
    }));
    if (offset !== null) placeCaret(node, offset);
  }, [paragraph, trackText, reconcileToken]);
  const emit = () => {
    const node = root.current!;
    if (readOnly) { onRejectStructure("This document view is read-only."); return; }
    const expected = paragraph.runs.flatMap((run) => run.pageBreaks.map((pageBreak) => ({ id: pageBreak.id, runId: run.id, offset: pageBreak.offset, trailing: pageBreak.offset === run.text.length })));
    const markers = [...node.querySelectorAll<HTMLElement>("[data-page-break-id]")];
    const removed = expected.filter((pageBreak) => !markers.some((marker) => marker.dataset.pageBreakId === pageBreak.id));
    const misplaced = markers.some((marker) => {
      const source = expected.find((pageBreak) => pageBreak.id === marker.dataset.pageBreakId);
      const parentRun = marker.closest<HTMLElement>("[data-run-id]");
      if (!source || !parentRun || parentRun.dataset.runId !== source.runId) return true;
      const range = document.createRange(); range.selectNodeContents(parentRun); range.setEndBefore(marker);
      return range.toString().length !== (source.trailing ? parentRun.textContent?.length ?? 0 : source.offset);
    });
    if (removed.length || misplaced || markers.length !== expected.length) {
      if (removed.length && !misplaced && node.textContent === paragraph.text && markers.length + removed.length === expected.length) onRemovePageBreaks(removed.map((pageBreak) => pageBreak.id));
      else onRejectStructure("Move or remove page breaks with Insert tools before changing their surrounding structure.");
      return;
    }
    const spans = [...node.querySelectorAll<HTMLElement>(":scope > span[data-run-id]")];
    if (spans.some((span) => (span.getAttribute("style") ?? "") !== span.dataset.expectedStyle
      || [...span.querySelectorAll<HTMLElement>("*")].some((child) => !child.hasAttribute("data-page-break-id")))) {
      onRejectStructure("Use the formatting toolbar. Browser-inserted styling was not applied to the document."); return;
    }
    if (spans.length === paragraph.runs.length && spans.every((span, i) => span.dataset.runId === paragraph.runs[i].id)
      && spans.map((span) => span.textContent ?? "").join("") === node.textContent) {
      const edits = spans.flatMap((span, i) => span.textContent !== paragraph.runs[i].text ? [{ runId: paragraph.runs[i].id, text: span.textContent ?? "" }] : []);
      if (edits.length) onRuns(edits);
    } else if (node.textContent !== paragraph.text) onReplace(paragraph.id, node.textContent ?? "");
  };
  return <div ref={root} className={`docs-word-paragraph ${selected ? "is-selected" : ""}`} role="textbox" aria-label={`Paragraph ${index + 1}`} aria-readonly={readOnly} data-paragraph-id={paragraph.id}
    contentEditable={!readOnly} suppressContentEditableWarning spellCheck data-list-kind={paragraph.listKind} data-list-number={paragraph.listNumber}
    style={{ textAlign: paragraph.alignment === "both" ? "justify" : paragraph.alignment as "left" | "center" | "right" | undefined,
      marginTop: `${paragraph.spacingBeforePoints ?? 0}pt`, marginBottom: `${paragraph.spacingAfterPoints ?? 8}pt`, lineHeight: paragraph.lineSpacingMultiple ?? 1.4 }}
    onFocus={() => onSelect(paragraph.id, paragraph.runs[0]?.id)}
    onPointerUp={(event) => {
      const run = (event.target as HTMLElement).closest<HTMLElement>("[data-run-id]");
      onSelect(paragraph.id, run?.dataset.runId ?? paragraph.runs[0]?.id);
      const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end);
    }}
    onKeyUp={() => {
      const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end);
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor?.parentElement;
      const run = element?.closest<HTMLElement>("[data-run-id]");
      if (run) onSelect(paragraph.id, run.dataset.runId);
    }}
    onInput={() => { if (!composing.current) { const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end); emit(); } }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; emit(); }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); onRejectStructure("Use Import, Picture or plain-text Paste. Dropped HTML is not inserted into Word documents."); }}
    onPaste={(event) => {
      event.preventDefault(); if (readOnly) return;
      const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
      const { start, end } = selectionOffsets(root.current!);
      if (text.includes("\n")) { onPasteParagraphs(paragraph.id, start, end, text); return; }
      let offset = 0, inserted = false;
      const edits: DocxTextEdit[] = [];
      for (const run of paragraph.runs) {
        const runStart = offset, runEnd = offset + run.text.length; offset = runEnd;
        if (!run.canEdit && !(trackText && run.text)) continue;
        if (runEnd < start || runStart > end || (runEnd <= start && runEnd < paragraph.text.length)
          || (end > start && runStart >= end)) continue;
        const before = run.text.slice(0, Math.max(0, start - runStart));
        const after = run.text.slice(Math.min(run.text.length, Math.max(0, end - runStart)));
        const next = before + (!inserted ? text : "") + after;
        inserted = true;
        if (next !== run.text) edits.push({ runId: run.id, text: next });
      }
      pendingCaret.current = start + text.length;
      if (inserted) onRuns(edits);
      else onReplace(paragraph.id, paragraph.text.slice(0, start) + text + paragraph.text.slice(end));
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !readOnly) { event.preventDefault(); onSplit(paragraph.id, caretOffset(root.current!) ?? paragraph.text.length); }
    }} />;
}
