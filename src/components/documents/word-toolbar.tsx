import { useId, useRef, useState } from "react";
import type { DocxDocument, DocxOperation, DocxParagraph, DocxRunFormat } from "@/lib/office/docx";
import { WordImagePicker } from "./word-images";
import { WordFindTools } from "./word-find-tools";
import type { WordTextMatch } from "./word-find";
import { WordReviewTools, type WordReviewState } from "./word-review-tools";
import { WordLinksAndBreaks } from "./word-links-and-breaks";

const TABS = ["Home", "Insert", "Layout", "Review", "View"] as const;
type Tab = typeof TABS[number];
interface WordToolbarProps {
  document: DocxDocument;
  paragraph?: DocxParagraph;
  runId?: string;
  readOnly: boolean;
  onApply: (operations: readonly DocxOperation[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  pageView: boolean;
  outline: boolean;
  onZoom: (zoom: number) => void;
  onPageView: (pageView: boolean) => void;
  onOutline: () => void;
  onError: (message: string) => void;
  onReplace: (document: DocxDocument) => void;
  onSelectMatch: (match: WordTextMatch) => void;
  onFormatRun: (style: DocxRunFormat, runId: string) => void;
  review: WordReviewState;
  onAddLink: (target: string) => void;
  onInsertBreak: () => void;
}
function NumberTool({ label, value, min = 0, max = 500, step = 1, onChange }: { label: string; value?: number; min?: number; max?: number; step?: number; onChange: (value: number) => void }) {
  return <label className="docs-number-tool">{label}<input key={value} type="number" aria-label={label} defaultValue={value ?? ""} placeholder="Auto" min={min} max={max} step={step} onBlur={(event) => { const input = Number(event.target.value); if (event.target.value && Number.isFinite(input) && input >= min && input <= max && input !== value) onChange(input); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
export function WordToolbar({ document, paragraph, runId, readOnly: permissionReadOnly, onApply, onUndo, onRedo, canUndo, canRedo, zoom, pageView, outline, onZoom, onPageView, onOutline, onError, onReplace, onSelectMatch, onFormatRun, review, onAddLink, onInsertBreak }: WordToolbarProps) {
  const readOnly = permissionReadOnly || review.originalView;
  const [tab, setTab] = useState<Tab>("Home");
  const toolbarId = useId();
  const [rows, setRows] = useState(2), [columns, setColumns] = useState(2);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const run = paragraph?.runs.find((item) => item.id === runId && item.canEdit) ?? paragraph?.runs.find((item) => item.canEdit);
  const applyRun = (style: DocxRunFormat) => { if (run) onFormatRun(style, run.id); };
  const applyParagraph = (format: Extract<DocxOperation, { type: "format-paragraph" }>["format"]) => { if (paragraph) onApply([{ type: "format-paragraph", paragraphId: paragraph.id, format }]); };
  const heading = (styleId: string | null, size: number, bold: boolean) => {
    if (!paragraph) return;
    onApply([{ type: "format-paragraph", paragraphId: paragraph.id, format: { styleId } }, ...paragraph.runs.filter((item) => item.canEdit).map((item): DocxOperation => ({ type: "format-run", runId: item.id, style: { fontSizePoints: size, bold } }))]);
  };
  const selectedTable = document.tables.find((table) => table.rows.some((row) => row.cells.some((cell) => cell.paragraphs.some((item) => item.id === paragraph?.id))));
  return <div className="docs-word-toolbar">
    <div className="docs-word-tabs" role="tablist" aria-label="Word tools">{TABS.map((item, index) => <button type="button" key={item} ref={(node) => { tabButtons.current[index] = node; }} role="tab" id={`${toolbarId}-tab-${item}`} aria-controls={`${toolbarId}-panel-${item}`} aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} onClick={() => setTab(item)} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + TABS.length) % TABS.length;
      setTab(TABS[next]); tabButtons.current[next]?.focus();
    }}>{item}</button>)}</div>
    <div className="docs-word-tools-panel" role="tabpanel" id={`${toolbarId}-panel-${tab}`} aria-labelledby={`${toolbarId}-tab-${tab}`}>
      {tab === "Home" ? <>
        <div className="docs-tool-group"><button type="button" disabled={!canUndo || readOnly} onClick={onUndo}>Undo</button><button type="button" disabled={!canRedo || readOnly} onClick={onRedo}>Redo</button></div>
        <fieldset className="docs-tool-group" disabled={readOnly || !run}><legend className="sr-only">Run formatting</legend><button type="button" aria-label="Bold" aria-pressed={!!run?.style.bold} onClick={() => applyRun({ bold: !run?.style.bold })}><b>B</b></button><button type="button" aria-label="Italic" aria-pressed={!!run?.style.italic} onClick={() => applyRun({ italic: !run?.style.italic })}><i>I</i></button><button type="button" aria-label="Underline" aria-pressed={!!run?.style.underline && run.style.underline !== "none"} onClick={() => applyRun({ underline: run?.style.underline && run.style.underline !== "none" ? null : "single" })}><u>U</u></button>
          <label className="docs-font-tool">Font<input key={`${run?.id}:${run?.style.fontFamily}`} list={`${toolbarId}-fonts`} aria-label="Font family" defaultValue={run?.style.fontFamily ?? ""} placeholder="Inherited font" onBlur={(event) => { const value = event.target.value.trim(); if (value !== (run?.style.fontFamily ?? "")) applyRun({ fontFamily: value || null }); }} /><datalist id={`${toolbarId}-fonts`}><option value="Arial" /><option value="Calibri" /><option value="Georgia" /><option value="Times New Roman" /><option value="Helvetica" /></datalist></label>
          <NumberTool label="Font size" value={run?.style.fontSizePoints} min={1} max={400} step={.5} onChange={(fontSizePoints) => applyRun({ fontSizePoints })} />
          <label className="docs-color-tool">Text color<input type="color" aria-label="Text color" value={run?.style.color && /^[0-9a-f]{6}$/i.test(run.style.color) ? `#${run.style.color}` : "#111111"} onChange={(event) => applyRun({ color: event.target.value.slice(1) })} /></label>
          <button type="button" onClick={() => applyRun({ bold: null, italic: null, underline: null, color: null, fontFamily: null, fontSizePoints: null })}>Clear</button>
        </fieldset>
        <fieldset className="docs-tool-group" disabled={readOnly || !paragraph}><legend className="sr-only">Paragraph formatting</legend><button type="button" onClick={() => heading(null, 12, false)}>Normal</button><button type="button" onClick={() => heading("Heading1", 22, true)}>Heading 1</button><button type="button" onClick={() => heading("Heading2", 17, true)}>Heading 2</button><button type="button" aria-pressed={paragraph?.listKind === "bullet"} onClick={() => paragraph && onApply([{ type: "set-list", paragraphId: paragraph.id, kind: paragraph.listKind === "bullet" ? null : "bullet" }])}>Bullets</button><button type="button" aria-pressed={paragraph?.listKind === "numbered"} onClick={() => paragraph && onApply([{ type: "set-list", paragraphId: paragraph.id, kind: paragraph.listKind === "numbered" ? null : "numbered" }])}>Numbering</button>{(["left", "center", "right", "both"] as const).map((alignment) => <button type="button" key={alignment} aria-label={`Align ${alignment === "both" ? "justify" : alignment}`} aria-pressed={(paragraph?.alignment ?? "left") === alignment} onClick={() => applyParagraph({ alignment })}>{alignment === "both" ? "Justify" : alignment[0].toUpperCase() + alignment.slice(1)}</button>)}</fieldset>
        {review.originalView ? <span className="docs-tool-explanation">Switch to Final text to find or replace text.</span> : <WordFindTools document={document} readOnly={readOnly || review.tracking || document.revisions.length > 0} onChange={onReplace} onSelect={onSelectMatch} onError={onError} />}
      </> : null}
      {tab === "Insert" ? <fieldset className="docs-tool-group" disabled={readOnly}><legend className="sr-only">Insert content</legend><button type="button" onClick={() => onApply([{ type: "insert-paragraph", afterParagraphId: paragraph?.id, text: "" }])}>Paragraph</button><WordImagePicker disabled={readOnly || !!selectedTable} afterParagraphId={paragraph?.id} maximumWidthPoints={document.pageLayout.widthPoints - document.pageLayout.marginLeftPoints - document.pageLayout.marginRightPoints} maximumHeightPoints={document.pageLayout.heightPoints - document.pageLayout.marginTopPoints - document.pageLayout.marginBottomPoints} onInsert={(operation) => onApply([operation])} onError={onError} />{document.images.filter((image) => image.paragraphId === paragraph?.id).map((image) => <button key={image.id} type="button" onClick={() => onApply([{ type: "delete-image", imageId: image.id }])}>Remove picture</button>)}<label className="docs-number-tool">Rows<input type="number" aria-label="Table rows" min={1} max={20} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></label><label className="docs-number-tool">Columns<input type="number" aria-label="Table columns" min={1} max={10} value={columns} onChange={(event) => setColumns(Number(event.target.value))} /></label><button type="button" disabled={!!selectedTable || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || rows > 20 || columns < 1 || columns > 10} onClick={() => onApply([{ type: "insert-table", afterParagraphId: paragraph?.id, rows, columns }])}>Insert table</button>{selectedTable ? <button type="button" onClick={() => onApply([{ type: "delete-table", tableId: selectedTable.id }])}>Remove table</button> : null}<span className="docs-tool-explanation">Local PNG/JPEG pictures only. Select a body paragraph to insert a picture or table.</span></fieldset> : null}
      {tab === "Layout" ? <fieldset className="docs-tool-group docs-layout-tools" disabled={readOnly}><legend className="sr-only">Page layout</legend>{(["letter", "a4", "legal"] as const).map((paper) => <button type="button" key={paper} onClick={() => onApply([{ type: "set-page-layout", layout: { paper } }])}>{paper === "a4" ? "A4" : paper[0].toUpperCase() + paper.slice(1)}</button>)}{(["portrait", "landscape"] as const).map((orientation) => <button type="button" key={orientation} aria-pressed={document.pageLayout.orientation === orientation} onClick={() => onApply([{ type: "set-page-layout", layout: { orientation } }])}>{orientation[0].toUpperCase() + orientation.slice(1)}</button>)}{(["Top", "Right", "Bottom", "Left"] as const).map((side) => {
        const key = `margin${side}Points` as const;
        return <NumberTool key={side} label={`${side} margin (in)`} value={document.pageLayout[key] / 72} min={0} max={4} step={.1} onChange={(inches) => onApply([{ type: "set-page-layout", layout: { [key]: inches * 72 } }])} />;
      })}<NumberTool label="Space before (pt)" value={paragraph?.spacingBeforePoints ?? 0} onChange={(spacingBeforePoints) => applyParagraph({ spacingBeforePoints })} /><NumberTool label="Space after (pt)" value={paragraph?.spacingAfterPoints ?? 0} onChange={(spacingAfterPoints) => applyParagraph({ spacingAfterPoints })} />{[1, 1.5, 2].map((lineSpacingMultiple) => <button type="button" key={lineSpacingMultiple} aria-pressed={paragraph?.lineSpacingMultiple === lineSpacingMultiple} onClick={() => applyParagraph({ lineSpacingMultiple })}>{lineSpacingMultiple}× spacing</button>)}</fieldset> : null}
      {tab === "Insert" ? <WordLinksAndBreaks document={document} paragraph={paragraph} runId={runId} disabled={readOnly || review.tracking || !!paragraph?.revisionIds.length} onApply={onApply} onAddLink={onAddLink} onInsertBreak={onInsertBreak} /> : null}
      {tab === "Review" ? <WordReviewTools document={document} paragraph={paragraph} readOnly={permissionReadOnly} onApply={onApply} review={review} /> : null}
      {tab === "View" ? <div className="docs-tool-group"><button type="button" aria-pressed={pageView} onClick={() => onPageView(true)}>Page</button><button type="button" aria-pressed={!pageView} onClick={() => onPageView(false)}>Continuous</button><button type="button" aria-pressed={outline} onClick={onOutline}>Outline</button><button type="button" aria-label="Zoom out" onClick={() => onZoom(Math.max(50, zoom - 10))}>−</button><span>{zoom}%</span><button type="button" aria-label="Zoom in" onClick={() => onZoom(Math.min(200, zoom + 10))}>＋</button><button type="button" onClick={() => onZoom(100)}>100%</button><span className="docs-tool-explanation">Zoom changes the view, not your document. Page layout is a preview, not exact Word pagination.</span></div> : null}
    </div>
  </div>;
}
