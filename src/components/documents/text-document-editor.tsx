import { lazy, Suspense, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { DocumentSession } from "@/lib/document-session";
import { parseCSV } from "@/lib/csv";

const RichView = lazy(() => import("@/components/rich-view").then((module) => ({ default: module.RichView })));
interface TextDocumentEditorProps {
  session: DocumentSession;
  readOnly?: boolean;
  onChange: (text: string) => void;
  onRestoreText?: (text: string) => void;
  onFlushReady: (flush: (() => string | null) | null) => void;
}
export function TextDocumentEditor({ session, readOnly, onChange, onRestoreText, onFlushReady }: TextDocumentEditorProps) {
  const [mode, setMode] = useState<"source" | "rich">("source");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [findOpen, setFindOpen] = useState(false), [query, setQuery] = useState(""), [replacement, setReplacement] = useState("");
  const findField = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const localFlush = useRef<(() => string | null) | null>(null);
  const undoHistory = useRef<string[]>([]), redoHistory = useRef<string[]>([]);
  const remember = (history: string[], text: string) => {
    history.push(text); let size = history.reduce((sum, value) => sum + value.length, 0);
    while (history.length > 100 || size > 4 * 1024 * 1024) size -= history.shift()!.length;
  };
  const applyText = (text: string) => {
    if (text.replace(/\r\n?/g, "\n") === session.text.replace(/\r\n?/g, "\n")) return;
    remember(undoHistory.current, session.text); redoHistory.current = []; onChange(text);
  };
  const undo = () => { const text = undoHistory.current.pop(); if (text !== undefined) { remember(redoHistory.current, session.text); (onRestoreText ?? onChange)(text); } };
  const redo = () => { const text = redoHistory.current.pop(); if (text !== undefined) { remember(undoHistory.current, session.text); (onRestoreText ?? onChange)(text); } };
  const markdown = session.format === "markdown";
  const wrap = (before: string, after = "") => {
    const field = textarea.current;
    if (!field || readOnly) return;
    const value = field.value;
    const start = field.selectionStart, end = field.selectionEnd;
    applyText(value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, end + before.length); });
  };
  const switchMode = (next: "source" | "rich") => {
    const pending = localFlush.current?.();
    if (pending !== null && pending !== undefined) onChange(pending);
    undoHistory.current = []; redoHistory.current = [];
    onFlushReady(null); localFlush.current = null; setMode(next);
  };
  const rows = session.format === "csv" && showTable ? parseCSV(session.text) : null;
  const source = session.text.replace(/\r\n?/g, "\n");
  const matchCount = query ? source.split(query).length - 1 : 0;
  const openFind = () => { if (mode === "rich") switchMode("source"); setFindOpen(true); requestAnimationFrame(() => findField.current?.focus()); };
  const findNext = () => {
    const field = textarea.current;
    if (!field || !query) return;
    let offset = field.value.indexOf(query, field.selectionEnd);
    if (offset < 0) offset = field.value.indexOf(query);
    if (offset >= 0) { field.focus(); field.setSelectionRange(offset, offset + query.length); }
  };
  return <div className="docs-text-host" onKeyDown={(event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); }
    else if (event.key.toLowerCase() === "z" && event.target === textarea.current && !readOnly) {
      if (event.shiftKey && redoHistory.current.length) { event.preventDefault(); redo(); }
      else if (!event.shiftKey && undoHistory.current.length) { event.preventDefault(); undo(); }
    }
  }}>
    <div className="docs-text-toolbar">
      <div className="docs-tool-group">{markdown ? <><button type="button" aria-pressed={mode === "source"} onClick={() => switchMode("source")}>Source</button><button type="button" aria-pressed={mode === "rich"} onClick={() => switchMode("rich")}>Rich view</button></> : <span>{session.format.toUpperCase()} · Literal text</span>}</div>
      {markdown ? <div className="docs-tool-group"><button type="button" disabled={readOnly} onClick={() => mode === "rich" ? editor?.chain().focus().toggleBold().run() : wrap("**", "**")}><b>Bold</b></button><button type="button" disabled={readOnly} onClick={() => mode === "rich" ? editor?.chain().focus().toggleItalic().run() : wrap("_", "_")}><i>Italic</i></button><button type="button" disabled={readOnly} onClick={() => mode === "rich" ? editor?.chain().focus().toggleHeading({ level: 1 }).run() : wrap("# ")}>Heading</button><button type="button" disabled={readOnly} onClick={() => mode === "rich" ? editor?.chain().focus().toggleBulletList().run() : wrap("- ")}>List</button><button type="button" disabled={readOnly} onClick={() => mode === "rich" ? editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run() : wrap("\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n")}>Table</button></div> : null}
      {session.format === "csv" ? <button type="button" aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>Table preview</button> : null}
      <button type="button" aria-expanded={findOpen} onClick={() => findOpen ? setFindOpen(false) : openFind()}>Find</button>
      <button type="button" disabled={readOnly || (mode === "source" ? !undoHistory.current.length : !editor)} onClick={() => mode === "rich" ? editor?.chain().focus().undo().run() : undo()}>Undo</button><button type="button" disabled={readOnly || (mode === "source" ? !redoHistory.current.length : !editor)} onClick={() => mode === "rich" ? editor?.chain().focus().redo().run() : redo()}>Redo</button>
      <span className="docs-text-encoding">{session.textMetadata?.encoding.toUpperCase()}{session.textMetadata?.bom ? " BOM" : ""} · {session.textMetadata?.newline.toUpperCase()}</span>
    </div>
    {findOpen ? <div className="docs-find-tools docs-text-find" role="search" aria-label="Find document text" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setFindOpen(false); textarea.current?.focus(); } else if (event.key === "Enter") { event.preventDefault(); findNext(); } }}><label>Find in source<input ref={findField} aria-label="Find document text" value={query} placeholder="Case-sensitive text" onChange={(event) => setQuery(event.target.value)} /></label><button type="button" disabled={!matchCount} onClick={findNext}>Find next</button><label>Replace with<input aria-label="Replace document text with" value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label><button type="button" disabled={readOnly || !matchCount} onClick={() => applyText(source.split(query).join(replacement))}>Replace all</button><span role="status">{matchCount} matches</span><button type="button" aria-label="Close find" onClick={() => setFindOpen(false)}>×</button></div> : null}
    {rows ? <div className="docs-csv-preview"><table aria-label="CSV table preview"><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody></table></div> : null}
    {markdown && mode === "rich" ? <Suspense fallback={<p className="docs-loading">Loading rich editor…</p>}><RichView value={session.text} onChange={onChange} readOnly={readOnly} onEditorReady={setEditor} onFlushReady={(flush) => { localFlush.current = flush; onFlushReady(flush); }} /></Suspense> : <textarea ref={textarea} className="docs-textarea" aria-label="Document text" data-document-text-editor spellCheck={session.format === "text" || markdown} value={session.text.replace(/\r\n?/g, "\n")} onChange={(event) => applyText(event.target.value)} readOnly={readOnly} placeholder={markdown ? "Start writing in Markdown…" : "Start writing…"} />}
  </div>;
}
