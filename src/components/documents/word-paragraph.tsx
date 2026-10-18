import { useLayoutEffect, useRef } from "react";
import type { DocxParagraph, DocxTextEdit } from "@/lib/office/docx";
import { paragraphInput } from "./word-input";

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
function placeSelection(root: HTMLElement, start: number, end: number, backward: boolean) {
  placeCaret(root, start);
  const selection = window.getSelection();
  if (!selection?.rangeCount || start === end) return;
  const range = selection.getRangeAt(0).cloneRange();
  placeCaret(root, end);
  const finish = selection.getRangeAt(0);
  range.setEnd(finish.startContainer, finish.startOffset);
  selection.removeAllRanges(); selection.addRange(range);
  if (backward && selection.extend) { selection.collapse(range.endContainer, range.endOffset); selection.extend(range.startContainer, range.startOffset); }
}
function selectionOffsets(root: HTMLElement): { start: number; end: number; supported: boolean } {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return { start: root.textContent?.length ?? 0, end: root.textContent?.length ?? 0, supported: true };
  const selected = selection.getRangeAt(0);
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return { start: 0, end: 0, supported: false };
  const before = document.createRange(); before.selectNodeContents(root); before.setEnd(selected.startContainer, selected.startOffset);
  const through = document.createRange(); through.selectNodeContents(root); through.setEnd(selected.endContainer, selected.endOffset);
  return { start: before.toString().length, end: through.toString().length, supported: true };
}
function selectionBookmark(root: HTMLElement) {
  const offsets = selectionOffsets(root), selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  return { ...offsets, backward: !!range && selection?.anchorNode === range.endContainer && selection?.anchorOffset === range.endOffset };
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
  onSelection?: (paragraphId: string, start: number, end: number, supported: boolean) => void;
  trackText?: boolean;
  reconcileToken?: number;
  onRemovePageBreaks: (ids: string[]) => void;
  onRejectStructure: (message: string) => void;
}
export function WordParagraph({ paragraph, index, readOnly, selected, onSelect, onRuns, onSplit, onPasteParagraphs, onSelection, trackText = false, reconcileToken = 0, onRemovePageBreaks, onRejectStructure }: WordParagraphProps) {
  const root = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const rejectedNativeInput = useRef(false);
  const nativeSelection = useRef<ReturnType<typeof selectionBookmark> | null>(null);
  const compositionSelection = useRef<ReturnType<typeof selectionBookmark> | null>(null);
  const rejectedSelection = useRef<ReturnType<typeof selectionBookmark> | null>(null);
  const selectionCallbacks = useRef({ onSelect, onSelection });
  selectionCallbacks.current = { onSelect, onSelection };
  const safeTracking = paragraph.runs.length === 1 && (paragraph.originalRuns?.length ?? 0) <= 1 && paragraph.runs.every((run) => !run.hyperlinkId && !run.pageBreaks.length);
  const inputParagraph = trackText && safeTracking ? { ...paragraph, revisionIds: [], runs: paragraph.runs.map((run) => ({ ...run, canEdit: true })) } : paragraph;
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const restore = rejectedSelection.current;
    rejectedSelection.current = null;
    const priorSelection = restore ?? selectionBookmark(node);
    const backward = priorSelection.backward;
    const offset = pendingCaret.current ?? (document.activeElement === node ? caretOffset(node) : null);
    const restoreRange = priorSelection.supported && (!!restore || pendingCaret.current === null && priorSelection.start !== priorSelection.end);
    pendingCaret.current = null;
    node.replaceChildren(...paragraph.runs.map((run) => {
      const style = run.resolvedStyle ?? run.style;
      const span = document.createElement(readOnly && run.target ? "a" : "span");
      span.dataset.runId = run.id;
      if (run.hyperlinkId) {
        span.dataset.hyperlinkId = run.hyperlinkId;
        span.title = readOnly ? `Open ${run.target ?? ""}` : `Link: ${run.target ?? ""}. Use the Insert menu or command palette to open or update.`;
        if (span instanceof HTMLAnchorElement && run.target) { span.href = run.target; span.target = "_blank"; span.rel = "noopener noreferrer"; }
      }
      let textOffset = 0;
      for (const pageBreak of run.pageBreaks) {
        span.append(document.createTextNode(run.text.slice(textOffset, pageBreak.offset)));
        const marker = document.createElement("span"); marker.dataset.pageBreakId = pageBreak.id; marker.className = "docs-page-break-marker"; marker.contentEditable = "false"; marker.setAttribute("role", "separator"); marker.setAttribute("aria-label", "Page break"); span.append(marker); textOffset = pageBreak.offset;
      }
      span.append(document.createTextNode(run.text.slice(textOffset)));
      if (!run.canEdit && !(trackText && run.text)) span.contentEditable = "false";
      Object.assign(span.style, {
        fontWeight: style.bold ? "700" : "400", fontStyle: style.italic ? "italic" : "normal",
        textDecoration: style.underline === "none" ? "none" : style.underline || run.hyperlinkId ? "underline" : "none",
        color: style.color && /^[0-9a-f]{6}$/i.test(style.color) ? `#${style.color}` : run.hyperlinkId ? "#2563eb" : "",
        fontFamily: style.fontFamily ?? "", fontSize: style.fontSizePoints ? `${style.fontSizePoints}pt` : "",
      });
      span.dataset.expectedStyle = span.getAttribute("style") ?? "";
      return span;
    }));
    if (restoreRange) {
      placeSelection(node, priorSelection.start, priorSelection.end, backward);
      if (restore) {
        let offset = 0;
        const run = paragraph.runs.find((item) => { offset += item.text.length; return offset > priorSelection.start; }) ?? paragraph.runs.at(-1);
        selectionCallbacks.current.onSelect(paragraph.id, run?.id);
        selectionCallbacks.current.onSelection?.(paragraph.id, priorSelection.start, priorSelection.end, true);
      }
    }
    else if (offset !== null) placeCaret(node, offset);
  }, [paragraph, trackText, reconcileToken, readOnly]);
  const emit = () => {
    const node = root.current!;
    const reject = (message: string) => {
      rejectedSelection.current = compositionSelection.current ?? nativeSelection.current;
      nativeSelection.current = null;
      onRejectStructure(message);
    };
    if (readOnly || node.closest("[inert]")) { reject("This document view is read-only."); return; }
    if (trackText && !safeTracking) { reject("Text tracking cannot safely replace mixed formatting or inline-owned content. Resolve changes or turn off tracking first."); return; }
    if (rejectedNativeInput.current) { rejectedNativeInput.current = false; reject("This browser input could not be applied safely."); return; }
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
      else reject("Move or remove page breaks with Insert tools before changing their surrounding structure.");
      return;
    }
    const spans = [...node.querySelectorAll<HTMLElement>(":scope > span[data-run-id]")];
    if (spans.some((span) => (span.getAttribute("style") ?? "") !== span.dataset.expectedStyle
      || [...span.querySelectorAll<HTMLElement>("*")].some((child) => !child.hasAttribute("data-page-break-id")))) {
      reject("Use the formatting toolbar. Browser-inserted styling was not applied to the document."); return;
    }
    if (spans.length === paragraph.runs.length && spans.every((span, i) => span.dataset.runId === paragraph.runs[i].id)
      && spans.map((span) => span.textContent ?? "").join("") === node.textContent) {
      const edits = spans.flatMap((span, i) => span.textContent !== paragraph.runs[i].text ? [{ runId: paragraph.runs[i].id, text: span.textContent ?? "" }] : []);
      if (edits.length) onRuns(edits);
      nativeSelection.current = null;
    } else reject("This browser input changed document structure and was not applied. Select editable text within one paragraph.");
  };
  const input = (start: number, end: number, text: string, deletion?: "backward" | "forward") => {
    const node = root.current!;
    if (readOnly || node.closest("[inert]")) return;
    if (trackText && !safeTracking) { onRejectStructure("Text tracking cannot safely replace mixed formatting or inline-owned content. Resolve changes or turn off tracking first."); return; }
    try {
      const next = paragraphInput(inputParagraph, start, end, text, deletion);
      if (!next.edits.length) { placeCaret(node, next.caret); onSelection?.(paragraph.id, next.caret, next.caret, true); return; }
      pendingCaret.current = next.caret;
      onSelection?.(paragraph.id, next.caret, next.caret, true);
      onRuns(next.edits);
    } catch (failure) { onRejectStructure(failure instanceof Error ? failure.message : "This input could not be applied safely."); }
  };
  useLayoutEffect(() => {
    const node = root.current!;
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing) return;
      nativeSelection.current = selectionBookmark(node);
      if (!event.cancelable) { rejectedNativeInput.current = true; return; }
      event.preventDefault();
      if (readOnly || node.closest("[inert]")) return;
      let offsets = selectionOffsets(node);
      const target = event.getTargetRanges?.()[0];
      if (target) {
        if (!node.contains(target.startContainer) || !node.contains(target.endContainer)) offsets = { start: 0, end: 0, supported: false };
        else {
          const before = document.createRange(); before.selectNodeContents(node); before.setEnd(target.startContainer, target.startOffset);
          const through = document.createRange(); through.selectNodeContents(node); through.setEnd(target.endContainer, target.endOffset);
          offsets = { start: before.toString().length, end: through.toString().length, supported: true };
        }
      }
      if (!offsets.supported || node.textContent !== paragraph.text) { onRejectStructure("Select editable text within one paragraph before changing it."); return; }
      if (["insertText", "insertReplacementText"].includes(event.inputType) && event.data !== null) input(offsets.start, offsets.end, event.data);
      else if (["deleteContentBackward", "deleteContentForward", "deleteByCut"].includes(event.inputType)) input(offsets.start, offsets.end, "", event.inputType === "deleteContentBackward" ? "backward" : event.inputType === "deleteContentForward" ? "forward" : undefined);
      else onRejectStructure("This input needs a source-safe document command and was not applied.");
    };
    node.addEventListener("beforeinput", beforeInput);
    return () => node.removeEventListener("beforeinput", beforeInput);
  });
  return <div ref={root} className={`docs-word-paragraph ${selected ? "is-selected" : ""}`} role="textbox" aria-label={`Paragraph ${index + 1}`} aria-readonly={readOnly} data-paragraph-id={paragraph.id}
    contentEditable={!readOnly} tabIndex={0} suppressContentEditableWarning spellCheck data-list-kind={paragraph.listKind} data-list-number={paragraph.listNumber}
    style={{ textAlign: paragraph.alignment === "both" ? "justify" : paragraph.alignment as "left" | "center" | "right" | undefined,
      marginTop: `${paragraph.spacingBeforePoints ?? 0}pt`, marginBottom: `${paragraph.spacingAfterPoints ?? 8}pt`, lineHeight: paragraph.lineSpacingMultiple ?? 1.4 }}
    onFocus={() => onSelect(paragraph.id, paragraph.runs[0]?.id)}
    onPointerUp={(event) => {
      const run = (event.target as HTMLElement).closest<HTMLElement>("[data-run-id]");
      onSelect(paragraph.id, run?.dataset.runId ?? paragraph.runs[0]?.id);
      const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end, offsets.supported);
    }}
    onKeyUp={() => {
      const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end, offsets.supported);
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor?.parentElement;
      const run = element?.closest<HTMLElement>("[data-run-id]");
      if (run) onSelect(paragraph.id, run.dataset.runId);
    }}
    onInput={() => { if (!composing.current) { const offsets = selectionOffsets(root.current!); onSelection?.(paragraph.id, offsets.start, offsets.end, offsets.supported); emit(); } }}
    onCompositionStart={(event) => { compositionSelection.current = selectionBookmark(event.currentTarget); composing.current = true; event.currentTarget.dataset.wordComposing = "true"; }}
    onCompositionEnd={(event) => { composing.current = false; delete event.currentTarget.dataset.wordComposing; emit(); compositionSelection.current = null; }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); onRejectStructure("Use Import, Picture or plain-text Paste. Dropped HTML is not inserted into Word documents."); }}
    onPaste={(event) => {
      event.preventDefault(); if (readOnly) return;
      const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
      if (!text) return;
      const { start, end, supported } = selectionOffsets(root.current!);
      if (!supported) { onRejectStructure("Select text within one paragraph before pasting."); return; }
      if (text.includes("\n")) { onPasteParagraphs(paragraph.id, start, end, text); return; }
      input(start, end, text);
    }}
    onCut={(event) => {
      event.preventDefault();
      const { start, end, supported } = selectionOffsets(root.current!);
      if (!supported) { onRejectStructure("Select text within one paragraph before cutting."); return; }
      if (readOnly || root.current?.closest("[inert]") || start === end) return;
      if (trackText && !safeTracking) { onRejectStructure("Text tracking cannot safely cut mixed formatting or inline-owned content."); return; }
      try { paragraphInput(inputParagraph, start, end, ""); } catch { onRejectStructure("This selection contains protected content and cannot be cut."); return; }
      event.clipboardData.setData("text/plain", paragraph.text.slice(start, end));
      input(start, end, "");
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter" && !readOnly && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        const offsets = selectionOffsets(root.current!);
        if (event.shiftKey || !offsets.supported || offsets.start !== offsets.end) { onRejectStructure("This paragraph break needs source-safe structural editing and was not applied."); return; }
        onSplit(paragraph.id, offsets.start);
      }
    }} />;
}
