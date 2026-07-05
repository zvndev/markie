"use client";

import { useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

interface FormatRailProps {
  editor: Editor | null;
}

interface RailButton {
  key: string;
  label: ReactNode;
  title: string;
  run: (editor: Editor) => void;
  active?: (s: ActiveStates) => boolean;
}

type ActiveStates = Record<string, boolean>;

const RailIcon = ({
  children,
  strokeWidth = 1.8,
}: {
  children: ReactNode;
  strokeWidth?: number;
}) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const textMark = (children: ReactNode, className = "") => (
  <span aria-hidden="true" className={className}>
    {children}
  </span>
);

const COMMON: RailButton[] = [
  { key: "h1", label: textMark("H1", "font-semibold tracking-normal"), title: "Heading 1", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (s) => s.h1 },
  { key: "h2", label: textMark("H2", "font-semibold tracking-normal"), title: "Heading 2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (s) => s.h2 },
  { key: "h3", label: textMark("H3", "font-semibold tracking-normal"), title: "Heading 3", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (s) => s.h3 },
  { key: "bold", label: textMark("B", "text-[13px] font-black"), title: "Bold (⌘B)", run: (e) => e.chain().focus().toggleBold().run(), active: (s) => s.bold },
  { key: "italic", label: textMark("I", "font-serif text-[14px] italic"), title: "Italic (⌘I)", run: (e) => e.chain().focus().toggleItalic().run(), active: (s) => s.italic },
  { key: "strike", label: <RailIcon><path d="M7 5.5h10" /><path d="M8.5 18.5h7" /><path d="M5 12h14" /><path d="M9.5 9.2c0-2 1.6-3.7 4.1-3.7 1.2 0 2.3.3 3 .8" /><path d="M15.5 14.4c.8.4 1.2 1 1.2 1.8 0 1.5-1.5 2.5-3.8 2.5-1.5 0-2.8-.4-3.8-1.1" /></RailIcon>, title: "Strikethrough", run: (e) => e.chain().focus().toggleStrike().run(), active: (s) => s.strike },
  { key: "code", label: <RailIcon><path d="m9 18-6-6 6-6" /><path d="m15 6 6 6-6 6" /></RailIcon>, title: "Inline code", run: (e) => e.chain().focus().toggleCode().run(), active: (s) => s.code },
  { key: "bullet", label: <RailIcon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></RailIcon>, title: "Bullet list", run: (e) => e.chain().focus().toggleBulletList().run(), active: (s) => s.bulletList },
  { key: "ordered", label: <RailIcon><path d="M10 6h11" /><path d="M10 12h11" /><path d="M10 18h11" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M3.8 14.5c.3-.6.9-1 1.7-1 .9 0 1.5.5 1.5 1.3 0 .7-.4 1.1-1 1.5L4 18h3" /></RailIcon>, title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (s) => s.orderedList },
  { key: "task", label: <RailIcon><rect x="3" y="5" width="5" height="5" rx="1" /><path d="m4.2 7.5 1.2 1.2 2-2.3" /><path d="M11 7.5h10" /><rect x="3" y="14" width="5" height="5" rx="1" /><path d="M11 16.5h10" /></RailIcon>, title: "Task list", run: (e) => e.chain().focus().toggleTaskList().run(), active: (s) => s.taskList },
  { key: "quote", label: <RailIcon><path d="M8 8H5.8C4.8 8 4 8.8 4 9.8V12h4v5H3V9.8C3 7.7 4.7 6 6.8 6H8v2Z" /><path d="M19 8h-2.2C15.8 8 15 8.8 15 9.8V12h4v5h-5V9.8C14 7.7 15.7 6 17.8 6H19v2Z" /></RailIcon>, title: "Blockquote", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (s) => s.blockquote },
  { key: "codeblock", label: <RailIcon><path d="M8 4H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" /></RailIcon>, title: "Code block", run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (s) => s.codeBlock },
  { key: "table", label: <RailIcon><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M9 4v16" /><path d="M15 4v16" /></RailIcon>, title: "Insert table", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: (s) => s.table },
  { key: "hr", label: <RailIcon><path d="M5 12h14" /></RailIcon>, title: "Horizontal rule", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

const ADVANCED: RailButton[] = [
  { key: "mathi", label: textMark("Σ", "text-[14px] font-semibold"), title: "Inline math ($…$)", run: (e) => e.chain().focus().insertContent("$E = mc^2$").run() },
  { key: "mathb", label: textMark("∫", "text-[15px] font-semibold"), title: "Math block ($$…$$)", run: (e) => e.chain().focus().insertContent("\n$$\nE = mc^2\n$$\n").run() },
  { key: "footnote", label: textMark("†", "text-[14px] font-semibold"), title: "Footnote", run: (e) => e.chain().focus().insertContent("[^1]").run() },
  { key: "clear", label: <RailIcon><path d="m16 16 5-5" /><path d="m21 16-5-5" /><path d="m3 19 6.5-6.5" /><path d="m13 3 8 8" /><path d="m9.5 12.5 4-4" /><path d="M3 19h8" /></RailIcon>, title: "Clear formatting", run: (e) => e.chain().focus().unsetAllMarks().clearNodes().run() },
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
    `w-8 h-7 flex items-center justify-center rounded-md text-[11px] transition-all select-none ${
      active
        ? "bg-accent text-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)]"
        : "text-muted hover:text-foreground hover:bg-accent/45"
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
          aria-label={b.title}
          onClick={() => b.run(editor)}
          className={btnClass(b.active ? !!(states && b.active(states)) : false)}
        >
          {b.label}
        </button>
      ))}

      {/* Link + image open a centered insert modal */}
      <button
        title={states?.link ? "Remove link" : "Link"}
        aria-label={states?.link ? "Remove link" : "Insert link"}
        onClick={openLink}
        className={btnClass(!!states?.link)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 12a4 4 0 0 0 6 0l2.5-2.5a4 4 0 0 0-5.5-5.5L11 5" />
          <path d="M15 12a4 4 0 0 0-6 0L6.5 14.5a4 4 0 0 0 5.5 5.5L13 19" />
        </svg>
      </button>
      <button title="Image" aria-label="Insert image" onClick={openImage} className={btnClass(false)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2.5" />
          <circle cx="8.5" cy="8.5" r="1.6" />
          <path d="M21 15l-4.5-4.5L5 21" />
        </svg>
      </button>

      <div className="flex-1" />

      <button
        title={showAdvanced ? "Hide advanced tools" : "Advanced tools"}
        aria-label={showAdvanced ? "Hide advanced tools" : "Advanced tools"}
        onClick={() => setShowAdvanced((v) => !v)}
        className={btnClass(showAdvanced)}
      >
        <RailIcon><path d="M5 12h.01" /><path d="M12 12h.01" /><path d="M19 12h.01" /></RailIcon>
      </button>
      {showAdvanced &&
        ADVANCED.map((b) => (
          <button
            key={b.key}
            title={b.title}
            aria-label={b.title}
            onClick={() => b.run(editor)}
            className={btnClass(false)}
          >
            {b.label}
          </button>
        ))}
      </div>

      {modal && (
        <div
          className="markie-scrim-strong fixed inset-0 z-[110] flex items-center justify-center"
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
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 bg-surface-2 border border-border rounded-lg shadow-xl px-2 py-1" style={{ background: "var(--surface-2)" }}>
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
