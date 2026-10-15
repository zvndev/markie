import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { applyDocxOperations, replaceDocxText, type DocxDocument, type DocxOperation, type DocxRunFormat } from "@/lib/office/docx";
import { WordParagraph } from "./word-paragraph";
import { WordToolbar } from "./word-toolbar";
import { WordImage } from "./word-images";
import type { WordTextMatch } from "./word-find";

interface WordDocumentEditorProps { document: DocxDocument; readOnly?: boolean; onChange: (document: DocxDocument) => void }
export function WordDocumentEditor({ document, readOnly = false, onChange }: WordDocumentEditorProps) {
  const [selected, setSelected] = useState<string | undefined>(document.paragraphs[0]?.id);
  const [runId, setRunId] = useState<string | undefined>(document.paragraphs[0]?.runs[0]?.id);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [pageView, setPageView] = useState(() => typeof window === "undefined" || window.innerWidth > 650);
  const [outline, setOutline] = useState(false);
  const [tracking, setTracking] = useState(false), [reviewAuthor, setReviewAuthor] = useState("You"), [originalView, setOriginalView] = useState(false);
  const [reconcileToken, setReconcileToken] = useState(0);
  const undoHistory = useRef<DocxDocument[]>([]), redoHistory = useRef<DocxDocument[]>([]);
  const latestDocument = useRef(document);
  const host = useRef<HTMLDivElement>(null);
  const textSelection = useRef<WordTextMatch | null>(null);
  latestDocument.current = document;
  const rejectChange = (failure: unknown) => {
    setError(`${typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "That change could not be applied."} The change was not applied.`);
    setReconcileToken((value) => value + 1);
  };
  const perform = (next: DocxDocument) => {
    undoHistory.current.push(latestDocument.current); redoHistory.current = [];
    if (undoHistory.current.length > 100) undoHistory.current.shift();
    latestDocument.current = next; onChange(next); setError(null);
  };
  const apply = (operations: readonly DocxOperation[]) => {
    try { perform(applyDocxOperations(latestDocument.current, operations)); }
    catch (failure) { rejectChange(failure); }
  };
  const blocked = readOnly || !document.canEdit;
  const selectMatch = (match: WordTextMatch) => {
    textSelection.current = match;
    setSelected(match.paragraphId);
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
    const selection = textSelection.current;
    if (!selection || selection.paragraphId !== selected || selection.start === selection.end) { apply([{ type: "format-run", runId: activeRun, style }]); return; }
    try {
      perform(applyDocxOperations(latestDocument.current, [{ type: "format-range", ...selection, style }]));
      requestAnimationFrame(() => selectMatch(selection));
    } catch (failure) { rejectChange(failure); }
  };
  const addLink = (target: string) => {
    const selection = textSelection.current;
    if (!selection || selection.start === selection.end) { rejectChange("Select text within a paragraph before adding a link."); return; }
    apply([{ type: "set-hyperlink", ...selection, target }]);
    requestAnimationFrame(() => selectMatch(selection));
  };
  const insertBreak = () => {
    const selection = textSelection.current;
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === (selection?.paragraphId ?? selected));
    if (!paragraph) { rejectChange("Place the cursor in a paragraph before inserting a page break."); return; }
    if (selection && selection.start !== selection.end) { rejectChange("Use a cursor position, not a text selection, to insert a page break."); return; }
    const offset = selection?.end ?? paragraph.text.length;
    const operations: DocxOperation[] = [{ type: "insert-page-break", paragraphId: paragraph.id, offset }];
    if (offset === paragraph.text.length) operations.push({ type: "insert-paragraph", afterParagraphId: paragraph.id, text: "" });
    try {
      const priorParagraphs = new Set(latestDocument.current.paragraphs.map((item) => item.id));
      const next = applyDocxOperations(latestDocument.current, operations); perform(next); textSelection.current = null;
      const inserted = next.paragraphs.find((item) => !priorParagraphs.has(item.id));
      if (inserted) {
        setSelected(inserted.id); setRunId(inserted.runs[0]?.id);
        requestAnimationFrame(() => [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === inserted.id)?.focus());
      }
    } catch (failure) { rejectChange(failure); }
  };
  const undo = () => { const previous = undoHistory.current.pop(); if (previous) { textSelection.current = null; redoHistory.current.push(document); onChange(previous); } };
  const redo = () => { const next = redoHistory.current.pop(); if (next) { textSelection.current = null; undoHistory.current.push(document); onChange(next); } };
  const pasteParagraphs = (paragraphId: string, start: number, end: number, text: string) => {
    if (tracking) { rejectChange("Turn off paragraph text tracking before inserting new paragraphs."); return; }
    try {
      const paragraph = document.paragraphs.find((item) => item.id === paragraphId)!;
      const lines = text.split("\n");
      let next = applyDocxOperations(document, [{ type: "replace-paragraph", paragraphId, text: paragraph.text.slice(0, start) + lines[0] }]);
      let after = paragraphId;
      for (let index = 1; index < lines.length; index++) {
        const beforeIds = new Set(next.paragraphs.map((item) => item.id));
        next = applyDocxOperations(next, [{ type: "insert-paragraph", afterParagraphId: after, text: lines[index] + (index === lines.length - 1 ? paragraph.text.slice(end) : "") }]);
        const inserted = next.paragraphs.find((item) => !beforeIds.has(item.id))!;
        after = inserted.id;
        const style = paragraph.runs[0]?.style;
        if (style && inserted.runs[0]) next = applyDocxOperations(next, [{ type: "format-run", runId: inserted.runs[0].id, style }]);
      }
      perform(next); setSelected(after); setRunId(next.paragraphs.find((item) => item.id === after)?.runs[0]?.id);
      requestAnimationFrame(() => [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === after)?.focus());
    } catch (failure) { rejectChange(failure); }
  };
  const paragraphNode = (id: string) => {
    const paragraph = document.paragraphs.find((item) => item.id === id);
    if (!paragraph) return null;
    const images = document.images.filter((image) => image.paragraphId === id);
    const shown = originalView && paragraph.originalRuns ? { ...paragraph, text: paragraph.originalText ?? paragraph.text, runs: paragraph.originalRuns } : paragraph;
    const field = <WordParagraph key={id} paragraph={shown} index={document.paragraphs.indexOf(paragraph)} selected={selected === id} readOnly={blocked || originalView || (!tracking && paragraph.revisionIds.length > 0)} trackText={tracking} reconcileToken={reconcileToken}
      onSelect={(paragraphId, selectedRun) => { setSelected(paragraphId); setRunId(selectedRun); }}
      onReplace={(paragraphId, text) => apply([tracking ? { type: "track-paragraph-text", paragraphId, text, author: reviewAuthor.trim() } : { type: "replace-paragraph", paragraphId, text }])}
      onRuns={(edits) => {
        if (!edits.length) return;
        if (tracking) {
          const replacements = new Map(edits.map((edit) => [edit.runId, edit.text]));
          apply([{ type: "track-paragraph-text", paragraphId: id, text: paragraph.runs.map((run) => replacements.get(run.id) ?? run.text).join(""), author: reviewAuthor.trim() }]);
        } else try { perform(replaceDocxText(latestDocument.current, edits)); } catch (failure) { rejectChange(failure); }
      }}
      onSplit={(paragraphId, offset) => pasteParagraphs(paragraphId, offset, offset, "\n")}
      onPasteParagraphs={pasteParagraphs} onSelection={(paragraphId, start, end) => { textSelection.current = { paragraphId, start, end }; }}
      onRemovePageBreaks={(ids) => apply(ids.map((pageBreakId) => ({ type: "remove-page-break", pageBreakId })))} onRejectStructure={rejectChange} />;
    // Selection offsets are kept separately from DOM focus so toolbar clicks
    // format the selected substring rather than its entire underlying run.
    return images.length ? <div key={id}>{images.map((image) => <WordImage key={image.id} document={document} image={image} selected={selected === id} onSelect={() => { setSelected(id); setRunId(undefined); }} />)}{paragraph.text || paragraph.runs.some((run) => run.pageBreaks.length) ? field : null}</div> : field;
  };
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault(); textSelection.current = null; setOriginalView(false);
      [...(host.current?.querySelectorAll<HTMLButtonElement>("[role=tab]") ?? [])].find((tab) => tab.textContent === "Home")?.click();
      requestAnimationFrame(() => host.current?.querySelector<HTMLInputElement>('[aria-label="Find Word text"]')?.focus()); return;
    }
    if ((event.target as HTMLElement).closest("input,textarea,select")) return;
    if (key === "z") { event.preventDefault(); if (!blocked && !originalView) { if (event.shiftKey) redo(); else undo(); } return; }
    if (!["b", "i", "u"].includes(key)) return;
    event.preventDefault(); if (blocked || originalView) return;
    const paragraph = latestDocument.current.paragraphs.find((item) => item.id === selected);
    const run = paragraph?.runs.find((item) => item.id === runId && item.canEdit) ?? paragraph?.runs.find((item) => item.canEdit);
    if (!run) return;
    formatRun(key === "b" ? { bold: !run.style.bold } : key === "i" ? { italic: !run.style.italic } : { underline: run.style.underline && run.style.underline !== "none" ? null : "single" }, run.id);
  };
  return <div ref={host} className="docs-word-host" data-selected-run={runId} onKeyDown={handleKey}>
    <WordToolbar document={document} paragraph={document.paragraphs.find((item) => item.id === selected) ?? document.paragraphs[0]} runId={runId} readOnly={blocked} onApply={apply} onUndo={undo} onRedo={redo} canUndo={undoHistory.current.length > 0} canRedo={redoHistory.current.length > 0} zoom={zoom} pageView={pageView} outline={outline} onZoom={setZoom} onPageView={setPageView} onOutline={() => setOutline(!outline)} onError={rejectChange} onReplace={perform} onSelectMatch={selectMatch} onFormatRun={formatRun} onAddLink={addLink} onInsertBreak={insertBreak} review={{ tracking, author: reviewAuthor, originalView, onTracking: (value) => { textSelection.current = null; setTracking(value); }, onAuthor: setReviewAuthor, onOriginalView: (value) => { textSelection.current = null; setOriginalView(value); } }} />
    {tracking ? <div className="docs-tracking-banner" role="status">Tracking paragraph text as {reviewAuthor || "an author is required"}. Formatting, layout and inserted content are not tracked.</div> : null}
    {originalView ? <div className="docs-tracking-banner" role="status">Original text view. Switch to Final text to edit.</div> : null}
    {!tracking && document.revisions.length > 0 ? <div className="docs-tracking-banner">Paragraphs with pending revisions are read-only until you accept/reject them or enable same-author paragraph tracking.</div> : null}
    {!document.canEdit ? <div className="docs-warning" role="status">Read-only to protect unsupported Word features. You can export the unchanged original.</div> : null}
    {error ? <div className="docs-error" role="alert">{error}</div> : null}
    <div className="docs-word-body">{outline ? <nav className="docs-word-outline" aria-label="Document outline"><strong>Outline</strong>{document.paragraphs.filter((item) => item.styleId && /^(?:heading|title)/i.test(item.styleId)).map((item) => <button type="button" key={item.id} onClick={() => { setSelected(item.id); [...(host.current?.querySelectorAll<HTMLElement>("[data-paragraph-id]") ?? [])].find((node) => node.dataset.paragraphId === item.id)?.focus(); }}>{item.text || "Empty heading"}</button>)}</nav> : null}<div className="docs-word-scroll"><div className={pageView ? "docs-word-paper" : "docs-word-continuous"} style={{
      width: pageView ? `${document.pageLayout.widthPoints * 96 / 72}px` : "100%", minHeight: pageView ? `${document.pageLayout.heightPoints * 96 / 72}px` : "100%",
      padding: pageView ? `${document.pageLayout.marginTopPoints * 96 / 72}px ${document.pageLayout.marginRightPoints * 96 / 72}px ${document.pageLayout.marginBottomPoints * 96 / 72}px ${document.pageLayout.marginLeftPoints * 96 / 72}px` : "32px", zoom: zoom / 100,
    }}>
      {document.blocks.map((block) => block.kind === "paragraph" ? paragraphNode(block.paragraphId) : <table key={block.tableId} className="docs-word-table" aria-label="Document table"><tbody>{document.tables.find((table) => table.id === block.tableId)?.rows.map((row, r) => <tr key={r}>{row.cells.map((cell, c) => <td key={c}>{cell.paragraphs.map((paragraph) => paragraphNode(paragraph.id))}</td>)}</tr>)}</tbody></table>)}
    </div></div></div>
  </div>;
}
