// The table a CSV or TSV file opens in, everywhere Markie shows one: the
// desktop editor and documents workspace, the hosted read view and the phone.
//
// The file stays the file. Every edit goes through the lossless model in
// src/lib/csv-table.ts, which rewrites only the cells that changed; sorting
// and filtering reorder what is shown and never touch the text.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  cellValue, cellsToText, clipboardToCells, columnLetter, decodeField, deleteColumns, deleteRows, firstRowIsHeader,
  insertColumn, insertRow, numericColumns, parseCsvDocument, parseNumber, serializeCsvDocument, setCells, viewRows,
  type CsvDocument, type CsvSort,
} from "@/lib/csv-table";
import "./csv-table.css";

export interface CsvTableProps {
  /** The file's text, exactly as it is on disk. */
  text: string;
  /** The file's name: a `.tsv` name reads tabs first. */
  name?: string;
  /** No edits. The hosted view and the phone are always read-only. */
  readOnly?: boolean;
  /** The whole file after an edit, byte for byte the old one outside the cells that changed. */
  onChange?: (text: string) => void;
  /** The host's own editor for the raw file, shown under "Text". Without one the text is shown as it is. */
  renderText?: () => ReactNode;
  /** Phone sizing: taller rows, larger type, a shorter toolbar. */
  compact?: boolean;
  className?: string;
  /** Scales the grid, as the document zoom does elsewhere. */
  zoom?: number;
  /** Which of the two is showing, for a host that needs to say (its Find works on the text). Table when left alone. */
  view?: CsvView;
  onViewChange?: (view: CsvView) => void;
}

export type CsvView = "table" | "text";

interface Cell { row: number; col: number }
interface Editing extends Cell { value: string; selectAll: boolean }

const HEADER = -1;
const OVERSCAN = 8;
const HISTORY = 100;
// One element can only be so tall; past this the table shows the first rows.
const MAX_SHOWN_ROWS = 500_000;
const DELIMITER_NAMES: Record<string, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" };

type Measure = (text: string) => number;
const estimate: Measure = (text) => text.length * 7.2;

function canvasMeasure(font: string): Measure | null {
  // jsdom has no canvas and says so loudly; the estimate is fine there.
  if (typeof document === "undefined" || /jsdom/i.test(navigator.userAgent)) return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = font;
  return (text) => context.measureText(text).width;
}

/** Each column as wide as its content, within reason, from the header and the first rows. */
function contentWidths(doc: CsvDocument, measure: Measure, min: number, max: number): number[] {
  const widths = new Array<number>(doc.columnCount).fill(min);
  const end = Math.min(doc.rows.length, 200);
  for (let r = 0; r < end; r++) {
    const row = doc.rows[r];
    for (let c = 0; c < row.length; c++) {
      if (widths[c] >= max) continue;
      const value = decodeField(row[c]);
      const width = Math.ceil(measure(value.length > 80 ? value.slice(0, 80) : value)) + (r === 0 ? 46 : 26);
      if (width > widths[c]) widths[c] = Math.min(max, width);
    }
  }
  return widths;
}

function writeClipboard(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function CsvTable({ text, name, readOnly = false, onChange, renderText, compact = false, className, zoom = 1, view: hostView, onViewChange }: CsvTableProps) {
  const editable = !readOnly && !!onChange;
  const [ownView, setOwnView] = useState<CsvView>("table");
  const view = hostView ?? ownView;
  const setView = (next: CsvView) => { setOwnView(next); onViewChange?.(next); };
  // The document after our own last edit, so typing a cell does not reparse the file.
  // `from` is the text it was made from: a host that takes a moment to hand the
  // new text back is still showing this document.
  const [own, setOwn] = useState<{ text: string; from: string; doc: CsvDocument } | null>(null);
  const doc = useMemo(() => (own && (own.text === text || own.from === text) ? own.doc : parseCsvDocument(text, { name })), [text, name, own]);
  // Bumped when the rows themselves change (a new file, a row added or removed, undo),
  // which is when the view order and the content widths are worked out again.
  const [structure, setStructure] = useState(0);
  const history = useRef<{ past: CsvDocument[]; future: CsvDocument[] }>({ past: [], future: [] });
  const [, setHistoryTick] = useState(0);
  const lastText = useRef(text);
  useEffect(() => {
    if (lastText.current === text) return;
    lastText.current = text;
    if (own && (own.text === text || own.from === text)) return;
    // Someone else changed the text: the host's undo, the Text view, the disk.
    history.current = { past: [], future: [] };
    setOwn(null);
    setStructure((n) => n + 1);
  }, [text, own]);

  const [headerChoice, setHeaderChoice] = useState<boolean | null>(null);
  const [headerGuess] = useState(() => firstRowIsHeader(doc));
  const headerOn = (headerChoice ?? headerGuess) && doc.rows.length > 0;
  const firstRow = headerOn ? 1 : 0;

  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const [sort, setSort] = useState<CsvSort | null>(null);
  const numeric = useMemo(() => numericColumns(doc, firstRow), [doc, firstRow]);
  const allRows = useMemo(
    () => viewRows(doc, firstRow, deferredFilter, sort, numeric),
    // A cell edit keeps the order it was typed in; see `structure` above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, doc.rows.length, firstRow, deferredFilter, sort],
  );
  const order = allRows.length > MAX_SHOWN_ROWS ? allRows.slice(0, MAX_SHOWN_ROWS) : allRows;
  const bodyRows = doc.rows.length - firstRow;
  const columns = Math.max(doc.columnCount, 1);

  // ---- sizes
  const rowHeight = Math.round((compact ? 38 : 30) * zoom);
  const fontSize = Math.round((compact ? 15 : 13) * zoom * 10) / 10;
  const scroller = useRef<HTMLDivElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const made = canvasMeasure(getComputedStyle(element).font);
    if (made) setMeasure(() => made);
  }, [view, fontSize]);
  const autoWidths = useMemo(
    () => contentWidths(doc, measure ?? ((value) => estimate(value) * zoom), (compact ? 72 : 64) * zoom, (compact ? 240 : 340) * zoom),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, doc.columnCount, measure, compact, zoom],
  );
  const [resized, setResized] = useState<Record<number, number>>({});
  const widths = useMemo(() => Array.from({ length: columns }, (_unused, c) => resized[c] ?? autoWidths[c] ?? 96), [columns, resized, autoWidths]);
  const gutter = Math.max(compact ? 40 : 44, 20 + String(doc.rows.length).length * 8);
  const template = `${gutter}px ${widths.map((width) => `${width}px`).join(" ")}`;
  const totalWidth = gutter + widths.reduce((sum, width) => sum + width, 0);

  // ---- the window of rows on screen
  const [range, setRange] = useState({ first: 0, visible: 40 });
  const readWindow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const first = Math.floor(element.scrollTop / rowHeight);
    const visible = Math.ceil((element.clientHeight || 600) / rowHeight) + 1;
    setRange((current) => (current.first === first && current.visible === visible ? current : { first, visible }));
  }, [rowHeight]);
  useLayoutEffect(() => {
    readWindow();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(readWindow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [readWindow, view]);
  const from = Math.max(0, Math.min(range.first, order.length) - OVERSCAN);
  const to = Math.min(order.length, range.first + range.visible + OVERSCAN);

  // ---- cursor and selection
  const [cursor, setCursor] = useState<Cell | null>(null);
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const minRow = headerOn ? HEADER : 0;
  const maxRow = order.length - 1;
  const selection = useMemo(() => {
    if (!cursor) return null;
    const other = anchor ?? cursor;
    return { top: Math.min(cursor.row, other.row), bottom: Math.max(cursor.row, other.row), left: Math.min(cursor.col, other.col), right: Math.max(cursor.col, other.col) };
  }, [cursor, anchor]);
  /** The row in the file behind a row on screen. */
  const fileRow = useCallback((row: number) => (row === HEADER ? 0 : order[row]), [order]);

  const reveal = useCallback((cell: Cell) => {
    const element = scroller.current;
    if (!element) return;
    if (cell.row !== HEADER) {
      const top = cell.row * rowHeight, headerHeight = rowHeight + 2;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight - headerHeight) element.scrollTop = top + rowHeight - element.clientHeight + headerHeight;
    }
    let left = gutter;
    for (let c = 0; c < cell.col; c++) left += widths[c];
    if (left - gutter < element.scrollLeft) element.scrollLeft = left - gutter;
    else if (left + widths[cell.col] > element.scrollLeft + element.clientWidth) element.scrollLeft = left + widths[cell.col] - element.clientWidth;
  }, [rowHeight, gutter, widths]);

  const moveTo = useCallback((row: number, col: number, extend = false) => {
    if (maxRow < minRow) return;
    const next = { row: Math.max(minRow, Math.min(maxRow, row)), col: Math.max(0, Math.min(columns - 1, col)) };
    setCursor(next);
    setAnchor((current) => (extend ? current ?? cursor ?? next : next));
    reveal(next);
  }, [minRow, maxRow, columns, cursor, reveal]);

  // ---- edits
  const commit = useCallback((next: CsvDocument, rowsChanged = false) => {
    if (next === doc || !onChange) return;
    const past = history.current.past;
    past.push(doc);
    if (past.length > HISTORY) past.shift();
    history.current.future = [];
    const nextText = serializeCsvDocument(next);
    lastText.current = nextText;
    setOwn({ text: nextText, from: text, doc: next });
    if (rowsChanged) setStructure((n) => n + 1);
    setHistoryTick((n) => n + 1);
    onChange(nextText);
  }, [doc, onChange, text]);
  const travel = useCallback((back: boolean) => {
    const { past, future } = history.current;
    const next = back ? past.pop() : future.pop();
    if (!next || !onChange) return;
    (back ? future : past).push(doc);
    const nextText = serializeCsvDocument(next);
    lastText.current = nextText;
    setOwn({ text: nextText, from: text, doc: next });
    setStructure((n) => n + 1);
    setHistoryTick((n) => n + 1);
    onChange(nextText);
  }, [doc, onChange, text]);

  const focusGrid = () => scroller.current?.focus({ preventScroll: true });
  const startEditing = useCallback((cell: Cell, typed?: string) => {
    if (!editable) return;
    setEditing({ ...cell, value: typed ?? cellValue(doc, fileRow(cell.row), cell.col), selectAll: typed === undefined });
  }, [editable, doc, fileRow]);
  const finishEditing = useCallback((save: boolean, then?: Cell, refocus = true) => {
    if (!editing) return;
    if (save) commit(setCells(doc, [{ row: fileRow(editing.row), column: editing.col, value: editing.value }]));
    setEditing(null);
    if (then) moveTo(then.row, then.col);
    // A click somewhere else already took the focus where it was going.
    if (refocus) focusGrid();
  }, [editing, commit, doc, fileRow, moveTo]);

  const selectedFileRows = useCallback(() => {
    if (!selection) return [];
    const rows: number[] = [];
    for (let row = selection.top; row <= selection.bottom; row++) rows.push(fileRow(row));
    return rows;
  }, [selection, fileRow]);
  const selectedColumns = useCallback(() => {
    if (!selection) return [];
    return Array.from({ length: selection.right - selection.left + 1 }, (_unused, index) => selection.left + index);
  }, [selection]);
  const copyAs = useCallback((delimiter: "\t" | ",") => cellsToText(doc, selectedFileRows(), selectedColumns(), delimiter), [doc, selectedFileRows, selectedColumns]);
  /** What ⌘C puts on the clipboard: one cell as its own text, a block as tab-separated rows. */
  const copyText = useCallback(() => {
    if (!selection || !cursor) return "";
    if (selection.top === selection.bottom && selection.left === selection.right) return cellValue(doc, fileRow(cursor.row), cursor.col);
    return copyAs("\t");
  }, [selection, cursor, doc, fileRow, copyAs]);
  const clearSelection = useCallback(() => {
    if (!editable || !selection) return;
    const edits = selectedFileRows().flatMap((row) => selectedColumns().map((column) => ({ row, column, value: "" })));
    commit(setCells(doc, edits.filter((edit) => doc.rows[edit.row]?.[edit.column] !== undefined)));
  }, [editable, selection, selectedFileRows, selectedColumns, commit, doc]);
  const paste = useCallback((pasted: string) => {
    if (!editable || !cursor || !selection) return;
    const block = clipboardToCells(pasted);
    const edits: { row: number; column: number; value: string }[] = [];
    block.forEach((cells, r) => {
      const row = selection.top + r;
      if (row > maxRow) return;
      cells.forEach((value, c) => { if (selection.left + c < columns) edits.push({ row: fileRow(row), column: selection.left + c, value }); });
    });
    commit(setCells(doc, edits));
  }, [editable, cursor, selection, maxRow, columns, fileRow, commit, doc]);

  const addRow = () => {
    const at = !selection || order.length === 0 ? doc.rows.length : selection.bottom === HEADER ? 1 : fileRow(selection.bottom) + 1;
    // The new row is empty, so a filter would hide it and a sort would move it.
    setFilter("");
    setSort(null);
    commit(insertRow(doc, at), true);
    const next = { row: Math.max(0, at - firstRow), col: cursor?.col ?? 0 };
    setCursor(next);
    setAnchor(next);
    requestAnimationFrame(() => reveal(next));
  };
  const addColumn = (right: boolean) => {
    const at = cursor ? (right ? selection!.right + 1 : selection!.left) : doc.columnCount;
    setResized({});
    commit(doc.rows.length === 0 ? insertRow(doc, 0, [""]) : insertColumn(doc, at), doc.rows.length === 0);
  };
  const removeRows = () => {
    if (!selection) return;
    const rows = selectedFileRows();
    commit(deleteRows(doc, rows), true);
    setAnchor(null);
    setCursor((current) => (current ? { row: Math.max(minRow, Math.min(selection.top, maxRow - rows.length)), col: current.col } : current));
  };
  const removeColumns = () => {
    if (!selection) return;
    const dropped = selectedColumns();
    setResized({});
    setSort(null);
    commit(deleteColumns(doc, dropped));
    setAnchor(null);
    setCursor((current) => (current ? { row: current.row, col: Math.max(0, Math.min(selection.left, columns - dropped.length - 1)) } : current));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== event.currentTarget) return;
    const mod = event.metaKey || event.ctrlKey;
    const at = cursor ?? { row: minRow, col: 0 };
    const page = Math.max(1, range.visible - 3);
    const go = (row: number, col: number) => { event.preventDefault(); moveTo(row, col, event.shiftKey); };
    switch (event.key) {
      case "ArrowDown": return go(mod ? maxRow : at.row + 1, at.col);
      case "ArrowUp": return go(mod ? minRow : at.row - 1, at.col);
      case "ArrowRight": return go(at.row, mod ? columns - 1 : at.col + 1);
      case "ArrowLeft": return go(at.row, mod ? 0 : at.col - 1);
      case "PageDown": return go(at.row + page, at.col);
      case "PageUp": return go(Math.max(0, at.row - page), at.col);
      case "Home": return go(mod ? minRow : at.row, 0);
      case "End": return go(mod ? maxRow : at.row, columns - 1);
      case "Tab": {
        // Tab walks the row, then the next one; at either end it leaves the table.
        const col = at.col + (event.shiftKey ? -1 : 1);
        if (col >= 0 && col < columns) { event.preventDefault(); moveTo(at.row, col); }
        else if (!event.shiftKey && at.row < maxRow) { event.preventDefault(); moveTo(at.row + 1, 0); }
        else if (event.shiftKey && at.row > minRow) { event.preventDefault(); moveTo(at.row - 1, columns - 1); }
        return;
      }
      case "Enter":
      case "F2":
        if (cursor && editable) { event.preventDefault(); startEditing(cursor); }
        return;
      case "Escape":
        if (anchor && cursor && (anchor.row !== cursor.row || anchor.col !== cursor.col)) { event.preventDefault(); setAnchor(cursor); }
        return;
      case "Delete":
      case "Backspace":
        if (editable && cursor) { event.preventDefault(); clearSelection(); }
        return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (maxRow >= minRow) { setAnchor({ row: minRow, col: 0 }); setCursor({ row: maxRow, col: columns - 1 }); }
    } else if (mod && event.key.toLowerCase() === "z" && editable) {
      event.preventDefault();
      event.stopPropagation();
      travel(!event.shiftKey);
    } else if (mod && event.key.toLowerCase() === "y" && editable) {
      event.preventDefault();
      travel(false);
    } else if (!mod && !event.altKey && event.key.length === 1 && cursor && editable) {
      event.preventDefault();
      startEditing(cursor, event.key);
    }
  };
  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selection) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copyText());
  };
  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selection || !editable) return;
    onCopy(event);
    clearSelection();
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !editable) return;
    event.preventDefault();
    paste(event.clipboardData.getData("text/plain"));
  };

  // ---- pointer
  const dragging = useRef(false);
  const pick = (event: ReactMouseEvent, cell: Cell) => {
    if (event.button !== 0) return;
    // An open editor saves itself as the click takes its focus.
    setCursor(cell);
    setAnchor((current) => (event.shiftKey ? current ?? cursor ?? cell : cell));
    dragging.current = true;
    const stop = () => { dragging.current = false; window.removeEventListener("mouseup", stop); };
    window.addEventListener("mouseup", stop);
  };
  const extendTo = (cell: Cell) => { if (dragging.current) setCursor(cell); };
  const pickRow = (event: ReactMouseEvent, row: number) => {
    if (event.button !== 0) return;
    setAnchor(event.shiftKey && anchor ? { row: anchor.row, col: 0 } : { row, col: 0 });
    setCursor({ row, col: columns - 1 });
  };
  // A double click renames a header; its first click must not also leave a sort behind.
  const sortBeforeClick = useRef<CsvSort | null>(null);
  const toggleSort = (column: number, clicks: number) => {
    if (clicks > 1) return;
    sortBeforeClick.current = sort;
    setSort((current) => (current?.column !== column ? { column, direction: "asc" } : current.direction === "asc" ? { column, direction: "desc" } : null));
  };
  const resize = (event: ReactPointerEvent<HTMLSpanElement>, column: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX, startWidth = widths[column];
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moved: PointerEvent) => setResized((current) => ({ ...current, [column]: Math.max(40, Math.round(startWidth + moved.clientX - startX)) }));
    const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };
  // The rows are memoized, so what they call must not change between renders.
  const live = useRef({ pick, extendTo, pickRow, startEditing });
  live.current = { pick, extendTo, pickRow, startEditing };
  const rowPick = useCallback((event: ReactMouseEvent, cell: Cell) => live.current.pick(event, cell), []);
  const rowExtend = useCallback((cell: Cell) => live.current.extendTo(cell), []);
  const rowPickRow = useCallback((event: ReactMouseEvent, row: number) => live.current.pickRow(event, row), []);
  const rowEdit = useCallback((cell: Cell) => live.current.startEditing(cell), []);
  const fitColumn = (column: number) => setResized((current) => { const next = { ...current }; delete next[column]; return next; });

  // ---- the status line
  const status = useMemo(() => {
    if (!cursor || !selection || maxRow < minRow) return null;
    const single = selection.top === selection.bottom && selection.left === selection.right;
    const row = fileRow(cursor.row);
    const label = `${columnLetter(cursor.col)}${row + 1}`;
    if (single) return { label, value: cellValue(doc, row, cursor.col), detail: "" };
    const cells = (selection.bottom - selection.top + 1) * (selection.right - selection.left + 1);
    let detail = "";
    if (cells <= 20_000) {
      let sum = 0, numbers = 0;
      for (let r = selection.top; r <= selection.bottom; r++) for (let c = selection.left; c <= selection.right; c++) {
        const number = parseNumber(cellValue(doc, fileRow(r), c), doc.delimiter === ";");
        if (number !== null) { sum += number; numbers++; }
      }
      if (numbers > 1) detail = `Sum ${Number(sum.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
    }
    return { label, value: `${count(cells, "cell")} selected`, detail };
  }, [cursor, selection, doc, fileRow, maxRow, minRow]);

  const filtered = deferredFilter.trim() !== "";
  const summary = filtered
    ? `${order.length.toLocaleString("en-US")} of ${count(bodyRows, "row")}`
    : `${count(Math.max(bodyRows, 0), "row")} × ${count(doc.columnCount, "column")}`;
  const headerLabel = (column: number) => (headerOn ? cellValue(doc, 0, column) : columnLetter(column));
  const inSelection = (row: number, col: number) => !!selection && row >= selection.top && row <= selection.bottom && col >= selection.left && col <= selection.right;
  const editor = (cell: Cell) => editing && editing.row === cell.row && editing.col === cell.col ? (
    <CellEditor
      value={editing.value}
      selectAll={editing.selectAll}
      onValue={(value) => setEditing((current) => (current ? { ...current, value } : current))}
      onDone={(save, direction, refocus) => finishEditing(save, direction === "down" ? { row: Math.min(maxRow, cell.row + 1), col: cell.col }
        : direction === "right" ? { row: cell.row, col: Math.min(columns - 1, cell.col + 1) }
        : direction === "left" ? { row: cell.row, col: Math.max(0, cell.col - 1) } : undefined, refocus)}
    />
  ) : null;

  return (
    <div className={`csv-table${compact ? " csv-table--compact" : ""}${className ? ` ${className}` : ""}`} data-csv-table data-csv-view={view} data-csv-delimiter={DELIMITER_NAMES[doc.delimiter]}>
      <div className="csv-table-bar" role="toolbar" aria-label="Table">
        <div className="csv-table-switch" role="group" aria-label="Show the file as">
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>Table</button>
          <button type="button" aria-pressed={view === "text"} onClick={() => setView("text")}>Text</button>
        </div>
        {view === "table" ? <>
          <label className="csv-table-filter">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input type="search" aria-label="Filter rows" placeholder="Filter rows" value={filter} onChange={(event) => { setFilter(event.target.value); if (scroller.current) scroller.current.scrollTop = 0; }} />
          </label>
          <label className="csv-table-check" title="Use the first row as the column names">
            <input type="checkbox" checked={headerOn} disabled={doc.rows.length === 0} onChange={(event) => { setHeaderChoice(event.target.checked); setCursor(null); setAnchor(null); }} />
            Header row
          </label>
          {editable ? <div className="csv-table-actions" role="group" aria-label="Rows and columns">
            <button type="button" onClick={addRow} title="Add a row below the selection">+ Row</button>
            <button type="button" onClick={() => addColumn(true)} title="Add a column to the right of the selection">+ Column</button>
            <button type="button" disabled={!cursor || cursor.row === HEADER || order.length === 0} onClick={removeRows} title="Delete the selected rows">Delete row</button>
            <button type="button" disabled={!cursor || doc.columnCount === 0} onClick={removeColumns} title="Delete the selected columns">Delete column</button>
          </div> : null}
          {!compact && cursor ? <div className="csv-table-actions" role="group" aria-label="Copy">
            <button type="button" onClick={() => writeClipboard(copyAs(","))} title="Copy the selection as comma-separated text">Copy CSV</button>
            <button type="button" onClick={() => writeClipboard(copyAs("\t"))} title="Copy the selection as tab-separated text">Copy TSV</button>
          </div> : null}
        </> : null}
        <span className="csv-table-summary" role="status">{summary}</span>
      </div>

      {view === "text" ? (
        <div className="csv-table-text-host">{renderText ? renderText() : <pre className="csv-table-text" tabIndex={0}>{text}</pre>}</div>
      ) : (
        <div
          ref={scroller}
          className="csv-table-scroll"
          role="grid"
          aria-label={name ? `${name} table` : "Table"}
          aria-rowcount={order.length + 1}
          aria-colcount={columns}
          aria-readonly={!editable}
          tabIndex={0}
          style={{ ["--csv-cols" as string]: template, ["--csv-row" as string]: `${rowHeight}px`, fontSize }}
          onScroll={readWindow}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          onFocus={(event) => { if (event.target === event.currentTarget && maxRow >= 0) { setCursor((current) => current ?? { row: 0, col: 0 }); setAnchor((current) => current ?? { row: 0, col: 0 }); } }}
        >
          <div className="csv-table-head" role="row" aria-rowindex={1} style={{ width: totalWidth }}>
            <div className="csv-table-corner" role="presentation" />
            {widths.map((_width, column) => {
              const sorted = sort?.column === column ? sort.direction : null;
              const active = headerOn && cursor?.row === HEADER && cursor.col === column;
              const label = headerLabel(column);
              return (
                <div
                  key={column}
                  role="columnheader"
                  aria-colindex={column + 1}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  className={`csv-table-th${numeric[column] ? " is-number" : ""}${headerOn && inSelection(HEADER, column) ? " is-selected" : ""}${active ? " is-cursor" : ""}${editing?.row === HEADER && editing.col === column ? " is-editing" : ""}`}
                  onDoubleClick={headerOn && editable ? () => { setSort(sortBeforeClick.current); setCursor({ row: HEADER, col: column }); setAnchor({ row: HEADER, col: column }); startEditing({ row: HEADER, col: column }); } : undefined}
                >
                  <button type="button" className="csv-table-sort" tabIndex={-1} title={label ? `${label}: click to sort` : "Click to sort"} onClick={(event) => { toggleSort(column, event.detail); focusGrid(); }}>
                    <span className="csv-table-th-label">{label || " "}</span>
                    <span className="csv-table-sort-mark" aria-hidden="true">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                  </button>
                  <span className="csv-table-resize" role="separator" aria-orientation="vertical" aria-label={`Resize column ${columnLetter(column)}`} onPointerDown={(event) => resize(event, column)} onDoubleClick={(event) => { event.stopPropagation(); fitColumn(column); }} />
                  {editor({ row: HEADER, col: column })}
                </div>
              );
            })}
          </div>
          <div className="csv-table-body" style={{ height: order.length * rowHeight, width: totalWidth }}>
            {order.slice(from, to).map((rowIndex, offset) => {
              const row = from + offset;
              const selected = !!selection && row >= selection.top && row <= selection.bottom;
              return (
                <Row
                  key={rowIndex}
                  cells={doc.rows[rowIndex]}
                  fileRow={rowIndex}
                  row={row}
                  top={row * rowHeight}
                  columns={columns}
                  widths={widths}
                  numeric={numeric}
                  left={selected ? selection.left : -1}
                  right={selected ? selection.right : -1}
                  cursorCol={cursor?.row === row ? cursor.col : -1}
                  editor={editing?.row === row ? editor({ row, col: editing.col }) : null}
                  editingCol={editing?.row === row ? editing.col : -1}
                  onPick={rowPick}
                  onExtend={rowExtend}
                  onPickRow={rowPickRow}
                  onEdit={editable ? rowEdit : undefined}
                />
              );
            })}
          </div>
          {order.length === 0 ? <p className="csv-table-empty">{doc.rows.length === 0 ? "This file is empty." : filtered ? "No rows match the filter." : "No rows yet."}</p> : null}
        </div>
      )}

      {view === "table" ? <div className="csv-table-status">
        {status ? <>
          <span className="csv-table-ref">{status.label}</span>
          <span className="csv-table-value" title={status.value}>{status.value}</span>
          {status.detail ? <span className="csv-table-detail">{status.detail}</span> : null}
        </> : <span className="csv-table-value csv-table-hint">{editable ? "Select a cell. Enter edits it, Escape cancels." : "Select a cell to read all of it."}</span>}
        {allRows.length > MAX_SHOWN_ROWS ? <span className="csv-table-detail">Showing the first {MAX_SHOWN_ROWS.toLocaleString("en-US")} rows</span> : null}
        <span className="csv-table-detail">{DELIMITER_NAMES[doc.delimiter]}{sort || filtered ? " · view only, the file keeps its order" : ""}</span>
      </div> : null}
    </div>
  );
}

interface RowProps {
  cells: readonly string[];
  fileRow: number;
  row: number;
  top: number;
  columns: number;
  widths: readonly number[];
  numeric: readonly boolean[];
  left: number;
  right: number;
  cursorCol: number;
  editingCol: number;
  editor: ReactNode;
  onPick: (event: ReactMouseEvent, cell: Cell) => void;
  onExtend: (cell: Cell) => void;
  onPickRow: (event: ReactMouseEvent, row: number) => void;
  onEdit?: (cell: Cell) => void;
}

const Row = memo(function Row({ cells, fileRow, row, top, columns, widths, numeric, left, right, cursorCol, editingCol, editor, onPick, onExtend, onPickRow, onEdit }: RowProps) {
  const out: ReactNode[] = [];
  for (let col = 0; col < columns; col++) {
    const raw = cells[col];
    const value = raw === undefined ? "" : decodeField(raw);
    const long = value.length * 7 > widths[col] - 20;
    out.push(
      <div
        key={col}
        role="gridcell"
        aria-colindex={col + 1}
        aria-selected={col >= left && col <= right}
        className={`csv-table-cell${numeric[col] ? " is-number" : ""}${col >= left && col <= right ? " is-selected" : ""}${col === cursorCol ? " is-cursor" : ""}${raw === undefined ? " is-missing" : ""}${col === editingCol ? " is-editing" : ""}`}
        title={long ? value : undefined}
        onMouseDown={(event) => onPick(event, { row, col })}
        onMouseEnter={() => onExtend({ row, col })}
        onDoubleClick={onEdit ? () => onEdit({ row, col }) : undefined}
      >
        {col === editingCol ? editor : value}
      </div>,
    );
  }
  return (
    <div className={`csv-table-row${row % 2 ? " is-odd" : ""}${editingCol >= 0 ? " is-editing" : ""}`} role="row" aria-rowindex={row + 2} style={{ top }}>
      {/* The number is the row's line in the file, so it still names the row when sorted. */}
      <div className={`csv-table-num${left >= 0 ? " is-selected" : ""}`} role="rowheader" onMouseDown={(event) => onPickRow(event, row)}>{fileRow + 1}</div>
      {out}
    </div>
  );
});

function CellEditor({ value, selectAll, onValue, onDone }: { value: string; selectAll: boolean; onValue: (value: string) => void; onDone: (save: boolean, direction: "down" | "right" | "left" | undefined, refocus: boolean) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (selectAll) element.select();
    else element.setSelectionRange(element.value.length, element.value.length);
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = (save: boolean, direction?: "down" | "right" | "left", refocus = true) => {
    if (done.current) return;
    done.current = true;
    onDone(save, direction, refocus);
  };
  return (
    <textarea
      ref={field}
      className="csv-table-editor"
      aria-label="Edit cell"
      rows={Math.min(8, value.split("\n").length)}
      value={value}
      spellCheck={false}
      onChange={(event) => onValue(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true, undefined, false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); finish(false); }
        else if (event.key === "Enter" && !event.altKey && !event.shiftKey) { event.preventDefault(); finish(true, "down"); }
        else if (event.key === "Enter" && event.altKey) {
          // Option+Enter is a line break inside the cell.
          event.preventDefault();
          const element = event.currentTarget, start = element.selectionStart, end = element.selectionEnd;
          onValue(value.slice(0, start) + "\n" + value.slice(end));
          requestAnimationFrame(() => element.setSelectionRange(start + 1, start + 1));
        } else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? "left" : "right"); }
      }}
    />
  );
}
