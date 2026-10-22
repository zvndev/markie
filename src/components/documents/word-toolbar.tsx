import { useEffect, useId, useRef, useState } from "react";
import type { DocxOperation, DocxParagraph, DocxRunFormat } from "@/lib/office/docx";
import type { RichDocument } from "@/lib/office/rich-text-types";
import { WordImagePicker } from "./word-images";
import { WordFindTools } from "./word-find-tools";
import type { WordTextMatch } from "./word-find";
import { WordReviewTools, type WordReviewState } from "./word-review-tools";
import { WordLinksAndBreaks } from "./word-links-and-breaks";

export type WordTool = "font" | "picture" | "table" | "link" | "page" | "spacing" | "review" | "find";
const TITLES: Record<WordTool, string> = { font: "Font", picture: "Picture", table: "Table", link: "Link and Page Breaks", page: "Page Setup", spacing: "Paragraph Spacing", review: "Document Review", find: "Find and Replace" };
interface WordToolsDialogProps {
  tool: WordTool; onClose(): void; document: RichDocument; paragraph?: DocxParagraph; runId?: string; readOnly: boolean;
  fontSelection: { fontFamily?: string; fontSizePoints?: number | "mixed"; color?: string };
  onApply: (operations: readonly DocxOperation[]) => void; onError: (message: string) => void;
  onReplace: (document: RichDocument) => void; onSelectMatch: (match: WordTextMatch) => void;
  onFormatRun: (style: DocxRunFormat, runId: string) => void; review: WordReviewState;
  onAddLink: (target: string) => void; onInsertBreak: () => void;
}
function NumberTool({ label, caption = label, value, placeholder = "Auto", min = 0, max = 500, step = 1, onChange }: { label: string; caption?: string; value?: number; placeholder?: string; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="docs-number-tool">{caption}<input key={value} type="number" aria-label={label} defaultValue={value ?? ""} placeholder={placeholder} min={min} max={max} step={step} onBlur={(event) => { const input = Number(event.target.value); if (event.target.value && Number.isFinite(input) && input >= min && input <= max && Math.abs((input - min) / step - Math.round((input - min) / step)) < .00001 && input !== value) onChange(input); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

const PAPERS = [
  { id: "letter", label: "Letter", size: "8.5 × 11 in", points: [612, 792] },
  { id: "a4", label: "A4", size: "210 × 297 mm", points: [595.3, 841.9] },
  { id: "legal", label: "Legal", size: "8.5 × 14 in", points: [612, 1008] },
] as const;
/** The named paper a page is, in either orientation, or null for a custom size. */
function paperOf(layout: { widthPoints: number; heightPoints: number }) {
  const short = Math.min(layout.widthPoints, layout.heightPoints), long = Math.max(layout.widthPoints, layout.heightPoints);
  return PAPERS.find((paper) => Math.abs(paper.points[0] - short) < 2 && Math.abs(paper.points[1] - long) < 2)?.id ?? null;
}
const inches = (points: number) => String(Math.round(points / 72 * 100) / 100);

/** Advanced operations are opened from Markie's native menus, not a second ribbon. */
export function WordToolsDialog({ tool, onClose, document, paragraph, runId, fontSelection, readOnly: permissionReadOnly, onApply, onError, onReplace, onSelectMatch, onFormatRun, review, onAddLink, onInsertBreak }: WordToolsDialogProps) {
  const titleId = useId(), dialog = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  const [rows, setRows] = useState(2), [columns, setColumns] = useState(2);
  const supported = document.format === "docx" || ["font", "spacing", "find", "page"].includes(tool);
  const readOnly = permissionReadOnly || !document.canEdit || review.originalView || !supported;
  const selectionColor = fontSelection.color && /^[0-9a-f]{6}$/i.test(fontSelection.color) ? `#${fontSelection.color}` : undefined;
  const run = paragraph?.runs.find((item) => item.id === runId && item.canEdit) ?? paragraph?.runs.find((item) => item.canEdit);
  const applyRun = (style: DocxRunFormat) => { if (!readOnly && run) onFormatRun(style, run.id); };
  const applyParagraph = (format: Extract<DocxOperation, { type: "format-paragraph" }>["format"]) => { if (!readOnly && paragraph) onApply([{ type: "format-paragraph", paragraphId: paragraph.id, format }]); };
  const selectedTable = document.tables.find((table) => table.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((item) => item.id === paragraph?.id))));
  useEffect(() => {
    const prior = globalThis.document.activeElement, root = dialog.current;
    (root?.querySelector<HTMLElement>('input:not(:disabled):not([type="file"]):not([type="hidden"])') ?? root?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    const key = (event: KeyboardEvent) => {
      if (!root?.contains(globalThis.document.activeElement) && !(event.target instanceof Node && root?.closest(".docs-word-host")?.contains(event.target))) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab" || !root) return;
      const controls = [...root.querySelectorAll<HTMLElement>('button,input,select,a[href],[tabindex="0"]')].filter((control) => !control.hasAttribute("disabled") && !control.closest("fieldset[disabled]") && !control.hidden && !(control instanceof HTMLInputElement && ["hidden", "file"].includes(control.type)));
      const first = controls[0], last = controls.at(-1), focused = globalThis.document.activeElement;
      if (event.shiftKey && (focused === first || !root.contains(focused))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (focused === last || !root.contains(focused))) { event.preventDefault(); first?.focus(); }
    };
    globalThis.document.addEventListener("keydown", key, true);
    return () => { globalThis.document.removeEventListener("keydown", key, true); if (prior instanceof HTMLElement && prior.isConnected && !prior.closest("[inert]")) prior.focus(); };
  }, [tool]);
  return <div className="docs-word-tools-overlay"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="docs-word-tools-dialog">
    <div className="docs-word-tools-heading"><h2 id={titleId}>{TITLES[tool]}</h2><button type="button" aria-label={`Close ${TITLES[tool]}`} onClick={onClose}>×</button></div>
    {!supported ? <p className="docs-tool-explanation">This tool is not supported for {document.format.toUpperCase()} documents. The original file format is preserved.</p> : <>
    {tool === "font" ? <fieldset className="docs-tool-group" disabled={readOnly || !run}><legend className="sr-only">Font formatting</legend><label className="docs-font-tool">Font<input key={`${run?.id}:${fontSelection.fontFamily}`} aria-label="Font family" defaultValue={fontSelection.fontFamily === "mixed" ? "" : fontSelection.fontFamily ?? ""} placeholder={fontSelection.fontFamily === "mixed" ? "Mixed fonts" : "Inherited font"} onBlur={(event) => { const value = event.target.value.trim(); if (value !== (fontSelection.fontFamily === "mixed" ? "" : fontSelection.fontFamily ?? "")) applyRun({ fontFamily: value || null }); }} /></label><NumberTool label="Font size" value={typeof fontSelection.fontSizePoints === "number" ? fontSelection.fontSizePoints : undefined} placeholder={fontSelection.fontSizePoints === "mixed" ? "Mixed" : "Auto"} min={1} max={400} step={.5} onChange={(fontSizePoints) => applyRun({ fontSizePoints })} /><label className="docs-color-tool">{selectionColor ? "Text color" : fontSelection.color === "mixed" ? "Mixed colors" : "Document color"}<input type="color" aria-label={selectionColor ? "Text color" : "Apply text color"} title={selectionColor ? "Selected text color" : "Choose a color to apply to the selection"} value={selectionColor ?? "#111111"} onChange={(event) => applyRun({ color: event.target.value.slice(1) })} /></label><button type="button" onClick={() => applyRun({ bold: null, italic: null, underline: null, color: null, fontFamily: null, fontSizePoints: null })}>Clear formatting</button></fieldset> : null}
    {tool === "picture" ? <fieldset className="docs-tool-group" disabled={readOnly}><legend className="sr-only">Pictures</legend><WordImagePicker disabled={readOnly || !!selectedTable} afterParagraphId={paragraph?.id} maximumWidthPoints={document.pageLayout.widthPoints - document.pageLayout.marginLeftPoints - document.pageLayout.marginRightPoints} maximumHeightPoints={document.pageLayout.heightPoints - document.pageLayout.marginTopPoints - document.pageLayout.marginBottomPoints} onInsert={(operation) => onApply([operation])} onError={onError} />{document.images.filter((image) => image.paragraphId === paragraph?.id).map((image) => <button key={image.id} type="button" onClick={() => onApply([{ type: "delete-image", imageId: image.id }])}>Remove picture</button>)}<span className="docs-tool-explanation">Local PNG/JPEG pictures only. Select a body paragraph to insert a picture.</span></fieldset> : null}
    {tool === "table" ? <fieldset className="docs-tool-group" disabled={readOnly}><legend className="sr-only">Tables</legend><label className="docs-number-tool">Rows<input type="number" aria-label="Table rows" min={1} max={20} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></label><label className="docs-number-tool">Columns<input type="number" aria-label="Table columns" min={1} max={10} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label><button type="button" disabled={!!selectedTable || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || rows > 20 || columns < 1 || columns > 10} onClick={() => onApply([{ type: "insert-table", afterParagraphId: paragraph?.id, rows, columns }])}>Insert table</button>{selectedTable ? <button type="button" onClick={() => onApply([{ type: "delete-table", tableId: selectedTable.id }])}>Remove table</button> : null}<span className="docs-tool-explanation">Select a body paragraph to insert a table.</span></fieldset> : null}
    {tool === "page" ? <fieldset className="docs-tool-group docs-page-setup" disabled={readOnly}><legend className="sr-only">Page setup</legend>
      <div className="docs-page-row"><span>Paper</span><div className="docs-segmented">{PAPERS.map((paper) => <button type="button" key={paper.id} aria-pressed={paperOf(document.pageLayout) === paper.id} title={paper.size} onClick={() => onApply([{ type: "set-page-layout", layout: { paper: paper.id } }])}>{paper.label}</button>)}</div><small>{inches(document.pageLayout.widthPoints)} × {inches(document.pageLayout.heightPoints)} in</small></div>
      <div className="docs-page-row"><span>Orientation</span><div className="docs-segmented">{(["portrait", "landscape"] as const).map((orientation) => <button type="button" key={orientation} aria-pressed={document.pageLayout.orientation === orientation} onClick={() => onApply([{ type: "set-page-layout", layout: { orientation } }])}>{orientation[0].toUpperCase() + orientation.slice(1)}</button>)}</div></div>
      <div className="docs-page-row"><span>Margins</span><div className="docs-page-margins">{(["Top", "Bottom", "Left", "Right"] as const).map((side) => { const key = `margin${side}Points` as const; return <NumberTool key={side} label={`${side} margin (in)`} caption={side} value={Math.round(document.pageLayout[key] / 72 * 100) / 100} min={0} max={4} step={.01} onChange={(inches) => onApply([{ type: "set-page-layout", layout: { [key]: inches * 72 } }])} />; })}</div><small>inches</small></div>
    </fieldset> : null}
    {tool === "spacing" ? <fieldset className="docs-tool-group docs-layout-tools" disabled={readOnly || !paragraph}><legend className="sr-only">Paragraph spacing</legend><NumberTool label="Space before (pt)" value={paragraph?.spacingBeforePoints ?? 0} onChange={(spacingBeforePoints) => applyParagraph({ spacingBeforePoints })} /><NumberTool label="Space after (pt)" value={paragraph?.spacingAfterPoints ?? 0} onChange={(spacingAfterPoints) => applyParagraph({ spacingAfterPoints })} />{[1, 1.5, 2].map((lineSpacingMultiple) => <button type="button" key={lineSpacingMultiple} aria-pressed={paragraph?.lineSpacingMultiple === lineSpacingMultiple} onClick={() => applyParagraph({ lineSpacingMultiple })}>{lineSpacingMultiple}× spacing</button>)}</fieldset> : null}
    {tool === "link" && document.format === "docx" ? <WordLinksAndBreaks document={document} paragraph={paragraph} runId={runId} disabled={readOnly || review.tracking || !!paragraph?.revisionIds.length} onApply={onApply} onAddLink={onAddLink} onInsertBreak={onInsertBreak} /> : null}
    {tool === "review" && document.format === "docx" ? <WordReviewTools document={document} paragraph={paragraph} readOnly={readOnly} onApply={onApply} review={review} /> : null}
    {tool === "find" ? <WordFindTools document={document} readOnly={readOnly || review.tracking || document.revisions.length > 0} onChange={onReplace} onSelect={(match) => { onSelectMatch(match); dialog.current?.querySelector<HTMLInputElement>('[aria-label="Find Word text"]')?.focus(); }} onError={onError} /> : null}
    </>}
  </div></div>;
}
