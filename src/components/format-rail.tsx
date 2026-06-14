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
  // Link/image insertion uses a centered modal (not an inline rail popover,
  // which got clipped/scrolled inside the 44px rail). `modal` picks the form.
  const [modal, setModal] = useState<null | "link" | "image">(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [newTab, setNewTab] = useState(true);

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

  const closeModal = () => {
    setModal(null);
    setUrl("");
    setLabel("");
  };

  // Link button: if the cursor sits in a link, toggle it off; otherwise open
  // the modal, prefilling URL/text/target from the selection or existing link.
  const openLink = () => {
    if (states?.link) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const { from, to } = editor.state.selection;
    const selText = editor.state.doc.textBetween(from, to, " ");
    const attrs = editor.getAttributes("link");
    setUrl(typeof attrs.href === "string" ? attrs.href : "");
    setLabel(selText);
    setNewTab(attrs.target ? attrs.target === "_blank" : true);
    setModal("link");
  };

  const openImage = () => {
    setUrl("");
    setLabel("");
    setModal("image");
  };

  const applyModal = () => {
    const href = url.trim();
    if (!href) {
      closeModal();
      return;
    }
    if (modal === "image") {
      editor
        .chain()
        .focus()
        .setImage({ src: href, alt: label.trim() || undefined })
        .run();
    } else {
      const target = newTab ? "_blank" : null;
      const rel = newTab ? "noopener noreferrer" : null;
      const text = label.trim();
      const chain = editor.chain().focus();
      if (text) {
        // Insert (or replace the selection with) labeled link text.
        chain
          .insertContent({
            type: "text",
            text,
            marks: [{ type: "link", attrs: { href, target, rel } }],
          })
          .run();
      } else {
        chain.setLink({ href, target, rel }).run();
      }
    }
    closeModal();
  };

  const onModalKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") applyModal();
    if (e.key === "Escape") closeModal();
  };

  return (
    <div className="w-11 shrink-0 border-r border-border bg-surface relative">
      {/* Scroll lives on this inner column so the URL popover (a sibling
          below) can overflow the 44px rail without being clipped. Putting
          overflow-y on the rail itself forces overflow-x:auto too, which
          trapped the popover inside the rail and ran it off-screen. */}
      <div className="h-full flex flex-col items-center py-2 gap-0.5 overflow-y-auto">
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

      {/* Link + image open a centered insert modal */}
      <button
        title={states?.link ? "Remove link" : "Link"}
        onClick={openLink}
        className={btnClass(!!states?.link)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 12a4 4 0 0 0 6 0l2.5-2.5a4 4 0 0 0-5.5-5.5L11 5" />
          <path d="M15 12a4 4 0 0 0-6 0L6.5 14.5a4 4 0 0 0 5.5 5.5L13 19" />
        </svg>
      </button>
      <button title="Image" onClick={openImage} className={btnClass(false)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2.5" />
          <circle cx="8.5" cy="8.5" r="1.6" />
          <path d="M21 15l-4.5-4.5L5 21" />
        </svg>
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
      </div>

      {modal && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50"
          onMouseDown={closeModal}
        >
          <div
            className="w-[340px] rounded-xl border border-border shadow-2xl p-4"
            style={{ background: "var(--surface-2)" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-medium text-foreground mb-3">
              {modal === "link" ? "Insert link" : "Insert image"}
            </div>

            <label className="block text-[11px] text-muted mb-1">
              {modal === "link" ? "URL" : "Image URL"}
            </label>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={onModalKey}
              placeholder={modal === "link" ? "https://…" : "https://…/image.png"}
              className="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-foreground outline-none focus:border-foreground/40"
            />

            <label className="block text-[11px] text-muted mt-3 mb-1">
              {modal === "link" ? "Text" : "Alt text"}
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={onModalKey}
              placeholder={modal === "link" ? "Link text (optional)" : "Description (optional)"}
              className="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-foreground outline-none focus:border-foreground/40"
            />

            {modal === "link" && (
              <label className="flex items-center gap-2 mt-3 text-[12px] text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newTab}
                  onChange={(e) => setNewTab(e.target.checked)}
                  className="accent-foreground"
                />
                Open in new tab
              </label>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={closeModal}
                className="text-[12px] px-3 py-1.5 rounded-md text-muted hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={applyModal}
                className="text-[12px] px-3 py-1.5 rounded-md bg-accent text-foreground hover:opacity-90 transition-opacity"
              >
                Insert
              </button>
            </div>
          </div>
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
