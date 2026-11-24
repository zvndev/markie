// The sheet a CSV or TSV file opens in, everywhere Markie shows one: the
// desktop editor and documents workspace, the hosted read view and the phone.
//
// It is drawn as a spreadsheet: a strip of column letters and a gutter of row
// numbers, a name box and formula bar, a frozen header row, gridlines on every
// cell, empty cells out to the edges of the window, and a sheet tab below.
//
// The file stays the file. Every edit goes through the lossless model in
// src/lib/csv-table.ts, which rewrites only the cells that changed; sorting,
// filtering and the way a number, a date or a link is drawn change what is
// shown and never touch the text.
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  cellReference, cellValue, cellsToText, clipboardToCells, columnLetter, decodeField, deleteColumns, deleteRows, firstRowIsHeader, formatCell,
  insertColumn, insertRow, numericColumns, parseCellReference, parseCsvDocument, rangeStats, serializeCsvDocument, setCells, viewRows,
  type CsvDocument, type CsvSort,
} from "@/lib/csv-table";
import "./csv-table.css";

export interface CsvTableProps {
  /** The file's text, exactly as it is on disk. */
  text: string;
  /** The file's name: a `.tsv` name reads tabs first, and the sheet tab carries it. */
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
  /** Opens a web address a cell holds. Without one the link opens the way any link does, in a new tab. */
  onOpenLink?: (url: string) => void;
}

export type CsvView = "table" | "text";

interface Cell { row: number; col: number }
interface Editing extends Cell { value: string; selectAll: boolean; where: "cell" | "bar" }
interface Picked { anchor: Cell; cursor: Cell }

const HEADER = -1;
const OVERSCAN = 8;
const HISTORY = 100;
// One element can only be so tall; past this the table shows the first rows.
const MAX_SHOWN_ROWS = 500_000;
// The status bar adds up a selection up to this many cells; past it, it only counts them.
const MAX_STAT_CELLS = 400_000;
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
function contentWidths(doc: CsvDocument, measure: Measure, min: number, max: number, header: boolean): number[] {
  const widths = new Array<number>(doc.columnCount).fill(min);
  const end = Math.min(doc.rows.length, 200);
  for (let r = 0; r < end; r++) {
    const row = doc.rows[r];
    for (let c = 0; c < row.length; c++) {
      if (widths[c] >= max) continue;
      const value = decodeField(row[c]);
      const text = Math.ceil(measure(value.length > 80 ? value.slice(0, 80) : value));
      // The header is bold and leaves room for its sort mark.
      const width = header && r === 0 ? Math.ceil(text * 1.08) + 34 : text + 20;
      if (width > widths[c]) widths[c] = Math.min(max, width);
    }
  }
  return widths;
}

function writeClipboard(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const figure = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
/** An average is a made-up figure, so it is rounded to read: two places, more only for a small one. */
const average = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 6 });
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
/** The tab reads as a sheet's name does: the file's, without its extension. */
const sheetName = (name?: string) => (name ? name.replace(/\.(?:csv|tsv|tab|txt)$/i, "") || name : "Sheet 1");

export function CsvTable({ text, name, readOnly = false, onChange, renderText, compact = false, className, zoom = 1, view: hostView, onViewChange, onOpenLink }: CsvTableProps) {
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
  const decimalComma = doc.delimiter === ";";

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
  const rowHeight = Math.round((compact ? 32 : 24) * zoom);
  const letterHeight = Math.round((compact ? 24 : 20) * zoom);
  const fillWidth = Math.round((compact ? 88 : 96) * zoom);
  const fontSize = Math.round((compact ? 14 : 13) * zoom * 10) / 10;
  const scroller = useRef<HTMLDivElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Not the `font` shorthand: it reads as empty once tabular figures are on.
    const style = getComputedStyle(element);
    const made = canvasMeasure(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
    if (made) setMeasure(() => made);
  }, [view, fontSize]);
  const autoWidths = useMemo(
    () => contentWidths(doc, measure ?? ((value) => estimate(value) * zoom), (compact ? 72 : 64) * zoom, (compact ? 240 : 340) * zoom, headerOn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, doc.columnCount, measure, compact, zoom, headerOn],
  );
  const [resized, setResized] = useState<Record<number, number>>({});
  const widths = useMemo(() => Array.from({ length: columns }, (_unused, c) => resized[c] ?? autoWidths[c] ?? fillWidth), [columns, resized, autoWidths, fillWidth]);
  /** Where each column starts, past the gutter; one more entry than there are columns. */
  const offsets = useMemo(() => { const out = [0]; for (const width of widths) out.push(out[out.length - 1] + width); return out; }, [widths]);
  // Wide enough for the numbers of the empty rows under the data as well.
  const gutter = Math.max(compact ? 40 : 36, Math.round((16 + String(doc.rows.length + 60).length * 7.5) * zoom));
  const dataWidth = gutter + offsets[columns];

  // ---- the window of rows on screen, and the size of the window itself
  const [box, setBox] = useState({ first: 0, visible: 40, width: 0, height: 0 });
  const readWindow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const first = Math.floor(element.scrollTop / rowHeight);
    const visible = Math.ceil((element.clientHeight || 600) / rowHeight) + 1;
    const width = element.clientWidth, height = element.clientHeight;
    setBox((current) => (current.first === first && current.visible === visible && current.width === width && current.height === height ? current : { first, visible, width, height }));
  }, [rowHeight]);
  useLayoutEffect(() => {
    readWindow();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(readWindow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [readWindow, view]);
  const from = Math.max(0, Math.min(box.first, order.length) - OVERSCAN);
  const to = Math.min(order.length, box.first + box.visible + OVERSCAN);

  // ---- the empty sheet around the data: columns out to the right edge, rows down to the bottom
  const fills = useMemo(() => {
    const spare = box.width - dataWidth;
    if (spare <= 0) return [];
    const out = new Array<number>(Math.floor(spare / fillWidth)).fill(fillWidth);
    if (spare % fillWidth > 0) out.push(spare % fillWidth);
    return out;
  }, [box.width, dataWidth, fillWidth]);
  const sheetWidth = dataWidth + fills.reduce((sum, width) => sum + width, 0);
  const template = `${gutter}px ${widths.map((width) => `${width}px`).join(" ")}${fills.map((width) => ` ${width}px`).join("")}`;
  const frozen = letterHeight + (headerOn ? rowHeight : 0);
  const spareHeight = Math.max(0, box.height - frozen - order.length * rowHeight);
  const fillRows = Math.ceil(spareHeight / rowHeight);

  // ---- the active cell and the selection
  // `anchor` is the active cell, the one the name box names and typing edits;
  // `cursor` is the far corner of the selection, the end the Shift keys move.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const minRow = headerOn ? HEADER : 0;
  const maxRow = order.length - 1;
  const { anchor, cursor } = useMemo(() => {
    if (maxRow < minRow) return { anchor: null, cursor: null };
    const fit = (cell: Cell): Cell => ({ row: clamp(cell.row, minRow, maxRow), col: clamp(cell.col, 0, columns - 1) });
    // A sheet opens with its first cell selected.
    const first = fit({ row: 0, col: 0 });
    return picked ? { anchor: fit(picked.anchor), cursor: fit(picked.cursor) } : { anchor: first, cursor: first };
  }, [picked, minRow, maxRow, columns]);
  const selection = useMemo(() => {
    if (!cursor || !anchor) return null;
    return { top: Math.min(cursor.row, anchor.row), bottom: Math.max(cursor.row, anchor.row), left: Math.min(cursor.col, anchor.col), right: Math.max(cursor.col, anchor.col) };
  }, [cursor, anchor]);
  const single = !!selection && selection.top === selection.bottom && selection.left === selection.right;
  /** The row in the file behind a row on screen. */
  const fileRow = useCallback((row: number) => (row === HEADER ? 0 : order[row]), [order]);

  const reveal = useCallback((cell: Cell) => {
    const element = scroller.current;
    if (!element) return;
    if (cell.row !== HEADER) {
      const top = cell.row * rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + element.clientHeight - frozen) element.scrollTop = top + rowHeight - element.clientHeight + frozen;
    }
    const left = offsets[cell.col];
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (gutter + left + widths[cell.col] > element.scrollLeft + element.clientWidth) element.scrollLeft = gutter + left + widths[cell.col] - element.clientWidth;
  }, [rowHeight, frozen, gutter, widths, offsets]);

  const moveTo = useCallback((row: number, col: number, extend = false) => {
    if (maxRow < minRow) return;
    const next = { row: clamp(row, minRow, maxRow), col: clamp(col, 0, columns - 1) };
    setPicked({ anchor: extend ? anchor ?? next : next, cursor: next });
    reveal(next);
  }, [minRow, maxRow, columns, anchor, reveal]);

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
  const startEditing = useCallback((cell: Cell, typed?: string, where: Editing["where"] = "cell") => {
    if (!editable) return;
    setEditing({ ...cell, value: typed ?? cellValue(doc, fileRow(cell.row), cell.col), selectAll: typed === undefined, where });
  }, [editable, doc, fileRow]);
  const finishEditing = useCallback((save: boolean, then?: Cell, refocus = true) => {
    if (!editing) return;
    if (save) commit(setCells(doc, [{ row: fileRow(editing.row), column: editing.col, value: editing.value }]));
    setEditing(null);
    if (then) moveTo(then.row, then.col);
    // A click somewhere else already took the focus where it was going.
    if (refocus) focusGrid();
  }, [editing, commit, doc, fileRow, moveTo]);
  /** Where Enter and Tab go after an edit of `cell`. */
  const stepFrom = (cell: Cell, direction: "down" | "right" | "left" | undefined): Cell | undefined =>
    direction === "down" ? { row: Math.min(maxRow, cell.row + 1), col: cell.col }
      : direction === "right" ? { row: cell.row, col: Math.min(columns - 1, cell.col + 1) }
      : direction === "left" ? { row: cell.row, col: Math.max(0, cell.col - 1) } : undefined;

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
    if (!selection || !anchor) return "";
    if (single) return cellValue(doc, fileRow(anchor.row), anchor.col);
    return copyAs("\t");
  }, [selection, anchor, single, doc, fileRow, copyAs]);
  const clearSelection = useCallback(() => {
    if (!editable || !selection) return;
    const edits = selectedFileRows().flatMap((row) => selectedColumns().map((column) => ({ row, column, value: "" })));
    commit(setCells(doc, edits.filter((edit) => doc.rows[edit.row]?.[edit.column] !== undefined)));
  }, [editable, selection, selectedFileRows, selectedColumns, commit, doc]);
  const paste = useCallback((pasted: string) => {
    if (!editable || !selection) return;
    const block = clipboardToCells(pasted);
    const edits: { row: number; column: number; value: string }[] = [];
    block.forEach((cells, r) => {
      const row = selection.top + r;
      if (row > maxRow) return;
      cells.forEach((value, c) => { if (selection.left + c < columns) edits.push({ row: fileRow(row), column: selection.left + c, value }); });
    });
    commit(setCells(doc, edits));
  }, [editable, selection, maxRow, columns, fileRow, commit, doc]);

  // The sheet opens with a cell selected, but a row or a column is added
  // beside one only once a cell was picked: until then it goes at the end.
  const addRow = () => {
    const at = !picked || !selection || order.length === 0 ? doc.rows.length : selection.bottom === HEADER ? 1 : fileRow(selection.bottom) + 1;
    // The new row is empty, so a filter would hide it and a sort would move it.
    setFilter("");
    setSort(null);
    commit(insertRow(doc, at), true);
    const next = { row: Math.max(0, at - firstRow), col: anchor?.col ?? 0 };
    setPicked({ anchor: next, cursor: next });
    requestAnimationFrame(() => reveal(next));
  };
  const addColumn = (right: boolean) => {
    const at = picked && selection ? (right ? selection.right + 1 : selection.left) : doc.columnCount;
    setResized({});
    commit(doc.rows.length === 0 ? insertRow(doc, 0, [""]) : insertColumn(doc, at), doc.rows.length === 0);
  };
  const removeRows = () => {
    if (!selection || !anchor) return;
    commit(deleteRows(doc, selectedFileRows()), true);
    const next = { row: selection.top, col: anchor.col };
    setPicked({ anchor: next, cursor: next });
  };
  const removeColumns = () => {
    if (!selection || !anchor) return;
    setResized({});
    setSort(null);
    commit(deleteColumns(doc, selectedColumns()));
    const next = { row: anchor.row, col: selection.left };
    setPicked({ anchor: next, cursor: next });
  };
  const selectAll = () => {
    if (maxRow < minRow) return;
    setPicked({ anchor: { row: minRow, col: 0 }, cursor: { row: maxRow, col: columns - 1 } });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== event.currentTarget) return;
    const mod = event.metaKey || event.ctrlKey;
    // Shift moves the far corner of the selection; without it the active cell moves.
    const at = (event.shiftKey ? cursor : anchor) ?? { row: minRow, col: 0 };
    const page = Math.max(1, box.visible - 3);
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
        const cell = anchor ?? at;
        const col = cell.col + (event.shiftKey ? -1 : 1);
        if (col >= 0 && col < columns) { event.preventDefault(); moveTo(cell.row, col); }
        else if (!event.shiftKey && cell.row < maxRow) { event.preventDefault(); moveTo(cell.row + 1, 0); }
        else if (event.shiftKey && cell.row > minRow) { event.preventDefault(); moveTo(cell.row - 1, columns - 1); }
        return;
      }
      case "Enter":
      case "F2":
        if (anchor && editable) { event.preventDefault(); startEditing(anchor); }
        return;
      case "Escape":
        if (anchor && !single) { event.preventDefault(); setPicked({ anchor, cursor: anchor }); }
        return;
      case "Delete":
      case "Backspace":
        if (editable && anchor) { event.preventDefault(); clearSelection(); }
        return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAll();
    } else if (mod && event.key.toLowerCase() === "z" && editable) {
      event.preventDefault();
      event.stopPropagation();
      travel(!event.shiftKey);
    } else if (mod && event.key.toLowerCase() === "y" && editable) {
      event.preventDefault();
      travel(false);
    } else if (!mod && !event.altKey && event.key.length === 1 && anchor && editable) {
      event.preventDefault();
      startEditing(anchor, event.key);
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

  // ---- pointer: a click picks, a drag or a Shift click selects a block.
  // The letters select columns and the numbers select rows the same way.
  const dragging = useRef<"cells" | "rows" | "columns" | null>(null);
  const drag = (kind: "cells" | "rows" | "columns") => {
    dragging.current = kind;
    const stop = () => { dragging.current = null; window.removeEventListener("mouseup", stop); };
    window.addEventListener("mouseup", stop);
  };
  const pick = (event: ReactMouseEvent, cell: Cell) => {
    if (event.button !== 0) return;
    // An open editor saves itself as the click takes its focus.
    setPicked({ anchor: event.shiftKey && anchor ? anchor : cell, cursor: cell });
    drag("cells");
  };
  const extendTo = (cell: Cell) => { if (dragging.current === "cells" && anchor) setPicked({ anchor, cursor: cell }); };
  const pickRow = (event: ReactMouseEvent, row: number) => {
    if (event.button !== 0 || maxRow < minRow) return;
    setPicked({ anchor: { row: event.shiftKey && anchor ? anchor.row : row, col: 0 }, cursor: { row, col: columns - 1 } });
    drag("rows");
  };
  const extendRow = (row: number) => { if (dragging.current === "rows" && anchor) setPicked({ anchor, cursor: { row, col: columns - 1 } }); };
  const pickColumn = (event: ReactMouseEvent, col: number) => {
    if (event.button !== 0 || maxRow < minRow) return;
    setPicked({ anchor: { row: minRow, col: event.shiftKey && anchor ? anchor.col : col }, cursor: { row: maxRow, col } });
    drag("columns");
    focusGrid();
    event.preventDefault();
  };
  const extendColumn = (col: number) => { if (dragging.current === "columns" && anchor) setPicked({ anchor, cursor: { row: maxRow, col } }); };
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
  const fitColumn = (column: number) => setResized((current) => { const next = { ...current }; delete next[column]; return next; });
  /** The edge of a column's letter or header: drag to size it, double click to fit it. */
  const resizer = (column: number, labelled: boolean) => compact ? null : (
    <span
      className="csv-table-resize"
      role={labelled ? "separator" : undefined}
      aria-orientation={labelled ? "vertical" : undefined}
      aria-label={labelled ? `Resize column ${columnLetter(column)}` : undefined}
      aria-hidden={labelled ? undefined : true}
      onPointerDown={(event) => resize(event, column)}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => { event.stopPropagation(); fitColumn(column); }}
    />
  );
  // The rows are memoized, so what they call must not change between renders.
  const live = useRef({ pick, extendTo, pickRow, extendRow, startEditing, onOpenLink });
  live.current = { pick, extendTo, pickRow, extendRow, startEditing, onOpenLink };
  const rowPick = useCallback((event: ReactMouseEvent, cell: Cell) => live.current.pick(event, cell), []);
  const rowExtend = useCallback((cell: Cell) => live.current.extendTo(cell), []);
  const rowPickRow = useCallback((event: ReactMouseEvent, row: number) => live.current.pickRow(event, row), []);
  const rowExtendRow = useCallback((row: number) => live.current.extendRow(row), []);
  const rowEdit = useCallback((cell: Cell) => live.current.startEditing(cell), []);
  // In a sheet being edited a click picks the cell, so a link opens with ⌘ or Ctrl held.
  const rowLink = useCallback((event: ReactMouseEvent<HTMLAnchorElement>, url: string, needsModifier: boolean) => {
    if (needsModifier && !(event.metaKey || event.ctrlKey)) { event.preventDefault(); return; }
    const open = live.current.onOpenLink;
    if (open) { event.preventDefault(); open(url); }
  }, []);

  // ---- the name box and the formula bar
  const activeRef = anchor ? cellReference(fileRow(anchor.row), anchor.col) : "";
  const activeValue = anchor ? cellValue(doc, fileRow(anchor.row), anchor.col) : "";
  const [refDraft, setRefDraft] = useState<string | null>(null);
  const jump = (reference: string) => {
    const target = parseCellReference(reference);
    if (!target || target.column >= columns) return false;
    const row = headerOn && target.row === 0 ? HEADER : order.indexOf(target.row);
    if (row !== HEADER && row < 0) return false;
    moveTo(row, target.column);
    return true;
  };
  // The formula bar edits the active cell. Leaving it saves, as leaving a cell does;
  // the flag keeps the blur that follows Enter or Escape from saving a second time.
  const barOpen = useRef(false);
  const finishBar = (save: boolean, direction?: "down" | "right" | "left", refocus = true) => {
    if (!barOpen.current) return;
    barOpen.current = false;
    finishEditing(save, editing ? stepFrom(editing, direction) : undefined, refocus);
  };

  // ---- the status bar: what a block of cells adds up to
  const stats = useMemo(() => {
    if (!selection || single) return null;
    const cells = (selection.bottom - selection.top + 1) * (selection.right - selection.left + 1);
    if (cells > MAX_STAT_CELLS) return { cells, numbers: null };
    const rows: number[] = [];
    for (let row = selection.top; row <= selection.bottom; row++) rows.push(row === HEADER ? 0 : order[row]);
    return { cells, numbers: rangeStats(doc, rows, selection.left, selection.right) };
  }, [selection, single, doc, order]);

  const filtered = deferredFilter.trim() !== "";
  const summary = filtered
    ? `${order.length.toLocaleString("en-US")} of ${count(bodyRows, "row")}`
    : `${count(Math.max(bodyRows, 0), "row")} × ${count(doc.columnCount, "column")}`;
  const headerLabel = (column: number) => (headerOn ? cellValue(doc, 0, column) : columnLetter(column));
  const inSelection = (row: number, col: number) => !!selection && row >= selection.top && row <= selection.bottom && col >= selection.left && col <= selection.right;
  const columnSelected = (col: number) => !!selection && col >= selection.left && col <= selection.right;
  const editor = (cell: Cell) => editing && editing.where === "cell" && editing.row === cell.row && editing.col === cell.col ? (
    <CellEditor
      value={editing.value}
      selectAll={editing.selectAll}
      onValue={(value) => setEditing((current) => (current ? { ...current, value } : current))}
      onDone={(save, direction, refocus) => finishEditing(save, stepFrom(cell, direction), refocus)}
    />
  ) : null;
  const headerEditing = editing?.row === HEADER ? editing : null;
  const bodyTop = selection ? Math.max(selection.top, 0) : 0;

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
            <input type="checkbox" checked={headerOn} disabled={doc.rows.length === 0} onChange={(event) => { setHeaderChoice(event.target.checked); setPicked(null); }} />
            Header row
          </label>
          {editable ? <div className="csv-table-actions" role="group" aria-label="Rows and columns">
            <button type="button" onClick={addRow} title="Add a row below the selection">+ Row</button>
            <button type="button" onClick={() => addColumn(true)} title="Add a column to the right of the selection">+ Column</button>
            <button type="button" disabled={!selection || selection.bottom === HEADER || order.length === 0} onClick={removeRows} title="Delete the selected rows">Delete row</button>
            <button type="button" disabled={!selection || doc.columnCount === 0} onClick={removeColumns} title="Delete the selected columns">Delete column</button>
          </div> : null}
          {!compact && selection ? <div className="csv-table-actions" role="group" aria-label="Copy">
            <button type="button" onClick={() => writeClipboard(copyAs(","))} title="Copy the selection as comma-separated text">Copy CSV</button>
            <button type="button" onClick={() => writeClipboard(copyAs("\t"))} title="Copy the selection as tab-separated text">Copy TSV</button>
          </div> : null}
        </> : null}
      </div>

      {view === "table" ? <div className="csv-table-formula" role="group" aria-label="Selected cell">
        {compact ? <span className="csv-table-ref">{activeRef}</span> : (
          <input
            className="csv-table-ref"
            aria-label="Cell"
            title="The selected cell. Type a cell like B4 and press Enter to go to it."
            spellCheck={false}
            autoComplete="off"
            value={refDraft ?? activeRef}
            aria-invalid={refDraft !== null && refDraft.trim() !== "" && !parseCellReference(refDraft) ? true : undefined}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRefDraft(event.target.value)}
            onBlur={() => setRefDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); if (jump(event.currentTarget.value)) { setRefDraft(null); focusGrid(); } }
              else if (event.key === "Escape") { event.preventDefault(); setRefDraft(null); focusGrid(); }
            }}
          />
        )}
        <span className="csv-table-fx" aria-hidden="true">fx</span>
        {editable && anchor ? (
          <textarea
            className="csv-table-value"
            aria-label="Cell contents"
            rows={1}
            spellCheck={false}
            value={editing ? editing.value : activeValue}
            onFocus={() => { barOpen.current = true; if (!editing) startEditing(anchor, undefined, "bar"); }}
            onChange={(event) => { const value = event.target.value; setEditing((current) => (current ? { ...current, value } : current)); }}
            onBlur={() => finishBar(true, undefined, false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); finishBar(false); }
              else if (event.key === "Enter" && !event.altKey && !event.shiftKey) { event.preventDefault(); finishBar(true, "down"); }
              else if (event.key === "Tab") { event.preventDefault(); finishBar(true, event.shiftKey ? "left" : "right"); }
            }}
          />
        ) : <div className="csv-table-value" title={activeValue.length > 60 ? activeValue : undefined}>{activeValue}</div>}
      </div> : null}

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
          style={{ ["--csv-cols" as string]: template, ["--csv-row" as string]: `${rowHeight}px`, ["--csv-letters" as string]: `${letterHeight}px`, fontSize }}
          onScroll={readWindow}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
        >
          {/* The strip of column letters. With no header row it is the header: its letters name the columns and sort them. */}
          <div className="csv-table-letters" role={headerOn ? "presentation" : "row"} aria-rowindex={headerOn ? undefined : 1} style={{ width: sheetWidth }}>
            <div className="csv-table-corner" role="presentation" title="Select all" onMouseDown={(event) => { if (event.button === 0) { selectAll(); focusGrid(); event.preventDefault(); } }} />
            {widths.map((_width, column) => {
              const letter = columnLetter(column);
              const sorted = sort?.column === column ? sort.direction : null;
              return (
                <div
                  key={column}
                  role={headerOn ? "presentation" : "columnheader"}
                  aria-colindex={headerOn ? undefined : column + 1}
                  aria-sort={headerOn ? undefined : sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  className={`csv-table-letter${columnSelected(column) ? " is-selected" : ""}${sorted && !headerOn ? " is-sorted" : ""}`}
                >
                  <button type="button" className="csv-table-letter-pick" tabIndex={-1} title={`Select column ${letter}`} onMouseDown={(event) => pickColumn(event, column)} onMouseEnter={() => extendColumn(column)}>{letter}</button>
                  {headerOn ? null : <button type="button" className="csv-table-letter-sort" tabIndex={-1} data-sort={sorted ?? "none"} aria-label={`Sort column ${letter}`} title={`Sort column ${letter}`} onClick={(event) => { toggleSort(column, event.detail); focusGrid(); }} />}
                  {resizer(column, true)}
                </div>
              );
            })}
            {fills.map((_width, index) => <div key={`fill${index}`} className="csv-table-letter is-fill" aria-hidden="true">{columnLetter(columns + index)}</div>)}
          </div>
          {headerOn ? <div className="csv-table-head" role="row" aria-rowindex={1} style={{ width: sheetWidth }}>
            <div className={`csv-table-num${selection && selection.top === HEADER ? " is-selected" : ""}`} role="presentation" onMouseDown={(event) => pickRow(event, HEADER)} onMouseEnter={() => extendRow(HEADER)}>1</div>
            {widths.map((_width, column) => {
              const sorted = sort?.column === column ? sort.direction : null;
              const active = anchor?.row === HEADER && anchor.col === column;
              const label = headerLabel(column);
              const editingHere = headerEditing?.col === column ? headerEditing : null;
              return (
                <div
                  key={column}
                  role="columnheader"
                  aria-colindex={column + 1}
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  className={`csv-table-th${numeric[column] ? " is-number" : ""}${inSelection(HEADER, column) ? " is-selected" : ""}${active ? " is-cursor" : ""}${editingHere?.where === "cell" ? " is-editing" : ""}`}
                  onDoubleClick={editable ? () => { setSort(sortBeforeClick.current); setPicked({ anchor: { row: HEADER, col: column }, cursor: { row: HEADER, col: column } }); startEditing({ row: HEADER, col: column }); } : undefined}
                >
                  <button type="button" className="csv-table-sort" tabIndex={-1} title={label ? `${label}: click to sort` : "Click to sort"} onClick={(event) => { toggleSort(column, event.detail); focusGrid(); }}>
                    <span className="csv-table-th-label">{(editingHere?.where === "bar" ? editingHere.value : label) || " "}</span>
                    <span className="csv-table-sort-mark" aria-hidden="true">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                  </button>
                  {resizer(column, false)}
                  {editor({ row: HEADER, col: column })}
                </div>
              );
            })}
            {fills.map((_width, index) => <div key={`fill${index}`} className="csv-table-th is-fill" aria-hidden="true" />)}
          </div> : null}
          <div className="csv-table-body" style={{ height: order.length * rowHeight + spareHeight, width: sheetWidth }}>
            {order.slice(from, to).map((rowIndex, offset) => {
              const row = from + offset;
              const selected = !!selection && row >= selection.top && row <= selection.bottom;
              const editingHere = editing?.row === row ? editing : null;
              return (
                <Row
                  key={rowIndex}
                  cells={doc.rows[rowIndex]}
                  fileRow={rowIndex}
                  row={row}
                  top={row * rowHeight}
                  columns={columns}
                  widths={widths}
                  fills={fills}
                  decimalComma={decimalComma}
                  left={selected ? selection.left : -1}
                  right={selected ? selection.right : -1}
                  cursorCol={anchor?.row === row ? anchor.col : -1}
                  editor={editingHere?.where === "cell" ? editor({ row, col: editingHere.col }) : null}
                  editingCol={editingHere?.where === "cell" ? editingHere.col : -1}
                  liveCol={editingHere?.where === "bar" ? editingHere.col : -1}
                  liveText={editingHere?.where === "bar" ? editingHere.value : ""}
                  linkNeedsModifier={editable}
                  onPick={rowPick}
                  onExtend={rowExtend}
                  onPickRow={rowPickRow}
                  onExtendRow={rowExtendRow}
                  onEdit={editable ? rowEdit : undefined}
                  onLink={rowLink}
                />
              );
            })}
            {/* Under the last row the sheet goes on, empty, to the bottom of the window. */}
            {Array.from({ length: fillRows }, (_unused, index) => (
              <FillRow
                key={`fill${index}`}
                number={doc.rows.length + index + 1}
                top={(order.length + index) * rowHeight}
                height={index === fillRows - 1 ? spareHeight - index * rowHeight : rowHeight}
                cells={columns + fills.length}
              />
            ))}
            {selection && selection.bottom >= 0 && order.length > 0 ? (
              <div
                className={`csv-table-range${single ? " is-single" : ""}${selection.top === HEADER ? " is-open" : ""}${editing?.where === "cell" ? " is-editing" : ""}`}
                aria-hidden="true"
                style={{ top: bodyTop * rowHeight, left: gutter + offsets[selection.left], width: offsets[selection.right + 1] - offsets[selection.left], height: (selection.bottom - bodyTop + 1) * rowHeight }}
              >
                <span className="csv-table-handle" />
              </div>
            ) : null}
            {order.length === 0 ? <p className="csv-table-empty" style={{ top: rowHeight, width: box.width || undefined }}>{doc.rows.length === 0 ? "This file is empty." : filtered ? "No rows match the filter." : "No rows yet."}</p> : null}
          </div>
        </div>
      )}

      <div className="csv-table-foot">
        <div className="csv-table-tabs">
          <span className="csv-table-tab" title={name ?? undefined}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.6" /><path d="M1.65 6.5h12.7M1.65 10h12.7M6 2.65v10.7" /></svg>
            <span className="csv-table-tab-name">{sheetName(name)}</span>
          </span>
        </div>
        <span className="csv-table-summary" role="status">{summary}</span>
        <span className="csv-table-spacer" />
        {view === "table" && stats ? (
          <span className="csv-table-stats" aria-live="polite">
            {stats.numbers ? <>
              <span>Sum <b>{figure(stats.numbers.sum)}</b></span>
              <span>Average <b>{average(stats.numbers.average)}</b></span>
              <span>Count <b>{figure(stats.numbers.count)}</b></span>
            </> : <span>{count(stats.cells, "cell")} selected</span>}
          </span>
        ) : null}
        {view === "table" && allRows.length > MAX_SHOWN_ROWS ? <span className="csv-table-detail">Showing the first {MAX_SHOWN_ROWS.toLocaleString("en-US")} rows</span> : null}
        <span className="csv-table-detail">{DELIMITER_NAMES[doc.delimiter]}{view === "table" && (sort || filtered) ? " · view only, the file keeps its order" : ""}</span>
      </div>
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
  /** The empty columns between the last one in the file and the edge of the window. */
  fills: readonly number[];
  decimalComma: boolean;
  left: number;
  right: number;
  cursorCol: number;
  editingCol: number;
  editor: ReactNode;
  /** The cell the formula bar is typing into, and what it has typed. */
  liveCol: number;
  liveText: string;
  linkNeedsModifier: boolean;
  onPick: (event: ReactMouseEvent, cell: Cell) => void;
  onExtend: (cell: Cell) => void;
  onPickRow: (event: ReactMouseEvent, row: number) => void;
  onExtendRow: (row: number) => void;
  onEdit?: (cell: Cell) => void;
  onLink: (event: ReactMouseEvent<HTMLAnchorElement>, url: string, needsModifier: boolean) => void;
}

const KIND_CLASS: Record<string, string> = { number: " is-number", percent: " is-number", currency: " is-number", date: " is-date", boolean: " is-boolean", url: " is-link", text: "", empty: "" };

const Row = memo(function Row({ cells, fileRow, row, top, columns, widths, fills, decimalComma, left, right, cursorCol, editingCol, editor, liveCol, liveText, linkNeedsModifier, onPick, onExtend, onPickRow, onExtendRow, onEdit, onLink }: RowProps) {
  const out: ReactNode[] = [];
  for (let col = 0; col < columns; col++) {
    const raw = cells[col];
    const value = col === liveCol ? liveText : raw === undefined ? "" : decodeField(raw);
    const shown = formatCell(value, decimalComma);
    const long = value.length * 7 > widths[col] - 16;
    out.push(
      <div
        key={col}
        role="gridcell"
        aria-colindex={col + 1}
        aria-selected={col >= left && col <= right}
        className={`csv-table-cell${KIND_CLASS[shown.kind]}${shown.negative ? " is-negative" : ""}${col >= left && col <= right ? " is-selected" : ""}${col === cursorCol ? " is-cursor" : ""}${raw === undefined ? " is-missing" : ""}${col === editingCol ? " is-editing" : ""}`}
        title={long ? value : undefined}
        onMouseDown={(event) => onPick(event, { row, col })}
        onMouseEnter={() => onExtend({ row, col })}
        onDoubleClick={onEdit ? () => onEdit({ row, col }) : undefined}
      >
        {col === editingCol ? editor : shown.kind === "url" ? (
          <a className="csv-table-link" href={shown.text} target="_blank" rel="noopener noreferrer" tabIndex={-1} draggable={false} title={linkNeedsModifier ? `${shown.text}\n⌘ or Ctrl click to open` : undefined} onClick={(event) => onLink(event, shown.text, linkNeedsModifier)}>{shown.text}</a>
        ) : shown.text}
      </div>,
    );
  }
  for (let index = 0; index < fills.length; index++) out.push(<div key={`fill${index}`} className="csv-table-cell is-fill" aria-hidden="true" />);
  return (
    <div className={`csv-table-row${editingCol >= 0 ? " is-editing" : ""}`} role="row" aria-rowindex={row + 2} style={{ top }}>
      {/* The number is the row's line in the file, so it still names the row when sorted. */}
      <div className={`csv-table-num${left >= 0 ? " is-selected" : ""}`} role="rowheader" onMouseDown={(event) => onPickRow(event, row)} onMouseEnter={() => onExtendRow(row)}>{fileRow + 1}</div>
      {out}
    </div>
  );
});

/** A row of the empty sheet under the data. Drawn, never selected: the file has no such row. */
const FillRow = memo(function FillRow({ number, top, height, cells }: { number: number; top: number; height: number; cells: number }) {
  return (
    <div className="csv-table-row is-fill" aria-hidden="true" style={{ top, height }}>
      <div className="csv-table-num">{number}</div>
      {Array.from({ length: cells }, (_unused, index) => <div key={index} className="csv-table-cell is-fill" />)}
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
