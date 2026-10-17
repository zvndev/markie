import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import type { Editor } from "@tiptap/react";
import type { DocumentSession } from "@/lib/document-session";
import { parseCSV } from "@/lib/csv";
import { DocToolbar } from "@/components/doc-toolbar";
import { FormattingToolbar } from "@/components/formatting-toolbar";
import { appearanceVars, clampFontSize, DEFAULT_APPEARANCE, fontStack, type DocAppearance } from "@/lib/doc-appearance";
import type { FormattingAction } from "@/lib/format-controls";

const RichView = lazy(() => import("@/components/rich-view").then((module) => ({ default: module.RichView })));
const TEXT_ACTIONS: readonly FormattingAction[] = ["undo", "redo"];
const MARKDOWN_ACTIONS: readonly FormattingAction[] = ["undo", "redo", "bold", "italic", "bullet"];
const INLINE_CONTROL = "h-7 px-1.5 rounded flex items-center justify-center shrink-0 text-[11px] text-muted hover:text-foreground hover:bg-accent/40 disabled:opacity-35";
interface TextDocumentEditorProps {
  session: DocumentSession;
  readOnly?: boolean;
  onChange: (text: string) => void;
  onRestoreText?: (text: string) => void;
  onFlushReady: (flush: (() => string | null) | null) => void;
  onCommandsReady?: (target: DocumentCommandTarget | null) => void;
  /** Keeps source history and the shared toolbar mounted while a format adds its own preview. */
  renderSource?: (source: ReactNode) => ReactNode;
  /** A preview-owning format can reveal the source before its find controls select text. */
  onFindRequested?: () => void;
  /** Reveal retained source before a toolbar operation changes it. */
  onSourceEditRequested?: () => void;
}
export function TextDocumentEditor({ session, readOnly, onChange, onRestoreText, onFlushReady, onCommandsReady, renderSource, onFindRequested, onSourceEditRequested }: TextDocumentEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"source" | "rich">("source");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [appearance, setAppearance] = useState<DocAppearance>({ ...DEFAULT_APPEARANCE, fontFamily: "mono", fontSize: 14 });
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
    if (readOnly || host.current?.closest("[inert]")) return;
    if (text.replace(/\r\n?/g, "\n") === session.text.replace(/\r\n?/g, "\n")) return;
    onSourceEditRequested?.();
    remember(undoHistory.current, session.text); redoHistory.current = []; onChange(text);
  };
  const undo = () => { const text = undoHistory.current.pop(); if (text !== undefined) { onSourceEditRequested?.(); remember(redoHistory.current, session.text); (onRestoreText ?? onChange)(text); } };
  const redo = () => { const text = redoHistory.current.pop(); if (text !== undefined) { onSourceEditRequested?.(); remember(undoHistory.current, session.text); (onRestoreText ?? onChange)(text); } };
  const markdown = session.format === "markdown";
  const markdownSource = markdown || session.format === "darkmown";
  const wrap = (before: string, after = "") => {
    const field = textarea.current;
    if (!field || readOnly) return;
    const value = field.value;
    const start = field.selectionStart, end = field.selectionEnd;
    applyText(value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start + before.length, end + before.length); });
  };
  const setSourceStyle = (style: string) => {
    const field = textarea.current;
    if (!field || readOnly || host.current?.closest("[inert]")) return;
    if (style === "code") { wrap("```\n", "\n```"); return; }
    const prefix = style === "quote" ? "> " : /^h[1-3]$/.test(style) ? `${"#".repeat(Number(style[1]))} ` : "";
    const start = field.value.lastIndexOf("\n", field.selectionStart - 1) + 1;
    const endOfLine = field.value.indexOf("\n", field.selectionEnd);
    const end = endOfLine < 0 ? field.value.length : endOfLine;
    const replacement = field.value.slice(start, end).split("\n").map((line) => prefix + line.replace(/^(?:#{1,6}\s+|>\s+)/, "")).join("\n");
    applyText(field.value.slice(0, start) + replacement + field.value.slice(end));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(start, start + replacement.length); });
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
  const openFind = () => { onFindRequested?.(); if (mode === "rich") switchMode("source"); setFindOpen(true); requestAnimationFrame(() => findField.current?.focus()); };
  const findNext = () => {
    const field = textarea.current;
    if (!field || !query) return;
    let offset = field.value.indexOf(query, field.selectionEnd);
    if (offset < 0) offset = field.value.indexOf(query);
    if (offset >= 0) { field.focus(); field.setSelectionRange(offset, offset + query.length); }
  };
  const actions = useRef({ undo, redo, openFind, readOnly, mode, editor });
  actions.current = { undo, redo, openFind, readOnly, mode, editor };
  const richReady = !!editor && !editor.isDestroyed && editor.isEditable;
  const enabledKey = ["find", ...(!readOnly && (mode === "rich" ? richReady : undoHistory.current.length > 0) ? ["undo"] : []), ...(!readOnly && (mode === "rich" ? richReady : redoHistory.current.length > 0) ? ["redo"] : [])].join("|");
  const execute = useCallback((command: string) => {
    if (!host.current || host.current.closest("[inert]")) return;
    const current = actions.current;
    if (command === "find") { current.openFind(); return; }
    if (current.readOnly) return;
    if (current.mode === "rich" && (!current.editor || current.editor.isDestroyed || !current.editor.isEditable)) return;
    if (command === "undo") { if (current.mode === "rich") current.editor?.chain().focus().undo().run(); else current.undo(); }
    else if (command === "redo") { if (current.mode === "rich") current.editor?.chain().focus().redo().run(); else current.redo(); }
  }, []);
  useEffect(() => { onCommandsReady?.({ enabledCommands: enabledKey.split("|"), execute }); return () => onCommandsReady?.(null); }, [onCommandsReady, enabledKey, execute]);
  const startControls = <>
    {markdown ? <>
      <button type="button" className={INLINE_CONTROL} aria-pressed={mode === "source"} onClick={() => switchMode("source")}>Source</button>
      <button type="button" className={INLINE_CONTROL} aria-pressed={mode === "rich"} onClick={() => switchMode("rich")}>Rich view</button>
      <button type="button" className={INLINE_CONTROL} disabled={readOnly} onClick={() => {
        if (host.current?.closest("[inert]") || readOnly) return;
        if (mode === "rich") editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run();
        else wrap("\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n");
      }}>Table</button>
    </> : <span className="text-[11px] text-muted shrink-0">{session.format === "darkmown" ? "Darkmown · Source" : `${session.format.toUpperCase()} · Literal text`}</span>}
    {session.format === "csv" ? <button type="button" className={INLINE_CONTROL} aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>Table preview</button> : null}
    <button type="button" className={INLINE_CONTROL} aria-expanded={findOpen} onClick={() => findOpen ? setFindOpen(false) : openFind()}>Find</button>
    <span className="docs-text-encoding shrink-0" style={{ marginLeft: 0 }}>{session.textMetadata?.encoding.toUpperCase()}{session.textMetadata?.bom ? " BOM" : ""} · {session.textMetadata?.newline.toUpperCase()}</span>
  </>;
  const formatSource = (action: FormattingAction) => {
    if (host.current?.closest("[inert]") || readOnly) return;
    if (action === "undo" || action === "redo") { execute(action); return; }
    if (!markdownSource) return;
    if (action === "bold") wrap("**", "**");
    else if (action === "italic") wrap("_", "_");
    else if (action === "bullet") wrap("- ");
  };
  const sourceField = <textarea ref={textarea} className="docs-textarea" style={{ fontFamily: fontStack(appearance.fontFamily), fontSize: appearance.fontSize * appearance.zoom }} aria-label="Document text" data-document-text-editor spellCheck={session.format === "text" || markdownSource} value={session.text.replace(/\r\n?/g, "\n")} onChange={(event) => applyText(event.target.value)} readOnly={readOnly} placeholder={markdownSource ? "Start writing in Markdown…" : "Start writing…"} />;
  return <div ref={host} className="docs-text-host" style={appearanceVars(appearance)} onKeyDown={(event) => {
    if (host.current?.closest("[inert]")) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); }
    else if (event.key.toLowerCase() === "z" && event.target === textarea.current && !readOnly) {
      if (event.shiftKey && redoHistory.current.length) { event.preventDefault(); redo(); }
      else if (!event.shiftKey && undoHistory.current.length) { event.preventDefault(); undo(); }
    }
  }}>
    {markdown && mode === "rich" ? <DocToolbar editor={editor} appearance={appearance} onAppearance={setAppearance} canEdit={!readOnly} startControls={startControls} /> : <FormattingToolbar
      state={{ canUndo: !!undoHistory.current.length, canRedo: !!redoHistory.current.length }}
      canEdit={!readOnly} appearance={appearance} onAppearance={setAppearance}
      currentStyle="paragraph" currentFont={appearance.fontFamily} selecting={false} currentSize={appearance.fontSize}
      onFont={(fontFamily) => setAppearance((current) => ({ ...current, fontFamily }))}
      onSize={(size) => setAppearance((current) => ({ ...current, fontSize: clampFontSize(size) }))}
      onStyle={setSourceStyle} onAction={formatSource} supportedActions={markdownSource ? MARKDOWN_ACTIONS : TEXT_ACTIONS}
      showStyleControls={markdownSource} showWidthControls={false} startControls={startControls}
    />}
    {findOpen ? <div className="docs-find-tools docs-text-find" role="search" aria-label="Find document text" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setFindOpen(false); textarea.current?.focus(); } else if (event.key === "Enter") { event.preventDefault(); findNext(); } }}><label>Find in source<input ref={findField} aria-label="Find document text" value={query} placeholder="Case-sensitive text" onChange={(event) => setQuery(event.target.value)} /></label><button type="button" disabled={!matchCount} onClick={findNext}>Find next</button><label>Replace with<input aria-label="Replace document text with" value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label><button type="button" disabled={readOnly || !matchCount} onClick={() => applyText(source.split(query).join(replacement))}>Replace all</button><span role="status">{matchCount} matches</span><button type="button" aria-label="Close find" onClick={() => setFindOpen(false)}>×</button></div> : null}
    {rows ? <div className="docs-csv-preview"><table aria-label="CSV table preview"><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody></table></div> : null}
    {markdown && mode === "rich" ? <Suspense fallback={<p className="docs-loading">Loading rich editor…</p>}><RichView value={session.text} onChange={onChange} readOnly={readOnly} onEditorReady={setEditor} onFlushReady={(flush) => { localFlush.current = flush; onFlushReady(flush); }} /></Suspense> : renderSource ? renderSource(sourceField) : sourceField}
  </div>;
}
