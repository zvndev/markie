"use client";

import { type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { clearFormatting, promptForLink } from "@/lib/rich-keymap";
import { controlTitle } from "@/lib/toolbar-shortcuts";
import {
  clampFontSize,
  DOC_FONTS,
  fontStack,
  stepZoom,
  zoomLabel,
  type DocAppearance,
} from "@/lib/doc-appearance";

interface DocToolbarProps {
  editor: Editor | null;
  appearance: DocAppearance;
  onAppearance: (next: DocAppearance) => void;
  onPrint: () => void;
  // Viewers get the appearance controls and nothing that would edit the text.
  canEdit: boolean;
}

// Markdown has no syntax for underline, colour, highlight or alignment, so
// these write inline HTML. Said once, in the tooltip of each, rather than
// hidden: a document that uses them stops round-tripping byte for byte, and
// that is worth knowing before you reach for one.
const WRITES_HTML = "Saved as HTML in the file";

// A small, deliberately short palette. A full colour wheel in a markdown editor
// invites documents nobody can read in a plain-text diff.
const TEXT_COLOURS = [
  { label: "Default", value: null },
  { label: "Grey", value: "#6b7280" },
  { label: "Red", value: "#dc2626" },
  { label: "Orange", value: "#ea580c" },
  { label: "Green", value: "#16a34a" },
  { label: "Blue", value: "#2563eb" },
  { label: "Purple", value: "#7c3aed" },
];

const HIGHLIGHTS = [
  { label: "None", value: null },
  { label: "Yellow", value: "#fef08a" },
  { label: "Green", value: "#bbf7d0" },
  { label: "Blue", value: "#bfdbfe" },
  { label: "Pink", value: "#fbcfe8" },
  { label: "Orange", value: "#fed7aa" },
];

const Icon = ({
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

function Divider() {
  return <span aria-hidden="true" className="w-px h-5 bg-border mx-1 shrink-0" />;
}

function TButton({
  onClick,
  title,
  active,
  disabled,
  label,
  children,
}: {
  onClick?: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={`h-7 min-w-7 px-1.5 rounded flex items-center justify-center shrink-0 transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      } disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted`}
    >
      {children}
    </button>
  );
}

const BLOCK_STYLES = [
  { id: "paragraph", label: "Normal text" },
  { id: "h1", label: "Heading 1" },
  { id: "h2", label: "Heading 2" },
  { id: "h3", label: "Heading 3" },
  { id: "quote", label: "Quote" },
  { id: "code", label: "Code block" },
] as const;

export function DocToolbar({
  editor,
  appearance,
  onAppearance,
  onPrint,
  canEdit,
}: DocToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      return {
        bold: e.isActive("bold"),
        italic: e.isActive("italic"),
        underline: e.isActive("underline"),
        highlight: e.isActive("highlight"),
        alignLeft: e.isActive({ textAlign: "left" }),
        alignCenter: e.isActive({ textAlign: "center" }),
        alignRight: e.isActive({ textAlign: "right" }),
        // An empty selection means "apply to the document"; a real one means
        // "apply to this". The toolbar has to know which before it acts.
        hasSelection: !e.state.selection.empty,
        strike: e.isActive("strike"),
        code: e.isActive("code"),
        bullet: e.isActive("bulletList"),
        ordered: e.isActive("orderedList"),
        task: e.isActive("taskList"),
        quote: e.isActive("blockquote"),
        codeBlock: e.isActive("codeBlock"),
        h1: e.isActive("heading", { level: 1 }),
        h2: e.isActive("heading", { level: 2 }),
        h3: e.isActive("heading", { level: 3 }),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  const run = (fn: (e: Editor) => void) => () => {
    if (editor && canEdit) fn(editor);
  };

  const currentStyle = state?.h1
    ? "h1"
    : state?.h2
      ? "h2"
      : state?.h3
        ? "h3"
        : state?.quote
          ? "quote"
          : state?.codeBlock
            ? "code"
            : "paragraph";

  // With text selected the controls act on it; with nothing selected they act
  // on the document, which is the setting stored beside the file.
  const selecting = !!state?.hasSelection && canEdit;

  const selectionSize = editor?.getAttributes("textStyle")?.fontSize as
    | string
    | undefined;
  const currentSize = selecting
    ? clampFontSize(parseFloat(selectionSize ?? "") || appearance.fontSize)
    : appearance.fontSize;

  const setFont = (id: string) => {
    if (!id) return;
    if (selecting && editor) {
      editor.chain().focus().setFontFamily(fontStack(id)).run();
    } else {
      onAppearance({ ...appearance, fontFamily: id });
    }
  };

  const setSize = (next: number) => {
    const size = clampFontSize(next);
    if (selecting && editor) {
      editor.chain().focus().setFontSize(`${size}px`).run();
    } else {
      onAppearance({ ...appearance, fontSize: size });
    }
  };

  const setStyle = (id: string) => {
    if (!editor || !canEdit) return;
    const chain = editor.chain().focus();
    if (id === "paragraph") chain.setParagraph().run();
    else if (id === "quote") chain.toggleBlockquote().run();
    else if (id === "code") chain.toggleCodeBlock().run();
    else chain.toggleHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
  };

  return (
    <div
      data-markie-doc-toolbar
      role="toolbar"
      aria-label="Document formatting"
      className="markie-doc-toolbar flex items-center gap-0.5 px-2 py-1 border-b border-border overflow-x-auto"
      style={{ background: "var(--surface)" }}
    >
      {/* The conventional curved arrows: a hook back on itself, not the
          circular refresh glyph they read as before. */}
      <TButton
        onClick={run((e) => e.chain().focus().undo().run())}
        title={controlTitle("undo", "Undo")}
        label="Undo"
        disabled={!canEdit || !state?.canUndo}
      >
        <Icon><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().redo().run())}
        title={controlTitle("redo", "Redo")}
        label="Redo"
        disabled={!canEdit || !state?.canRedo}
      >
        <Icon><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></Icon>
      </TButton>
      <TButton onClick={onPrint} title={controlTitle("print", "Print")} label="Print">
        <Icon><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></Icon>
      </TButton>

      <Divider />

      {/* Zoom, font and size are ways of looking at the document. None of them
          touch a byte of it. */}
      <TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, -1) })}
        title={controlTitle("zoomOut", "Zoom out")}
        label="Zoom out"
      >
        <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M8 11h6" /></Icon>
      </TButton>
      <span className="text-[11px] text-muted tabular-nums w-[38px] text-center shrink-0">
        {zoomLabel(appearance.zoom)}
      </span>
      <TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, 1) })}
        title={controlTitle("zoomIn", "Zoom in")}
        label="Zoom in"
      >
        <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M11 8v6" /><path d="M8 11h6" /></Icon>
      </TButton>

      <Divider />

      <select
        value={currentStyle}
        onChange={(e) => setStyle(e.target.value)}
        disabled={!canEdit}
        aria-label="Paragraph style"
        title="Paragraph style"
        className="markie-overlay-field text-[11px] h-7 px-1.5 shrink-0 disabled:opacity-35"
      >
        {BLOCK_STYLES.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>

      {/* Font and size follow the selection when there is one, and the whole
          document when there is not. Selecting a word and restyling everything
          is not what any editor does. */}
      <select
        value={selecting ? "" : appearance.fontFamily}
        onChange={(e) => setFont(e.target.value)}
        aria-label="Font"
        title={
          selecting
            ? `Font for the selected text - ${WRITES_HTML}`
            : "Font for the whole document - a viewing preference, not saved into the file"
        }
        className="markie-overlay-field text-[11px] h-7 px-1.5 shrink-0"
      >
        {selecting && <option value="">Font…</option>}
        {DOC_FONTS.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>

      <TButton
        onClick={() => setSize(currentSize - 1)}
        title={selecting ? "Smaller selected text" : "Smaller text (whole document)"}
        label="Decrease font size"
        disabled={selecting && !canEdit}
      >
        <Icon><path d="M5 12h14" /></Icon>
      </TButton>
      <input
        type="number"
        value={currentSize}
        onChange={(e) => setSize(Number(e.target.value))}
        aria-label="Font size"
        title={
          selecting
            ? `Size of the selected text - ${WRITES_HTML}`
            : "Font size for the whole document"
        }
        className="markie-overlay-field text-[11px] h-7 w-[38px] text-center shrink-0 tabular-nums"
      />
      <TButton
        onClick={() => setSize(currentSize + 1)}
        title={selecting ? "Larger selected text" : "Larger text (whole document)"}
        label="Increase font size"
        disabled={selecting && !canEdit}
      >
        <Icon><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
      </TButton>

      <Divider />

      <TButton onClick={run((e) => e.chain().focus().toggleBold().run())} title={controlTitle("bold", "Bold")} label="Bold" active={state?.bold} disabled={!canEdit}>
        <span aria-hidden="true" className="text-[13px] font-bold">B</span>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleItalic().run())} title={controlTitle("italic", "Italic")} label="Italic" active={state?.italic} disabled={!canEdit}>
        <span aria-hidden="true" className="font-serif text-[13px] italic">I</span>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().toggleUnderline().run())}
        title={controlTitle("underline", "Underline", { note: WRITES_HTML })}
        label="Underline"
        active={state?.underline}
        disabled={!canEdit}
      >
        <span aria-hidden="true" className="text-[13px] underline">U</span>
      </TButton>

      <label
        title={controlTitle("textColour", "Text colour", { note: WRITES_HTML })}
        className="h-7 px-1 rounded flex items-center gap-0.5 shrink-0 text-muted hover:text-foreground hover:bg-accent/40 cursor-pointer"
      >
        <span aria-hidden="true" className="text-[13px] font-semibold leading-none">A</span>
        <select
          value=""
          disabled={!canEdit}
          aria-label="Text colour"
          onChange={(e) => {
            const value = e.target.value;
            if (!editor || !canEdit) return;
            if (value) editor.chain().focus().setColor(value).run();
            else editor.chain().focus().unsetColor().run();
            e.target.value = "";
          }}
          className="bg-transparent text-[10px] w-[14px] outline-none appearance-none cursor-pointer disabled:opacity-35"
        >
          <option value="">▾</option>
          {TEXT_COLOURS.map((c) => (
            <option key={c.label} value={c.value ?? ""}>{c.label}</option>
          ))}
        </select>
      </label>

      <label
        title={controlTitle("highlight", "Highlight colour", { note: WRITES_HTML })}
        className="h-7 px-1 rounded flex items-center gap-0.5 shrink-0 text-muted hover:text-foreground hover:bg-accent/40 cursor-pointer"
      >
        <Icon><path d="m9 11-6 6v3h3l6-6" /><path d="M13 3 21 11l-6 6-8-8Z" /></Icon>
        <select
          value=""
          disabled={!canEdit}
          aria-label="Highlight colour"
          onChange={(e) => {
            const value = e.target.value;
            if (!editor || !canEdit) return;
            if (value) editor.chain().focus().setHighlight({ color: value }).run();
            else editor.chain().focus().unsetHighlight().run();
            e.target.value = "";
          }}
          className="bg-transparent text-[10px] w-[14px] outline-none appearance-none cursor-pointer disabled:opacity-35"
        >
          <option value="">▾</option>
          {HIGHLIGHTS.map((c) => (
            <option key={c.label} value={c.value ?? ""}>{c.label}</option>
          ))}
        </select>
      </label>
      <TButton onClick={run((e) => e.chain().focus().toggleStrike().run())} title={controlTitle("strike", "Strikethrough")} label="Strikethrough" active={state?.strike} disabled={!canEdit}>
        <Icon><path d="M5 12h14" /><path d="M9.5 9.2c0-2 1.6-3.7 4.1-3.7 1.2 0 2.3.3 3 .8" /><path d="M15.5 14.4c.8.4 1.2 1 1.2 1.8 0 1.5-1.5 2.5-3.8 2.5-1.5 0-2.8-.4-3.8-1.1" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleCode().run())} title={controlTitle("code", "Inline code")} label="Inline code" active={state?.code} disabled={!canEdit}>
        <Icon><path d="m9 18-6-6 6-6" /><path d="m15 6 6 6-6 6" /></Icon>
      </TButton>

      <Divider />

      <TButton
        onClick={run((e) => promptForLink(e))}
        title={controlTitle("link", "Insert link")}
        label="Insert link"
        disabled={!canEdit}
      >
        <Icon><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => {
          const url = window.prompt("Image URL");
          if (url) e.chain().focus().setImage({ src: url }).run();
        })}
        title={controlTitle("image", "Insert image")}
        label="Insert image"
        disabled={!canEdit}
      >
        <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Icon>
      </TButton>

      <Divider />

      <TButton onClick={run((e) => e.chain().focus().toggleBulletList().run())} title={controlTitle("bullet", "Bullet list")} label="Bullet list" active={state?.bullet} disabled={!canEdit}>
        <Icon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleOrderedList().run())} title={controlTitle("ordered", "Numbered list")} label="Numbered list" active={state?.ordered} disabled={!canEdit}>
        <Icon><path d="M10 6h11" /><path d="M10 12h11" /><path d="M10 18h11" /><path d="M4 6h1v4" /><path d="M4 10h2" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleTaskList().run())} title={controlTitle("task", "Task list")} label="Task list" active={state?.task} disabled={!canEdit}>
        <Icon><rect x="3" y="5" width="5" height="5" rx="1" /><path d="m4.2 7.5 1.2 1.2 2-2.3" /><path d="M11 7.5h10" /><rect x="3" y="14" width="5" height="5" rx="1" /><path d="M11 16.5h10" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().setTextAlign("left").run())}
        title={controlTitle("alignLeft", "Align left", { note: WRITES_HTML })}
        label="Align left"
        active={state?.alignLeft}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h15" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().setTextAlign("center").run())}
        title={controlTitle("alignCenter", "Align centre", { note: WRITES_HTML })}
        label="Align centre"
        active={state?.alignCenter}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M6 12h12" /><path d="M5 18h14" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().setTextAlign("right").run())}
        title={controlTitle("alignRight", "Align right", { note: WRITES_HTML })}
        label="Align right"
        active={state?.alignRight}
        disabled={!canEdit}
      >
        <Icon><path d="M3 6h18" /><path d="M9 12h12" /><path d="M6 18h15" /></Icon>
      </TButton>

      <Divider />

      <TButton
        onClick={run((e) => clearFormatting(e))}
        title={controlTitle("clearFormat", "Clear formatting")}
        label="Clear formatting"
        disabled={!canEdit}
      >
        <Icon><path d="m16 16 5-5" /><path d="m21 16-5-5" /><path d="m3 19 6.5-6.5" /><path d="m13 3 8 8" /><path d="M3 19h8" /></Icon>
      </TButton>
    </div>
  );
}
