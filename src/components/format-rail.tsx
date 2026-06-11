"use client";

import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

interface FormatRailProps {
  editor: Editor | null;
}

interface RailButton {
  key: string;
  label: string;
  title: string;
  serif?: boolean;
  run: (editor: Editor) => void;
  active?: (s: ActiveStates) => boolean;
}

type ActiveStates = Record<string, boolean>;

const COMMON: RailButton[] = [
  { key: "h1", label: "H1", title: "Heading 1", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (s) => s.h1 },
  { key: "h2", label: "H2", title: "Heading 2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (s) => s.h2 },
  { key: "h3", label: "H3", title: "Heading 3", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (s) => s.h3 },
  { key: "bold", label: "B", title: "Bold (⌘B)", run: (e) => e.chain().focus().toggleBold().run(), active: (s) => s.bold },
  { key: "italic", label: "I", title: "Italic (⌘I)", serif: true, run: (e) => e.chain().focus().toggleItalic().run(), active: (s) => s.italic },
  { key: "strike", label: "S̶", title: "Strikethrough", run: (e) => e.chain().focus().toggleStrike().run(), active: (s) => s.strike },
  { key: "code", label: "<>", title: "Inline code", run: (e) => e.chain().focus().toggleCode().run(), active: (s) => s.code },
  { key: "bullet", label: "•≡", title: "Bullet list", run: (e) => e.chain().focus().toggleBulletList().run(), active: (s) => s.bulletList },
  { key: "ordered", label: "1.", title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (s) => s.orderedList },
  { key: "task", label: "☑", title: "Task list", run: (e) => e.chain().focus().toggleTaskList().run(), active: (s) => s.taskList },
  { key: "quote", label: "❝", title: "Blockquote", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (s) => s.blockquote },
  { key: "codeblock", label: "{ }", title: "Code block", run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (s) => s.codeBlock },
  { key: "table", label: "⊞", title: "Insert table", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: (s) => s.table },
  { key: "hr", label: "—", title: "Horizontal rule", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

const ADVANCED: RailButton[] = [
  { key: "mathi", label: "∑", title: "Inline math ($…$)", run: (e) => e.chain().focus().insertContent("$E = mc^2$").run() },
  { key: "mathb", label: "∬", title: "Math block ($$…$$)", run: (e) => e.chain().focus().insertContent("\n$$\nE = mc^2\n$$\n").run() },
  { key: "footnote", label: "†", title: "Footnote", run: (e) => e.chain().focus().insertContent("[^1]").run() },
  { key: "clear", label: "⌫", title: "Clear formatting", run: (e) => e.chain().focus().unsetAllMarks().clearNodes().run() },
];

export function FormatRail({ editor }: FormatRailProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState("");

  const states = useEditorState({
    editor,
    selector: ({ editor: e }): ActiveStates =>
      e
        ? {
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            taskList: e.isActive("taskList"),
            blockquote: e.isActive("blockquote"),
            codeBlock: e.isActive("codeBlock"),
            table: e.isActive("table"),
            link: e.isActive("link"),
          }
        : {},
  });

  if (!editor) return null;

  const btnClass = (active: boolean) =>
    `w-8 h-7 flex items-center justify-center rounded text-[11px] transition-all select-none ${
      active ? "bg-accent text-foreground" : "text-muted hover:text-foreground hover:bg-accent/40"
    }`;

  const applyLink = () => {
    if (linkUrl.trim()) {
      editor.chain().focus().setLink({ href: linkUrl.trim() }).run();
    }
    setLinkOpen(false);
    setLinkUrl("");
  };

  const applyImage = () => {
    if (imageUrl.trim()) {
      editor.chain().focus().setImage({ src: imageUrl.trim() }).run();
    }
    setImageOpen(false);
    setImageUrl("");
  };

  return (
    <div className="w-11 shrink-0 border-r border-border bg-surface flex flex-col items-center py-2 gap-0.5 overflow-y-auto relative">
      {COMMON.map((b) => (
        <button
          key={b.key}
          title={b.title}
          onClick={() => b.run(editor)}
          className={btnClass(b.active ? !!(states && b.active(states)) : false)}
          style={b.serif ? { fontFamily: "serif", fontStyle: "italic" } : undefined}
        >
          {b.label}
        </button>
      ))}

      {/* Link + image get tiny URL popovers */}
      <button
        title={states?.link ? "Remove link" : "Link"}
        onClick={() => {
          if (states?.link) {
            editor.chain().focus().unsetLink().run();
          } else {
            setLinkOpen((v) => !v);
            setImageOpen(false);
          }
        }}
        className={btnClass(!!states?.link)}
      >
        🔗
      </button>
      <button
        title="Image (URL)"
        onClick={() => {
          setImageOpen((v) => !v);
          setLinkOpen(false);
        }}
        className={btnClass(false)}
      >
        🖼
      </button>

      <div className="flex-1" />

      <button
        title={showAdvanced ? "Hide advanced tools" : "Advanced tools"}
        onClick={() => setShowAdvanced((v) => !v)}
        className={btnClass(showAdvanced)}
      >
        ⋯
      </button>
      {showAdvanced &&
        ADVANCED.map((b) => (
          <button key={b.key} title={b.title} onClick={() => b.run(editor)} className={btnClass(false)}>
            {b.label}
          </button>
        ))}

      {(linkOpen || imageOpen) && (
        <div className="absolute left-12 top-2 z-50 bg-surface-2 border border-border rounded-lg shadow-xl p-2 flex items-center gap-2" style={{ background: "#1c1c20" }}>
          <input
            autoFocus
            value={linkOpen ? linkUrl : imageUrl}
            onChange={(e) => (linkOpen ? setLinkUrl(e.target.value) : setImageUrl(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (linkOpen ? applyLink : applyImage)();
              if (e.key === "Escape") {
                setLinkOpen(false);
                setImageOpen(false);
              }
            }}
            placeholder={linkOpen ? "https://link…" : "https://image…"}
            className="text-[12px] bg-background border border-border rounded px-1.5 py-0.5 w-52 text-foreground outline-none"
          />
          <button onClick={linkOpen ? applyLink : applyImage} className="text-[11px] text-muted hover:text-foreground">
            Add
          </button>
        </div>
      )}
    </div>
  );
}

interface TableBarProps {
  editor: Editor;
}

export function TableBar({ editor }: TableBarProps) {
  const actions: Array<[string, string, () => void]> = [
    ["+ Row ↑", "Add row above", () => editor.chain().focus().addRowBefore().run()],
    ["+ Row ↓", "Add row below", () => editor.chain().focus().addRowAfter().run()],
    ["+ Col ←", "Add column left", () => editor.chain().focus().addColumnBefore().run()],
    ["+ Col →", "Add column right", () => editor.chain().focus().addColumnAfter().run()],
    ["− Row", "Delete row", () => editor.chain().focus().deleteRow().run()],
    ["− Col", "Delete column", () => editor.chain().focus().deleteColumn().run()],
    ["Header", "Toggle header row", () => editor.chain().focus().toggleHeaderRow().run()],
    ["✕ Table", "Delete table", () => editor.chain().focus().deleteTable().run()],
  ];

  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 bg-surface-2 border border-border rounded-lg shadow-xl px-2 py-1" style={{ background: "#1c1c20" }}>
      {actions.map(([label, title, run]) => (
        <button
          key={label}
          title={title}
          onClick={run}
          className="px-2 py-0.5 text-[11px] rounded text-muted hover:text-foreground hover:bg-accent/40 transition-all whitespace-nowrap"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
