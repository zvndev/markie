import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { DocxOperation, DocxRunFormat } from "@/lib/office/docx";
import type { RichDocument } from "@/lib/office/rich-text-types";
import { applyRichOperations, getRichCapabilities, replaceRichText, replaceRichRange } from "@/lib/office/rich-document";
import type { RichTextRange } from "@/lib/office/rich-range-types";
import { orderedWordRange, readWordSelection, restoreWordSelection, wordRangeText } from "./word-selection";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import type { FormattingAction } from "@/lib/format-controls";
import { DEFAULT_APPEARANCE } from "@/lib/doc-appearance";
import { readDocumentZoom, writeDocumentZoom, zoomForCommand } from "@/lib/document-zoom";
import { FormattingToolbar } from "@/components/formatting-toolbar";
import { CommandPalette } from "@/components/command-palette";
import { LinkPreviewCard } from "@/components/link-preview-card";
import { handleExternalLinkClick } from "@/lib/external-link";
import type { AppCommand } from "@/lib/commands";
import documentMenuCommands from "../../../electron/document-menu-commands.json";
import { WordParagraph } from "./word-paragraph";
import { useWordPageBackground } from "./word-colors";
import { WordToolsDialog, type WordTool } from "./word-toolbar";
import { WordImage } from "./word-images";
import type { WordTextMatch } from "./word-find";
import "./document-workspace.css";

interface WordDocumentEditorProps<T extends RichDocument> { document: T; readOnly?: boolean; isReadOnly?: () => boolean; onChange: (document: T) => void; onCommandsReady?: (target: DocumentCommandTarget | null) => void; onHistory?: () => void }
const WORD_ACTIONS: readonly FormattingAction[] = ["undo", "redo", "bold", "italic", "underline", "link", "image", "bullet", "ordered", "align-left", "align-center", "align-right", "clear"];
const LAYOUT_BUTTON = "h-7 min-w-7 px-1.5 rounded flex items-center justify-center shrink-0 transition-colors text-muted hover:text-foreground hover:bg-accent/40 aria-pressed:bg-accent aria-pressed:text-foreground disabled:opacity-35 disabled:hover:bg-transparent";
const WORD_FONTS = ["Arial", "Calibri", "Georgia", "Times New Roman", "Helvetica"];
const WORD_STYLES = [{ id: "", label: "Default paragraph" }, { id: "Normal", label: "Normal" }, { id: "Heading1", label: "Heading 1" }, { id: "Heading2", label: "Heading 2" }, { id: "Heading3", label: "Heading 3" }];
function commonValue<T>(values: readonly T[]): T | "mixed" | undefined {
  return values.length && values.some((value) => value !== values[0]) ? "mixed" : values[0];
}
export function WordDocumentEditor<T extends RichDocument>({ document, readOnly = false, isReadOnly, onChange, onCommandsReady, onHistory }: WordDocumentEditorProps<T>) {
  const capabilities = getRichCapabilities(document);
  const isDocx = document.format === "docx";
  const [selected, setSelected] = useState<string | undefined>(document.paragraphs[0]?.id);
  const [runId, setRunId] = useState<string | undefined>(document.paragraphs[0]?.runs[0]?.id);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(() => Math.round(readDocumentZoom() * 100));
  useEffect(() => writeDocumentZoom(zoom / 100), [zoom]);
  const [pageView, setPageView] = useState(() => document.format === "docx" && (typeof window === "undefined" || window.innerWidth > 650));
  const [outline, setOutline] = useState(false);
  const [tracking, setTracking] = useState(false), [reviewAuthor, setReviewAuthor] = useState("You"), [originalView, setOriginalView] = useState(false);
  const [reconcileToken, setReconcileToken] = useState(0);
  const [structureReconcileToken, setStructureReconcileToken] = useState(0);
  const [tool, setTool] = useState<WordTool | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteFocus = useRef<HTMLElement | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [selectionSupported, setSelectionSupported] = useState(true);
  const pageBackground = useWordPageBackground();
  type Snapshot = { document: T; selection: RichTextRange | null };
  const undoHistory = useRef<Snapshot[]>([]), redoHistory = useRef<Snapshot[]>([]);
  const logicalSelection = useRef<RichTextRange | null>(null), pendingSelection = useRef<RichTextRange | null>(null);
  const rejectedDocumentInput = useRef<RichTextRange | null>(null);
  const crossComposing = useRef(false);
  const latestDocument = useRef(document);
  const host = useRef<HTMLDivElement>(null);
  const [linkContainer, setLinkContainer] = useState<HTMLDivElement | null>(null);
  const bindHost = useCallback((node: HTMLDivElement | null) => { host.current = node; setLinkContainer(node); }, []);
  const textSelection = useRef<WordTextMatch | null>(null);
  const access = useRef({ readOnly, isReadOnly, canEdit: document.canEdit, originalView }); access.current = { readOnly, isReadOnly, canEdit: document.canEdit, originalView };
  const canView = () => !!host.current && !host.current.closest("[inert]");
  const canMutate = () => canView() && !access.current.readOnly && !access.current.isReadOnly?.() && access.current.canEdit && !access.current.originalView && !crossComposing.current && !host.current?.querySelector('[data-word-composing="true"]');
  const openPalette = () => { if (onCommandsReady || tool || !canView()) return; paletteFocus.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null; setPaletteOpen(true); };
  const closePalette = () => { setPaletteOpen(false); requestAnimationFrame(() => { const prior = paletteFocus.current; if (prior?.isConnected && !prior.closest("[inert]")) prior.focus(); }); };
  latestDocument.current = document;
  const currentSelection = () => tool || paletteOpen ? logicalSelection.current : host.current && readWordSelection(host.current) || logicalSelection.current;
  const syncSelection = (range: RichTextRange) => {
    logicalSelection.current = range;
    const same = range.anchor.paragraphId === range.focus.paragraphId;
    textSelection.current = same ? { paragraphId: range.anchor.paragraphId, start: Math.min(range.anchor.offset, range.focus.offset), end: Math.max(range.anchor.offset, range.focus.offset) } : null;
    setSelectionSupported(same || isDocx);
    setSelected(range.focus.paragraphId);
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === range.focus.paragraphId);
    let offset = 0;
    const run = paragraph?.runs.find((item) => { offset += item.text.length; return offset > range.focus.offset; }) ?? paragraph?.runs.at(-1);
    setRunId(run?.id);
    setSelectionRevision((value) => value + 1);
  };
  const rememberSelection = () => {
    const range = host.current && readWordSelection(host.current);
    if (!range) return;
    syncSelection(range);
  };
  // Each paragraph is its own editing host, and browsers will not extend a
  // native drag selection across editing hosts. Once a drag crosses into a
  // neighbouring paragraph, extend the selection from the caret point so
  // mouse selection behaves like one continuous document.
  const dragAnchor = useRef<{ node: Node; offset: number; paragraphId: string; crossed: boolean } | null>(null);
  const caretPoint = (x: number, y: number): { node: Node; offset: number } | null => {
    const doc = globalThis.document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
    const position = doc.caretPositionFromPoint?.(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  };
  const paragraphOf = (node: Node): HTMLElement | null => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
    const paragraph = element?.closest<HTMLElement>("[data-paragraph-id]") ?? null;
    return paragraph && host.current?.contains(paragraph) ? paragraph : null;
  };
  // Between lines or past the last glyph the caret API reports the page
  // container instead of a text node. Resolve the paragraph under the point
  // and retry at its line centre, falling back to its nearest text edge.
  const dragFocusAt = (x: number, y: number, anchorParagraphId: string): { node: Node; offset: number; paragraph: HTMLElement } | null => {
    const point = caretPoint(x, y);
    const paragraph = point && paragraphOf(point.node);
    if (point && paragraph) return { node: point.node, offset: point.offset, paragraph };
    // Paragraphs are not always the hit target (the page surface is), so
    // resolve by geometry: the paragraph containing the point, else the
    // nearest one vertically.
    let hit: HTMLElement | null = null, nearest = Number.POSITIVE_INFINITY;
    for (const candidate of host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? []) {
      const rect = candidate.getBoundingClientRect();
      const distance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      if (distance < nearest) { nearest = distance; hit = candidate; }
    }
    if (!hit) return null;
    const rect = hit.getBoundingClientRect();
    const retry = caretPoint(x, rect.top + rect.height / 2);
    if (retry && paragraphOf(retry.node) === hit) return { node: retry.node, offset: retry.offset, paragraph: hit };
    const walker = globalThis.document.createTreeWalker(hit, NodeFilter.SHOW_TEXT);
    let first: Node | null = null, last: Node | null = null, node = walker.nextNode();
    while (node) { first ??= node; last = node; node = walker.nextNode(); }
    if (!first || !last) return null;
    const paragraphs = latestDocument.current.paragraphs;
    const forward = paragraphs.findIndex((item) => item.id === hit.dataset.paragraphId) >= paragraphs.findIndex((item) => item.id === anchorParagraphId);
    return forward ? { node: last, offset: last.textContent?.length ?? 0, paragraph: hit } : { node: first, offset: 0, paragraph: hit };
  };
  const beginDragSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof HTMLElement) || !event.target.closest("[data-paragraph-id]")) return;
    const point = caretPoint(event.clientX, event.clientY);
    const paragraph = point && paragraphOf(point.node);
    if (!point || !paragraph?.dataset.paragraphId) return;
    const anchor = { node: point.node, offset: point.offset, paragraphId: paragraph.dataset.paragraphId, crossed: false };
    dragAnchor.current = anchor;
    const move = (moveEvent: PointerEvent) => {
      if (!moveEvent.buttons || dragAnchor.current !== anchor) return;
      const focus = dragFocusAt(moveEvent.clientX, moveEvent.clientY, anchor.paragraphId);
      if (!focus) return;
      if (focus.paragraph.dataset.paragraphId !== anchor.paragraphId) anchor.crossed = true;
      if (!anchor.crossed) return;
      window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    };
    const up = () => {
      if (dragAnchor.current === anchor) dragAnchor.current = null;
      window.removeEventListener("pointermove", move);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };
  useLayoutEffect(() => {
    const range = pendingSelection.current;
    if (!range || !host.current || tool || paletteOpen) return;
    pendingSelection.current = null;
    restoreWordSelection(host.current, range);
    syncSelection(range);
  });
  const rejectChange = (failure: unknown) => {
    const range = currentSelection();
    if (range && range.anchor.paragraphId !== range.focus.paragraphId) pendingSelection.current = range;
    setError(`${typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "That change could not be applied."} The change was not applied.`);
    setReconcileToken((value) => value + 1);
  };
  const perform = (next: RichDocument, after?: RichTextRange) => {
    if (!canMutate() || next.format !== latestDocument.current.format || next === latestDocument.current) return;
    undoHistory.current.push({ document: latestDocument.current, selection: currentSelection() }); redoHistory.current = [];
    if (undoHistory.current.length > 100) undoHistory.current.shift();
    // Operations and Find retain the format; the dialog accepts the shared view.
    const sameFormat = next as T;
    if (after) { logicalSelection.current = after; pendingSelection.current = after; }
    latestDocument.current = sameFormat; onChange(sameFormat); setError(null);
  };
  const apply = (operations: readonly DocxOperation[]) => {
    if (!canMutate()) return;
    try { perform(applyRichOperations(latestDocument.current, operations)); }
    catch (failure) { rejectChange(failure); }
  };
  const blocked = readOnly || !document.canEdit;
  const selectMatch = (match: WordTextMatch) => {
    logicalSelection.current = { anchor: { paragraphId: match.paragraphId, offset: match.start }, focus: { paragraphId: match.paragraphId, offset: match.end } };
    setSelectionSupported(true);
    textSelection.current = match;
    setSelected(match.paragraphId);
    setSelectionRevision((value) => value + 1);
    const node = [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((item) => item.dataset.paragraphId === match.paragraphId);
    if (!node) return;
    node.focus(); node.scrollIntoView?.({ block: "nearest" });
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === match.paragraphId);
    let runOffset = 0;
    const selectedRun = paragraph?.runs.find((run) => { runOffset += run.text.length; return runOffset > match.start; });
    if (selectedRun) setRunId(selectedRun.id);
    const walker = globalThis.document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode(), offset = 0, start: { node: Node; offset: number } | undefined;
    while (text) {
      const length = text.textContent?.length ?? 0;
      if (!start && offset + length >= match.start) start = { node: text, offset: match.start - offset };
      if (start && offset + length >= match.end) {
        const range = globalThis.document.createRange(); range.setStart(start.node, start.offset); range.setEnd(text, match.end - offset);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); return;
      }
      offset += length; text = walker.nextNode();
    }
  };
  const formatRun = (style: DocxRunFormat, activeRun: string) => {
    if (!canMutate() || !selectionSupported) return;
    const range = logicalSelection.current;
    if (range && range.anchor.paragraphId !== range.focus.paragraphId) {
      try {
        const current = latestDocument.current, [start, end] = orderedWordRange(current, range);
        const first = current.paragraphs.findIndex((item) => item.id === start.paragraphId), last = current.paragraphs.findIndex((item) => item.id === end.paragraphId);
        const ids = current.blocks.filter((block) => block.kind === "paragraph").map((block) => block.paragraphId);
        if (first < 0 || last < first || current.paragraphs.slice(first, last + 1).some((item) => !ids.includes(item.id))) throw new Error("Cross-table formatting is not supported.");
        const operations: DocxOperation[] = current.paragraphs.slice(first, last + 1).flatMap((item, index, items) => {
          const from = index === 0 ? start.offset : 0, to = index === items.length - 1 ? end.offset : item.text.length;
          return from === to ? [] : [{ type: "format-range" as const, paragraphId: item.id, start: from, end: to, style }];
        });
        perform(applyRichOperations(current, operations), range);
      } catch (failure) { rejectChange(failure); }
      return;
    }
    const selection = textSelection.current;
    if (!selection || selection.paragraphId !== selected || selection.start === selection.end) { apply([{ type: "format-run", runId: activeRun, style }]); return; }
    try {
      perform(applyRichOperations(latestDocument.current, [{ type: "format-range", ...selection, style }]));
      requestAnimationFrame(() => selectMatch(selection));
    } catch (failure) { rejectChange(failure); }
  };
  const addLink = (target: string) => {
    if (!canMutate() || !getRichCapabilities(latestDocument.current).hyperlinks) return;
    const selection = textSelection.current;
    if (!selection || selection.start === selection.end) { rejectChange("Select text within a paragraph before adding a link."); return; }
    apply([{ type: "set-hyperlink", ...selection, target }]);
    requestAnimationFrame(() => selectMatch(selection));
  };
  const insertBreak = () => {
    if (!canMutate() || !getRichCapabilities(latestDocument.current).pageBreaks) return;
    const selection = textSelection.current;
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === (selection?.paragraphId ?? selected));
    if (!paragraph) { rejectChange("Place the cursor in a paragraph before inserting a page break."); return; }
    if (selection && selection.start !== selection.end) { rejectChange("Use a cursor position, not a text selection, to insert a page break."); return; }
    const offset = selection?.end ?? paragraph.text.length;
    const operations: DocxOperation[] = [{ type: "insert-page-break", paragraphId: paragraph.id, offset }];
    if (offset === paragraph.text.length) operations.push({ type: "insert-paragraph", afterParagraphId: paragraph.id, text: "" });
    try {
      const priorParagraphs = new Set(latestDocument.current.paragraphs.map((item) => item.id));
      const next = applyRichOperations(latestDocument.current, operations); perform(next); textSelection.current = null;
      const inserted = next.paragraphs.find((item) => !priorParagraphs.has(item.id));
      if (inserted) {
        setSelected(inserted.id); setRunId(inserted.runs[0]?.id);
        requestAnimationFrame(() => [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === inserted.id)?.focus());
      }
    } catch (failure) { rejectChange(failure); }
  };
  const restoreSnapshot = (snapshot: Snapshot, history: Snapshot[]) => {
    history.push({ document: latestDocument.current, selection: currentSelection() });
    textSelection.current = null; logicalSelection.current = snapshot.selection; pendingSelection.current = snapshot.selection;
    latestDocument.current = snapshot.document; onChange(snapshot.document); setError(null);
    if (snapshot.selection) { setSelected(snapshot.selection.focus.paragraphId); setRunId(snapshot.document.paragraphs.find((item) => item.id === snapshot.selection!.focus.paragraphId)?.runs[0]?.id); }
  };
  const undo = () => { if (!canMutate()) return; const previous = undoHistory.current.pop(); if (previous) restoreSnapshot(previous, redoHistory.current); };
  const redo = () => { if (!canMutate()) return; const next = redoHistory.current.pop(); if (next) restoreSnapshot(next, undoHistory.current); };
  const replaceSelection = (range: RichTextRange, text: string, beforeCommit?: () => void) => {
    if (!canMutate() || tool || paletteOpen || host.current?.querySelector('[data-word-composing="true"]')) return;
    if (tracking) { rejectChange("Turn off paragraph text tracking before structural or cross-paragraph editing."); return; }
    try {
      const [start, end] = orderedWordRange(latestDocument.current, range);
      const paragraphs = latestDocument.current.paragraphs, first = paragraphs.findIndex((item) => item.id === start.paragraphId), last = paragraphs.findIndex((item) => item.id === end.paragraphId);
      const nodes = [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])];
      if (first < 0 || last < first || paragraphs.slice(first, last + 1).some((paragraph) => nodes.find((node) => node.dataset.paragraphId === paragraph.id)?.textContent !== paragraph.text)) throw new Error("The browser selection no longer matches the document source.");
      const result = replaceRichRange(latestDocument.current, range, text);
      if (result.document === latestDocument.current) {
        pendingSelection.current = result.selection;
        syncSelection(result.selection);
        setError(null);
        return;
      }
      beforeCommit?.();
      perform(result.document, result.selection);
      textSelection.current = null; setSelectionSupported(true);
      setSelected(result.selection.focus.paragraphId);
      setRunId(result.document.paragraphs.find((item) => item.id === result.selection.focus.paragraphId)?.runs[0]?.id);
    } catch (failure) { rejectChange(failure); }
  };
  const pasteParagraphs = (paragraphId: string, start: number, end: number, text: string) => {
    if (!canMutate()) return;
    if (latestDocument.current.format === "docx") { replaceSelection({ anchor: { paragraphId, offset: start }, focus: { paragraphId, offset: end } }, text); return; }
    if (tracking) { rejectChange("Turn off paragraph text tracking before inserting new paragraphs."); return; }
    try {
      const current = latestDocument.current;
      const paragraph = current.paragraphs.find((item) => item.id === paragraphId)!;
      if (paragraph.runs.length !== 1 || paragraph.runs.some((run) => !run.canEdit || run.hyperlinkId || run.pageBreaks.length || JSON.stringify(run.resolvedStyle ?? run.style) !== JSON.stringify(run.style))
        || paragraph.revisionIds.length || paragraph.styleId || paragraph.listKind || paragraph.alignment && paragraph.alignment !== "left" || paragraph.spacingBeforePoints || paragraph.spacingAfterPoints || paragraph.lineSpacingMultiple && paragraph.lineSpacingMultiple !== 1
        || current.images.some((image) => image.paragraphId === paragraphId) || current.comments.some((comment) => comment.paragraphId === paragraphId)) {
        rejectChange("Rich paragraph breaks and multiline paste need source-safe structural editing. The existing formatting and content were preserved."); return;
      }
      const lines = text.split("\n");
      let next = applyRichOperations(current, [{ type: "replace-paragraph", paragraphId, text: paragraph.text.slice(0, start) + lines[0] }]);
      let after = paragraphId;
      for (let index = 1; index < lines.length; index++) {
        const beforeIds = new Set(next.paragraphs.map((item) => item.id));
        next = applyRichOperations(next, [{ type: "insert-paragraph", afterParagraphId: after, text: lines[index] + (index === lines.length - 1 ? paragraph.text.slice(end) : "") }]);
        const inserted = next.paragraphs.find((item) => !beforeIds.has(item.id))!;
        after = inserted.id;
        const style = paragraph.runs[0]?.style;
        if (style && inserted.runs[0]) next = applyRichOperations(next, [{ type: "format-run", runId: inserted.runs[0].id, style }]);
      }
      perform(next); setSelected(after); setRunId(next.paragraphs.find((item) => item.id === after)?.runs[0]?.id);
      requestAnimationFrame(() => [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === after)?.focus());
    } catch (failure) { rejectChange(failure); }
  };
  const structuralRange = (range: RichTextRange, deletion?: "backward" | "forward"): RichTextRange | null => {
    if (range.anchor.paragraphId !== range.focus.paragraphId) return range;
    if (range.anchor.offset !== range.focus.offset) return null;
    if (!deletion) return range;
    const paragraphs = latestDocument.current.paragraphs, index = paragraphs.findIndex((item) => item.id === range.anchor.paragraphId), paragraph = paragraphs[index];
    if (deletion === "backward" && range.anchor.offset === 0 && index > 0) return { anchor: { paragraphId: paragraphs[index - 1].id, offset: paragraphs[index - 1].text.length }, focus: range.focus };
    if (deletion === "forward" && range.anchor.offset === paragraph?.text.length && index < paragraphs.length - 1) return { anchor: range.anchor, focus: { paragraphId: paragraphs[index + 1].id, offset: 0 } };
    return null;
  };
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const beforeInput = (event: InputEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-paragraph-id]") || event.isComposing || node.querySelector('[data-word-composing="true"]')) return;
      const range = readWordSelection(node);
      if (!range) return;
      const cross = range.anchor.paragraphId !== range.focus.paragraphId;
      const deletion = event.inputType === "deleteContentBackward" ? "backward" : event.inputType === "deleteContentForward" ? "forward" : undefined;
      const boundary = deletion && latestDocument.current.format === "docx" ? structuralRange(range, deletion) : null;
      const paragraphBreak = event.inputType === "insertParagraph" && latestDocument.current.format === "docx";
      const emptyInput = latestDocument.current.format === "docx" && latestDocument.current.paragraphs.find((paragraph) => paragraph.id === range.anchor.paragraphId)?.runs.length === 0 && ["insertText", "insertReplacementText"].includes(event.inputType);
      if (!cross && !boundary && !paragraphBreak && !emptyInput) return;
      event.stopImmediatePropagation();
      if (!event.cancelable) { rejectedDocumentInput.current = range; pendingSelection.current = range; rejectChange("This noncancelable cross-paragraph input was not applied."); return; }
      event.preventDefault();
      logicalSelection.current = range;
      if (paragraphBreak) replaceSelection(range, "\n");
      else if (["insertText", "insertReplacementText"].includes(event.inputType) && event.data !== null) replaceSelection(range, event.data);
      else if (["deleteContentBackward", "deleteContentForward", "deleteByCut"].includes(event.inputType)) replaceSelection(boundary ?? range, "");
      else rejectChange("This cross-paragraph input requires a supported source-safe command.");
    };
    node.addEventListener("beforeinput", beforeInput, true);
    return () => node.removeEventListener("beforeinput", beforeInput, true);
  });
  const handleStructureKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-paragraph-id]") || event.nativeEvent.isComposing || event.keyCode === 229 || host.current?.querySelector('[data-word-composing="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a" && canView() && !tool && !paletteOpen) {
      const paragraphs = latestDocument.current.paragraphs, first = paragraphs[0], last = paragraphs.at(-1);
      if (!first || !last || !host.current) return;
      event.preventDefault(); event.stopPropagation();
      const range = { anchor: { paragraphId: first.id, offset: 0 }, focus: { paragraphId: last.id, offset: last.text.length } };
      restoreWordSelection(host.current, range); rememberSelection();
      if (first.id === last.id) textSelection.current = { paragraphId: first.id, start: 0, end: last.text.length };
      return;
    }
    const range = host.current && readWordSelection(host.current);
    if (!range) return;
    const cross = range.anchor.paragraphId !== range.focus.paragraphId;
    const deletion = event.key === "Backspace" ? "backward" : event.key === "Delete" ? "forward" : undefined;
    const boundary = deletion && isDocx && !event.metaKey && !event.ctrlKey && !event.altKey ? structuralRange(range, deletion) : null;
    if (event.key !== "Enter" && !boundary && !(cross && deletion)) return;
    if (!isDocx && !cross) return;
    event.preventDefault(); event.stopPropagation(); logicalSelection.current = range;
    if (event.key === "Enter" && event.shiftKey) { rejectChange("Soft line breaks need source-safe inline editing and were not applied."); return; }
    replaceSelection(boundary ?? range, event.key === "Enter" ? "\n" : "");
  };
  const paragraphNode = (id: string) => {
    const paragraph = document.paragraphs.find((item) => item.id === id);
    if (!paragraph) return null;
    const images = document.images.filter((image) => image.paragraphId === id);
    const shown = originalView && paragraph.originalRuns ? { ...paragraph, text: paragraph.originalText ?? paragraph.text, runs: paragraph.originalRuns } : paragraph;
    const field = <WordParagraph key={id} paragraph={shown} index={document.paragraphs.indexOf(paragraph)} selected={selected === id} readOnly={blocked || originalView || !!tool || paletteOpen || (!tracking && paragraph.revisionIds.length > 0)} trackText={tracking} reconcileToken={reconcileToken} pageBackground={pageBackground}
      onSelect={(paragraphId, selectedRun) => { if (paragraphId !== selected) { textSelection.current = null; setSelectionSupported(true); } setSelected(paragraphId); setRunId(selectedRun); }}
      onReplace={(paragraphId, text) => apply([tracking ? { type: "track-paragraph-text", paragraphId, text, author: reviewAuthor.trim() } : { type: "replace-paragraph", paragraphId, text }])}
      onRuns={(edits) => {
        if (!edits.length) return;
        if (tracking) {
          if (paragraph.runs.length !== 1 || (paragraph.originalRuns?.length ?? 0) > 1 || paragraph.runs.some((run) => run.hyperlinkId || run.pageBreaks.length) || document.images.some((image) => image.paragraphId === id)) {
            rejectChange("Text tracking cannot safely replace mixed formatting or inline-owned content."); return;
          }
          const replacements = new Map(edits.map((edit) => [edit.runId, edit.text]));
          apply([{ type: "track-paragraph-text", paragraphId: id, text: paragraph.runs.map((run) => replacements.get(run.id) ?? run.text).join(""), author: reviewAuthor.trim() }]);
        } else try { perform(replaceRichText(latestDocument.current, edits)); } catch (failure) { rejectChange(failure); }
      }}
      onSplit={(paragraphId, offset) => pasteParagraphs(paragraphId, offset, offset, "\n")}
      onPasteParagraphs={pasteParagraphs} onSelection={(paragraphId, start, end, supported) => {
        const dom = host.current && readWordSelection(host.current);
        if (!supported && dom && dom.anchor.paragraphId !== dom.focus.paragraphId) { rememberSelection(); return; }
        textSelection.current = { paragraphId, start, end };
        if (supported) logicalSelection.current = { anchor: { paragraphId, offset: start }, focus: { paragraphId, offset: end } };
        setSelectionSupported(supported); setSelectionRevision((value) => value + 1);
      }}
      onRemovePageBreaks={(ids) => apply(ids.map((pageBreakId) => ({ type: "remove-page-break", pageBreakId })))} onRejectStructure={rejectChange} />;
    // Selection offsets are kept separately from DOM focus so toolbar clicks
    // format the selected substring rather than its entire underlying run.
    return images.length && document.format === "docx" ? <div key={id}>{images.map((image) => <WordImage key={image.id} document={document} image={image} selected={selected === id} onSelect={() => { setSelected(id); setRunId(undefined); }} />)}{paragraph.text || paragraph.runs.some((run) => run.pageBreaks.length) ? field : null}</div> : field;
  };
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "k" && !onCommandsReady) { event.preventDefault(); event.stopPropagation(); openPalette(); return; }
    if (key === "f") { event.preventDefault(); if (canView() && (!tool || tool === "find")) { setOriginalView(false); setTool("find"); host.current?.querySelector<HTMLInputElement>('[aria-label="Find Word text"]')?.focus(); } return; }
    if (tool || paletteOpen) return;
    if ((event.target as HTMLElement).closest("input,textarea,select")) return;
    if (key === "z") { event.preventDefault(); if (!blocked && !originalView) { if (event.shiftKey) redo(); else undo(); } return; }
    if (!["b", "i", "u"].includes(key)) return;
    event.preventDefault(); if (blocked || originalView) return;
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === selected);
    const run = paragraph?.runs.find((item) => item.id === runId && item.canEdit);
    if (!run) return;
    formatRun(key === "b" ? { bold: selectionFormat.bold !== true } : key === "i" ? { italic: selectionFormat.italic !== true } : { underline: selectionFormat.underline === true ? "none" : "single" }, run.id);
  };
  const paragraph = document.paragraphs.find((item) => item.id === selected), run = paragraph?.runs.find((item) => item.id === runId);
  const selection = textSelection.current;
  let offset = 0;
  const logical = logicalSelection.current;
  const crossSelection = !!logical && logical.anchor.paragraphId !== logical.focus.paragraphId;
  const selectedRuns = crossSelection ? (() => {
    const [start, end] = orderedWordRange(document, logical!);
    const first = document.paragraphs.findIndex((item) => item.id === start.paragraphId), last = document.paragraphs.findIndex((item) => item.id === end.paragraphId);
    return document.paragraphs.slice(first, last + 1).flatMap((item, index, items) => {
      let offset = 0;
      return item.runs.filter((run) => { const from = offset; offset += run.text.length; return offset > (index === 0 ? start.offset : 0) && from < (index === items.length - 1 ? end.offset : item.text.length); });
    });
  })() : selection && selection.paragraphId === selected && selection.start !== selection.end ? paragraph?.runs.filter((item) => {
    const start = offset; offset += item.text.length; return start < selection.end && offset > selection.start;
  }) ?? [] : run ? [run] : [];
  const effectiveStyles = selectedRuns.map((item) => item.resolvedStyle ?? item.style);
  const selectionFormat = {
    bold: commonValue(effectiveStyles.map((style) => !!style.bold)), italic: commonValue(effectiveStyles.map((style) => !!style.italic)),
    underline: commonValue(effectiveStyles.map((style) => !!style.underline && style.underline !== "none")),
    fontFamily: commonValue(effectiveStyles.map((style) => style.fontFamily)), fontSizePoints: commonValue(effectiveStyles.map((style) => style.fontSizePoints)),
    color: commonValue(effectiveStyles.map((style) => style.color?.toLowerCase())),
  };
  const fonts = useMemo(() => [...new Set([...WORD_FONTS, ...document.paragraphs.flatMap((item) => item.runs.map((item) => (item.resolvedStyle ?? item.style).fontFamily).filter((font): font is string => !!font))])].map((font) => ({ id: font, label: font })), [document.paragraphs]);
  const styleId = paragraph?.styleId;
  const styles = useMemo(() => [...new Map([...WORD_STYLES, ...document.styles.map((style) => ({ id: style.id, label: style.name || style.id })), ...(styleId ? [{ id: styleId, label: document.styles.find((style) => style.id === styleId)?.name || styleId }] : [])].map((style) => [style.id, style])).values()], [document.styles, styleId]);
  const editable = !blocked && !originalView, editableSelection = editable && selectionSupported && !!selectedRuns.length && selectedRuns.every((item) => item.canEdit);
  const canFormat = editableSelection && !tool && !paletteOpen, canUndo = editable && undoHistory.current.length > 0, canRedo = editable && redoHistory.current.length > 0;
  const setParagraphStyle = (styleId: string | null) => {
    if (!capabilities.namedStyles || !paragraph || !canMutate() || !selectionSupported || crossSelection || tool || paletteOpen || paragraph.revisionIds.length) return;
    apply([{ type: "format-paragraph", paragraphId: paragraph.id, format: { styleId } }]);
  };
  const selectedTable = document.tables.some((table) => table.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((item) => item.id === selected))));
  const hasLinkSelection = !!paragraph && (!!document.hyperlinks.find((link) => link.paragraphId === selected && !!runId && link.runIds.includes(runId)) || !!textSelection.current && textSelection.current.start !== textSelection.current.end);
  const availableCommands = tool ? [] : ["find", "zoom-in", "zoom-out", "view-zoom-reset", "view-page", "view-continuous", ...(isDocx ? ["view-outline", "review-comments", "review-tracking", "review-changes", "review-final", ...(document.originalText === undefined ? [] : ["review-original"])] : []), ...(onHistory ? ["document-history"] : []),
    ...(canUndo ? ["undo"] : []), ...(canRedo ? ["redo"] : []),
    ...(editable && capabilities.pageLayout ? ["layout-page-setup", "layout-letter", "layout-a4", "layout-legal", "layout-portrait", "layout-landscape"] : []),
    ...(editable && paragraph && selectionSupported && !crossSelection && !paragraph.revisionIds.length ? [
      ...(capabilities.namedStyles ? ["format-normal", "format-heading-1", "format-heading-2", "format-heading-3"] : []),
      ...(capabilities.lists ? ["format-bullets", "format-numbering"] : []),
      ...(capabilities.paragraphFormatting ? ["format-align-left", "format-align-center", "format-align-right", "format-align-justify", "layout-paragraph-spacing"] : []),
      "insert-paragraph", ...(capabilities.tables ? ["insert-table"] : []),
      ...(capabilities.images && !selectedTable ? ["insert-picture"] : []),
      ...(capabilities.pageBreaks && !tracking && (!textSelection.current || textSelection.current.start === textSelection.current.end) ? ["insert-page-break"] : []),
      ...(capabilities.hyperlinks && !tracking && hasLinkSelection ? ["insert-link"] : [])] : []),
    ...(capabilities.runFormatting && editableSelection && run ? ["format-bold", "format-italic", "format-underline", "format-clear", "format-font"] : [])];
  const enabledCommands = paletteOpen ? [] : availableCommands;
  const command = (id: string) => {
    if (!canView() || !enabledCommands.includes(id)) return;
    if (id === "undo") { undo(); return; } if (id === "redo") { redo(); return; }
    if (id === "find") { setOriginalView(false); setTool("find"); return; }
    if (id === "document-history") { onHistory?.(); return; }
    if (id === "zoom-in" || id === "zoom-out" || id === "view-zoom-reset") { setZoom((current) => Math.round((zoomForCommand(current / 100, id) ?? current / 100) * 100)); return; }
    if (id === "view-page" || id === "view-continuous") { setPageView(id === "view-page"); return; }
    if (id === "view-outline") { setOutline(!outline); return; }
    if (id === "review-original" || id === "review-final") { textSelection.current = null; setOriginalView(id === "review-original"); return; }
    const dialog: Record<string, WordTool> = { "format-font": "font", "insert-picture": "picture", "insert-table": "table", "insert-link": "link", "layout-page-setup": "page", "layout-paragraph-spacing": "spacing", "review-comments": "review", "review-tracking": "review", "review-changes": "review" };
    if (dialog[id]) { setTool(dialog[id]); return; }
    if (!canMutate()) return;
    if (run && id === "format-bold") formatRun({ bold: selectionFormat.bold !== true }, run.id);
    else if (run && id === "format-italic") formatRun({ italic: selectionFormat.italic !== true }, run.id);
    else if (run && id === "format-underline") formatRun({ underline: selectionFormat.underline === true ? "none" : "single" }, run.id);
    else if (run && id === "format-clear") formatRun({ bold: null, italic: null, underline: null, color: null, fontFamily: null, fontSizePoints: null }, run.id);
    else if (id === "format-normal" || id.startsWith("format-heading-")) setParagraphStyle(id === "format-normal" ? "Normal" : `Heading${id.at(-1)}`);
    else if (paragraph && (id === "format-bullets" || id === "format-numbering")) { const kind = id === "format-bullets" ? "bullet" : "numbered"; apply([{ type: "set-list", paragraphId: paragraph.id, kind: paragraph.listKind === kind ? null : kind }]); }
    else if (paragraph && id.startsWith("format-align-")) apply([{ type: "format-paragraph", paragraphId: paragraph.id, format: { alignment: id === "format-align-justify" ? "both" : id.slice(13) as "left" | "center" | "right" } }]);
    else if (id === "insert-paragraph") apply([{ type: "insert-paragraph", afterParagraphId: paragraph?.id, text: "" }]);
    else if (id === "insert-page-break") insertBreak();
    else if (["layout-letter", "layout-a4", "layout-legal"].includes(id)) apply([{ type: "set-page-layout", layout: { paper: id.slice(7) as "letter" | "a4" | "legal" } }]);
    else if (id === "layout-portrait" || id === "layout-landscape") apply([{ type: "set-page-layout", layout: { orientation: id.slice(7) as "portrait" | "landscape" } }]);
  };
  const commandRef = useRef(command); commandRef.current = command;
  const execute = useCallback((id: string) => commandRef.current(id), []);
  const enabledKey = enabledCommands.join("|");
  useEffect(() => { onCommandsReady?.({ enabledCommands: enabledKey ? enabledKey.split("|") : [], execute, modalOpen: !!tool || paletteOpen }); return () => onCommandsReady?.(null); }, [onCommandsReady, enabledKey, execute, selectionRevision, tool, paletteOpen]);
  const paletteCommands: AppCommand[] = [
    ...documentMenuCommands.filter((item) => availableCommands.includes(item.id)).map((item): AppCommand => ({ id: item.id, title: `${item.group}: ${item.label}`, group: item.group === "View" ? "View" : item.group === "File" ? "File" : "Format", run: () => requestAnimationFrame(() => execute(item.id)) })),
    ...[{ id: "find", title: "Find and Replace…", group: "View" as const }, { id: "undo", title: "Undo", group: "File" as const }, { id: "redo", title: "Redo", group: "File" as const }].filter((item) => availableCommands.includes(item.id)).map((item): AppCommand => ({ ...item, run: () => requestAnimationFrame(() => execute(item.id)) })),
  ];
  const action = (value: FormattingAction) => {
    const commands: Partial<Record<FormattingAction, string>> = { undo: "undo", redo: "redo", bold: "format-bold", italic: "format-italic", underline: "format-underline", clear: "format-clear", link: "insert-link", image: "insert-picture", bullet: "format-bullets", ordered: "format-numbering", "align-left": "format-align-left", "align-center": "format-align-center", "align-right": "format-align-right" };
    if (commands[value]) execute(commands[value]);
  };
  return <div key={structureReconcileToken} ref={bindHost} className="docs-word-host" data-selected-run={runId} onKeyDown={handleKey} onKeyDownCapture={handleStructureKey}
    onInputCapture={(event) => {
      const range = rejectedDocumentInput.current;
      if (!range) return;
      event.stopPropagation(); pendingSelection.current = range;
      if (!crossComposing.current) { rejectedDocumentInput.current = null; setStructureReconcileToken((value) => value + 1); }
      setReconcileToken((value) => value + 1);
    }}
    onCompositionStartCapture={(event) => {
      const range = host.current && readWordSelection(host.current);
      if (range && range.anchor.paragraphId !== range.focus.paragraphId) { event.stopPropagation(); crossComposing.current = true; rejectedDocumentInput.current = range; }
    }}
    onCompositionEndCapture={(event) => {
      const range = rejectedDocumentInput.current;
      if (!range) return;
      event.stopPropagation(); crossComposing.current = false; rejectedDocumentInput.current = null; pendingSelection.current = range;
      setStructureReconcileToken((value) => value + 1);
      rejectChange("Composition across paragraphs is not supported. The source and selection were preserved.");
    }}
    onPointerUp={rememberSelection} onKeyUp={rememberSelection} onPointerDownCapture={(event) => { if (!(event.target as HTMLElement).closest("[data-paragraph-id]")) rememberSelection(); else beginDragSelection(event); }}
    onCopyCapture={(event) => {
      if (!(event.target as HTMLElement).closest("[data-paragraph-id]")) return;
      const range = host.current && readWordSelection(host.current);
      if (!range || range.anchor.paragraphId === range.focus.paragraphId && range.anchor.offset === range.focus.offset) return;
      // Native copy only sees one editing host and skips protected runs.
      // The logical range is the document truth in every format, read-only included.
      event.preventDefault(); event.stopPropagation();
      logicalSelection.current = range;
      event.clipboardData.setData("text/plain", wordRangeText(latestDocument.current, range));
    }}
    onPasteCapture={(event) => {
      if (!(event.target as HTMLElement).closest("[data-paragraph-id]")) return;
      const range = host.current && readWordSelection(host.current);
      if (!range || range.anchor.paragraphId === range.focus.paragraphId) return;
      event.preventDefault(); event.stopPropagation();
      const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
      if (text) replaceSelection(range, text);
    }}
    onCutCapture={(event) => {
      if (!(event.target as HTMLElement).closest("[data-paragraph-id]")) return;
      const range = host.current && readWordSelection(host.current);
      if (!range || range.anchor.paragraphId === range.focus.paragraphId) return;
      event.preventDefault(); event.stopPropagation();
      const text = wordRangeText(latestDocument.current, range);
      replaceSelection(range, "", () => event.clipboardData.setData("text/plain", text));
    }}
    onClickCapture={(event) => handleExternalLinkClick(event.nativeEvent)} onAuxClickCapture={(event) => handleExternalLinkClick(event.nativeEvent)}>
    <FormattingToolbar
      startControls={<>
        {!onCommandsReady ? <button type="button" aria-label="Document commands" title="Document commands (⌘K / Ctrl+K)" onClick={openPalette} disabled={!!tool}>Commands</button> : null}
        {/* Page setup and spacing live in the Layout menu too; the toolbar is
            where people look for them. A second click closes the panel. */}
        {capabilities.pageLayout ? <button type="button" className={LAYOUT_BUTTON} aria-label="Page setup" title="Page setup: paper size, orientation and margins" aria-pressed={tool === "page"} disabled={tool ? tool !== "page" : !enabledCommands.includes("layout-page-setup")} onClick={() => tool === "page" ? setTool(null) : command("layout-page-setup")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8.5 7h7M8.5 17h7M8.5 7v10M15.5 7v10" strokeDasharray="1.6 2" /></svg>
        </button> : null}
        {capabilities.paragraphFormatting ? <button type="button" className={LAYOUT_BUTTON} aria-label="Paragraph spacing" title="Paragraph spacing: before, after and line spacing" aria-pressed={tool === "spacing"} disabled={tool ? tool !== "spacing" : !enabledCommands.includes("layout-paragraph-spacing")} onClick={() => tool === "spacing" ? setTool(null) : command("layout-paragraph-spacing")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 6h9M11 12h9M11 18h9M5 4v16M3 6l2-2 2 2M3 18l2 2 2-2" /></svg>
        </button> : null}
      </>}
      state={{ bold: selectionFormat.bold, italic: selectionFormat.italic, underline: selectionFormat.underline, bullet: paragraph?.listKind === "bullet", ordered: paragraph?.listKind === "numbered", alignLeft: (paragraph?.alignment ?? "left") === "left", alignCenter: paragraph?.alignment === "center", alignRight: paragraph?.alignment === "right", canUndo, canRedo }}
      canEdit={canFormat} appearance={{ ...DEFAULT_APPEARANCE, zoom: zoom / 100 }}
      onAppearance={(next) => { if (canView() && !tool && !paletteOpen) setZoom(Math.min(200, Math.max(50, Math.round(next.zoom * 100)))); }}
      currentStyle={paragraph?.styleId ?? ""} styles={styles}
      currentFont={selectionFormat.fontFamily === "mixed" ? "" : selectionFormat.fontFamily ?? ""} fonts={fonts} selecting
      fontPlaceholder={selectionFormat.fontFamily === "mixed" ? "Mixed fonts" : "Inherited font"}
      currentSize={typeof selectionFormat.fontSizePoints === "number" ? selectionFormat.fontSizePoints : null}
      sizePlaceholder={selectionFormat.fontSizePoints === "mixed" ? "Mixed" : "Auto"}
      onFont={(fontFamily) => { if (run && canFormat && canMutate()) formatRun({ fontFamily: fontFamily || null }, run.id); }}
      onSize={(fontSizePoints) => { if (run && canFormat && canMutate()) formatRun({ fontSizePoints }, run.id); }}
      onStyle={(style) => setParagraphStyle(style || null)} onAction={action}
      onColor={(color) => { if (run && canFormat && canMutate()) formatRun({ color: color?.replace(/^#/, "") ?? null }, run.id); }}
      supportedActions={isDocx ? WORD_ACTIONS : WORD_ACTIONS.filter((item) => !["link", "image", "bullet", "ordered"].includes(item))} showStyleControls={isDocx} showWidthControls={false} onHistory={onHistory ? () => execute("document-history") : undefined} />
    {!selectionSupported ? <div className="docs-warning" role="status">Select text within one paragraph to format it.</div> : null}
    {paletteOpen && !onCommandsReady ? <div onKeyDown={(event) => event.stopPropagation()}><CommandPalette commands={paletteCommands} onClose={closePalette} /></div> : null}
    {tool ? <WordToolsDialog key={tool} tool={tool} onClose={() => setTool(null)} document={document} paragraph={paragraph} runId={runId} fontSelection={selectionFormat} readOnly={blocked} onApply={apply} onError={rejectChange} onReplace={perform} onSelectMatch={selectMatch} onFormatRun={formatRun} onAddLink={addLink} onInsertBreak={insertBreak} review={{ tracking, author: reviewAuthor, originalView, onTracking: (value) => { if (canMutate()) { textSelection.current = null; setTracking(value); } }, onAuthor: setReviewAuthor, onOriginalView: (value) => { if (canView()) { textSelection.current = null; setOriginalView(value); } } }} /> : null}
    {tracking ? <div className="docs-tracking-banner" role="status">Tracking paragraph text as {reviewAuthor || "an author is required"}. Formatting, layout and inserted content are not tracked.</div> : null}
    {originalView ? <div className="docs-tracking-banner" role="status">Original text view. Switch to Final text to edit.</div> : null}
    {!tracking && document.revisions.length > 0 ? <div className="docs-tracking-banner">Paragraphs with pending revisions are read-only until you accept/reject them or enable same-author paragraph tracking.</div> : null}
    {!document.canEdit ? <div className="docs-warning" role="status">Read-only to protect unsupported {isDocx ? "Word" : document.format.toUpperCase()} features. You can export the unchanged original.</div> : null}
    {error ? <div className="docs-error" role="alert">{error}</div> : null}
    <div className="docs-word-body">{outline ? <nav className="docs-word-outline" aria-label="Document outline"><strong>Outline</strong>{document.paragraphs.filter((item) => item.styleId && /^(?:heading|title)/i.test(item.styleId)).map((item) => <button type="button" key={item.id} onClick={() => { setSelected(item.id); [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === item.id)?.focus(); }}>{item.text || "Empty heading"}</button>)}</nav> : null}<div className="docs-word-scroll"><div className={pageView ? "docs-word-paper" : "docs-word-continuous"} style={{
      width: pageView ? `${document.pageLayout.widthPoints * 96 / 72}px` : "100%", minHeight: pageView ? `${document.pageLayout.heightPoints * 96 / 72}px` : "100%",
      padding: pageView ? `${document.pageLayout.marginTopPoints * 96 / 72}px ${document.pageLayout.marginRightPoints * 96 / 72}px ${document.pageLayout.marginBottomPoints * 96 / 72}px ${document.pageLayout.marginLeftPoints * 96 / 72}px` : "32px", zoom: zoom / 100,
    }}>
      {document.blocks.map((block) => block.kind === "paragraph" ? paragraphNode(block.paragraphId) : <table key={block.tableId} className="docs-word-table" aria-label="Document table"><tbody>{document.tables.find((table) => table.id === block.tableId)?.rows.map((row, r) => <tr key={r}>{row.cells.map((cell, c) => <td key={c}>{cell.paragraphs.map((paragraph) => paragraphNode(paragraph.id))}</td>)}</tr>)}</tbody></table>)}
    </div></div></div>
    <LinkPreviewCard container={linkContainer} revision={document} />
  </div>;
}
