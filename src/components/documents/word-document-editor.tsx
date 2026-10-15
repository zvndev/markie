import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { applyDocxOperations, replaceDocxText, type DocxDocument, type DocxOperation, type DocxRunFormat } from "@/lib/office/docx";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import type { FormattingAction } from "@/lib/format-controls";
import { DEFAULT_APPEARANCE } from "@/lib/doc-appearance";
import { FormattingToolbar } from "@/components/formatting-toolbar";
import { CommandPalette } from "@/components/command-palette";
import type { AppCommand } from "@/lib/commands";
import documentMenuCommands from "../../../electron/document-menu-commands.json";
import { WordParagraph } from "./word-paragraph";
import { WordToolsDialog, type WordTool } from "./word-toolbar";
import { WordImage } from "./word-images";
import type { WordTextMatch } from "./word-find";
import "./document-workspace.css";

interface WordDocumentEditorProps { document: DocxDocument; readOnly?: boolean; onChange: (document: DocxDocument) => void; onCommandsReady?: (target: DocumentCommandTarget | null) => void; onHistory?: () => void }
const WORD_ACTIONS: readonly FormattingAction[] = ["undo", "redo", "bold", "italic", "underline", "link", "image", "bullet", "ordered", "align-left", "align-center", "align-right", "clear"];
const WORD_FONTS = ["Arial", "Calibri", "Georgia", "Times New Roman", "Helvetica"].map((font) => ({ id: font, label: font }));
const WORD_STYLES = [{ id: "normal", label: "Normal" }, { id: "Heading1", label: "Heading 1" }, { id: "Heading2", label: "Heading 2" }, { id: "Heading3", label: "Heading 3" }];
export function WordDocumentEditor({ document, readOnly = false, onChange, onCommandsReady, onHistory }: WordDocumentEditorProps) {
  const [selected, setSelected] = useState<string | undefined>(document.paragraphs[0]?.id);
  const [runId, setRunId] = useState<string | undefined>(document.paragraphs[0]?.runs[0]?.id);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [pageView, setPageView] = useState(() => typeof window === "undefined" || window.innerWidth > 650);
  const [outline, setOutline] = useState(false);
  const [tracking, setTracking] = useState(false), [reviewAuthor, setReviewAuthor] = useState("You"), [originalView, setOriginalView] = useState(false);
  const [reconcileToken, setReconcileToken] = useState(0);
  const [tool, setTool] = useState<WordTool | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteFocus = useRef<HTMLElement | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const undoHistory = useRef<DocxDocument[]>([]), redoHistory = useRef<DocxDocument[]>([]);
  const latestDocument = useRef(document);
  const host = useRef<HTMLDivElement>(null);
  const textSelection = useRef<WordTextMatch | null>(null);
  const access = useRef({ readOnly, canEdit: document.canEdit, originalView }); access.current = { readOnly, canEdit: document.canEdit, originalView };
  const canView = () => !!host.current && !host.current.closest("[inert]");
  const canMutate = () => canView() && !access.current.readOnly && access.current.canEdit && !access.current.originalView;
  const openPalette = () => { if (onCommandsReady || tool || !canView()) return; paletteFocus.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null; setPaletteOpen(true); };
  const closePalette = () => { setPaletteOpen(false); requestAnimationFrame(() => { const prior = paletteFocus.current; if (prior?.isConnected && !prior.closest("[inert]")) prior.focus(); }); };
  latestDocument.current = document;
  const rejectChange = (failure: unknown) => {
    setError(`${typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "That change could not be applied."} The change was not applied.`);
    setReconcileToken((value) => value + 1);
  };
  const perform = (next: DocxDocument) => {
    if (!canMutate()) return;
    undoHistory.current.push(latestDocument.current); redoHistory.current = [];
    if (undoHistory.current.length > 100) undoHistory.current.shift();
    latestDocument.current = next; onChange(next); setError(null);
  };
  const apply = (operations: readonly DocxOperation[]) => {
    if (!canMutate()) return;
    try { perform(applyDocxOperations(latestDocument.current, operations)); }
    catch (failure) { rejectChange(failure); }
  };
  const blocked = readOnly || !document.canEdit;
  const selectMatch = (match: WordTextMatch) => {
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
    if (!canMutate()) return;
    const selection = textSelection.current;
    if (!selection || selection.paragraphId !== selected || selection.start === selection.end) { apply([{ type: "format-run", runId: activeRun, style }]); return; }
    try {
      perform(applyDocxOperations(latestDocument.current, [{ type: "format-range", ...selection, style }]));
      requestAnimationFrame(() => selectMatch(selection));
    } catch (failure) { rejectChange(failure); }
  };
  const addLink = (target: string) => {
    if (!canMutate()) return;
    const selection = textSelection.current;
    if (!selection || selection.start === selection.end) { rejectChange("Select text within a paragraph before adding a link."); return; }
    apply([{ type: "set-hyperlink", ...selection, target }]);
    requestAnimationFrame(() => selectMatch(selection));
  };
  const insertBreak = () => {
    if (!canMutate()) return;
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
  const undo = () => { if (!canMutate()) return; const previous = undoHistory.current.pop(); if (previous) { textSelection.current = null; redoHistory.current.push(latestDocument.current); latestDocument.current = previous; onChange(previous); } };
  const redo = () => { if (!canMutate()) return; const next = redoHistory.current.pop(); if (next) { textSelection.current = null; undoHistory.current.push(latestDocument.current); latestDocument.current = next; onChange(next); } };
  const pasteParagraphs = (paragraphId: string, start: number, end: number, text: string) => {
    if (!canMutate()) return;
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
      onPasteParagraphs={pasteParagraphs} onSelection={(paragraphId, start, end) => { textSelection.current = { paragraphId, start, end }; setSelectionRevision((value) => value + 1); }}
      onRemovePageBreaks={(ids) => apply(ids.map((pageBreakId) => ({ type: "remove-page-break", pageBreakId })))} onRejectStructure={rejectChange} />;
    // Selection offsets are kept separately from DOM focus so toolbar clicks
    // format the selected substring rather than its entire underlying run.
    return images.length ? <div key={id}>{images.map((image) => <WordImage key={image.id} document={document} image={image} selected={selected === id} onSelect={() => { setSelected(id); setRunId(undefined); }} />)}{paragraph.text || paragraph.runs.some((run) => run.pageBreaks.length) ? field : null}</div> : field;
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
    formatRun(key === "b" ? { bold: !run.style.bold } : key === "i" ? { italic: !run.style.italic } : { underline: run.style.underline && run.style.underline !== "none" ? null : "single" }, run.id);
  };
  const paragraph = document.paragraphs.find((item) => item.id === selected), run = paragraph?.runs.find((item) => item.id === runId && item.canEdit);
  const fonts = run?.style.fontFamily && !WORD_FONTS.some((font) => font.id === run.style.fontFamily) ? [...WORD_FONTS, { id: run.style.fontFamily, label: run.style.fontFamily }] : WORD_FONTS;
  const styles = paragraph?.styleId && !WORD_STYLES.some((style) => style.id === paragraph.styleId) ? [...WORD_STYLES, { id: paragraph.styleId, label: paragraph.styleId }] : WORD_STYLES;
  const editable = !blocked && !originalView, canUndo = editable && undoHistory.current.length > 0, canRedo = editable && redoHistory.current.length > 0;
  const heading = (styleId: string | null) => {
    if (!paragraph || !canMutate()) return;
    const size = styleId === "Heading1" ? 22 : styleId === "Heading2" ? 17 : styleId === "Heading3" ? 14 : 12;
    apply([{ type: "format-paragraph", paragraphId: paragraph.id, format: { styleId } }, ...paragraph.runs.filter((item) => item.canEdit).map((item): DocxOperation => ({ type: "format-run", runId: item.id, style: { fontSizePoints: size, bold: !!styleId } }))]);
  };
  const selectedTable = document.tables.some((table) => table.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((item) => item.id === selected))));
  const hasLinkSelection = !!paragraph && (!!document.hyperlinks.find((link) => link.paragraphId === selected && !!runId && link.runIds.includes(runId)) || !!textSelection.current && textSelection.current.start !== textSelection.current.end);
  const availableCommands = tool ? [] : ["find", "zoom-in", "zoom-out", "view-page", "view-continuous", "view-outline", "view-zoom-reset", "review-comments", "review-tracking", "review-changes", "review-final", ...(document.originalText === undefined ? [] : ["review-original"]), ...(onHistory ? ["document-history"] : []),
    ...(canUndo ? ["undo"] : []), ...(canRedo ? ["redo"] : []),
    ...(editable ? ["layout-page-setup", "layout-letter", "layout-a4", "layout-legal", "layout-portrait", "layout-landscape"] : []),
    ...(editable && paragraph ? ["format-normal", "format-heading-1", "format-heading-2", "format-heading-3", "format-bullets", "format-numbering", "format-align-left", "format-align-center", "format-align-right", "format-align-justify", "insert-paragraph", "insert-table", "layout-paragraph-spacing", ...(!selectedTable ? ["insert-picture"] : []), ...(!tracking && !paragraph.revisionIds.length && (!textSelection.current || textSelection.current.start === textSelection.current.end) ? ["insert-page-break"] : []), ...(!tracking && !paragraph.revisionIds.length && hasLinkSelection ? ["insert-link"] : [])] : []),
    ...(editable && run ? ["format-bold", "format-italic", "format-underline", "format-clear", "format-font"] : [])];
  const enabledCommands = paletteOpen ? [] : availableCommands;
  const command = (id: string) => {
    if (!canView() || !enabledCommands.includes(id)) return;
    if (id === "undo") { undo(); return; } if (id === "redo") { redo(); return; }
    if (id === "find") { setOriginalView(false); setTool("find"); return; }
    if (id === "document-history") { onHistory?.(); return; }
    if (id === "zoom-in" || id === "zoom-out" || id === "view-zoom-reset") { setZoom(id === "view-zoom-reset" ? 100 : Math.min(200, Math.max(50, zoom + (id === "zoom-in" ? 10 : -10)))); return; }
    if (id === "view-page" || id === "view-continuous") { setPageView(id === "view-page"); return; }
    if (id === "view-outline") { setOutline(!outline); return; }
    if (id === "review-original" || id === "review-final") { textSelection.current = null; setOriginalView(id === "review-original"); return; }
    const dialog: Record<string, WordTool> = { "format-font": "font", "insert-picture": "picture", "insert-table": "table", "insert-link": "link", "layout-page-setup": "page", "layout-paragraph-spacing": "spacing", "review-comments": "review", "review-tracking": "review", "review-changes": "review" };
    if (dialog[id]) { setTool(dialog[id]); return; }
    if (!canMutate()) return;
    if (run && id === "format-bold") formatRun({ bold: !run.style.bold }, run.id);
    else if (run && id === "format-italic") formatRun({ italic: !run.style.italic }, run.id);
    else if (run && id === "format-underline") formatRun({ underline: run.style.underline && run.style.underline !== "none" ? null : "single" }, run.id);
    else if (run && id === "format-clear") formatRun({ bold: null, italic: null, underline: null, color: null, fontFamily: null, fontSizePoints: null }, run.id);
    else if (id === "format-normal" || id.startsWith("format-heading-")) heading(id === "format-normal" ? null : `Heading${id.at(-1)}`);
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
  return <div ref={host} className="docs-word-host" data-selected-run={runId} onKeyDown={handleKey}>
    <FormattingToolbar startControls={!onCommandsReady ? <button type="button" aria-label="Document commands" title="Document commands (⌘K / Ctrl+K)" onClick={openPalette} disabled={!!tool}>Commands</button> : undefined} state={{ bold: !!run?.style.bold, italic: !!run?.style.italic, underline: !!run?.style.underline && run.style.underline !== "none", bullet: paragraph?.listKind === "bullet", ordered: paragraph?.listKind === "numbered", alignLeft: (paragraph?.alignment ?? "left") === "left", alignCenter: paragraph?.alignment === "center", alignRight: paragraph?.alignment === "right", canUndo, canRedo }} canEdit={editable && !!run} appearance={{ ...DEFAULT_APPEARANCE, zoom: zoom / 100 }} onAppearance={(next) => { if (canView()) setZoom(Math.min(200, Math.max(50, Math.round(next.zoom * 100)))); }} currentStyle={paragraph?.styleId ?? "normal"} styles={styles} currentFont={run?.style.fontFamily ?? ""} fonts={fonts} selecting currentSize={run?.style.fontSizePoints ?? 12} onFont={(fontFamily) => { if (run && canMutate()) formatRun({ fontFamily: fontFamily || null }, run.id); }} onSize={(fontSizePoints) => { if (run && canMutate()) formatRun({ fontSizePoints }, run.id); }} onStyle={(style) => heading(style === "normal" ? null : style)} onAction={action} onColor={(color) => { if (run && canMutate()) formatRun({ color: color?.replace(/^#/, "") ?? null }, run.id); }} supportedActions={WORD_ACTIONS} showWidthControls={false} onHistory={onHistory ? () => execute("document-history") : undefined} />
    {paletteOpen && !onCommandsReady ? <div onKeyDown={(event) => event.stopPropagation()}><CommandPalette commands={paletteCommands} onClose={closePalette} /></div> : null}
    {tool ? <WordToolsDialog key={tool} tool={tool} onClose={() => setTool(null)} document={document} paragraph={paragraph} runId={runId} readOnly={blocked} onApply={apply} onError={rejectChange} onReplace={perform} onSelectMatch={selectMatch} onFormatRun={formatRun} onAddLink={addLink} onInsertBreak={insertBreak} review={{ tracking, author: reviewAuthor, originalView, onTracking: (value) => { if (canMutate()) { textSelection.current = null; setTracking(value); } }, onAuthor: setReviewAuthor, onOriginalView: (value) => { if (canView()) { textSelection.current = null; setOriginalView(value); } } }} /> : null}
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
