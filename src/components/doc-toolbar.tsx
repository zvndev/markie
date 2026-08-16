"use client";

import { type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  clampFontSize,
  DOC_FONTS,
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

// Why a control is off, in the tooltip, rather than a disabled button that
// looks broken. Markdown has no syntax for any of these, and writing them would
// mean putting HTML into the user's file — which is the one thing Markie
// promises not to do.
const NOT_IN_MARKDOWN =
  "Markdown has no syntax for this. Adding it would write HTML into your file.";

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
      <TButton
        onClick={run((e) => e.chain().focus().undo().run())}
        title="Undo (⌘Z)"
        label="Undo"
        disabled={!canEdit || !state?.canUndo}
      >
        <Icon><path d="M3 7v6h6" /><path d="M3.5 13a9 9 0 1 0 2.6-6.4L3 9" /></Icon>
      </TButton>
      <TButton
        onClick={run((e) => e.chain().focus().redo().run())}
        title="Redo (⇧⌘Z)"
        label="Redo"
        disabled={!canEdit || !state?.canRedo}
      >
        <Icon><path d="M21 7v6h-6" /><path d="M20.5 13a9 9 0 1 1-2.6-6.4L21 9" /></Icon>
      </TButton>
      <TButton onClick={onPrint} title="Print (⌘P)" label="Print">
        <Icon><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" rx="1" /></Icon>
      </TButton>

      <Divider />

      {/* Zoom, font and size are ways of looking at the document. None of them
          touch a byte of it. */}
      <TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, -1) })}
        title="Zoom out"
        label="Zoom out"
      >
        <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M8 11h6" /></Icon>
      </TButton>
      <span className="text-[11px] text-muted tabular-nums w-[38px] text-center shrink-0">
        {zoomLabel(appearance.zoom)}
      </span>
      <TButton
        onClick={() => onAppearance({ ...appearance, zoom: stepZoom(appearance.zoom, 1) })}
        title="Zoom in"
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

      <select
        value={appearance.fontFamily}
        onChange={(e) => onAppearance({ ...appearance, fontFamily: e.target.value })}
        aria-label="Font"
        title="Font for this document — a viewing preference, not saved into the file"
        className="markie-overlay-field text-[11px] h-7 px-1.5 shrink-0"
      >
        {DOC_FONTS.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
      </select>

      <TButton
        onClick={() => onAppearance({ ...appearance, fontSize: clampFontSize(appearance.fontSize - 1) })}
        title="Smaller text"
        label="Decrease font size"
      >
        <Icon><path d="M5 12h14" /></Icon>
      </TButton>
      <input
        type="number"
        value={appearance.fontSize}
        onChange={(e) => onAppearance({ ...appearance, fontSize: clampFontSize(Number(e.target.value)) })}
        aria-label="Font size"
        title="Font size for this document"
        className="markie-overlay-field text-[11px] h-7 w-[38px] text-center shrink-0 tabular-nums"
      />
      <TButton
        onClick={() => onAppearance({ ...appearance, fontSize: clampFontSize(appearance.fontSize + 1) })}
        title="Larger text"
        label="Increase font size"
      >
        <Icon><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
      </TButton>

      <Divider />

      <TButton onClick={run((e) => e.chain().focus().toggleBold().run())} title="Bold (⌘B)" label="Bold" active={state?.bold} disabled={!canEdit}>
        <span aria-hidden="true" className="text-[13px] font-bold">B</span>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleItalic().run())} title="Italic (⌘I)" label="Italic" active={state?.italic} disabled={!canEdit}>
        <span aria-hidden="true" className="font-serif text-[13px] italic">I</span>
      </TButton>
      {/* The three Google Docs controls markdown cannot express. Shown, so the
          absence is explained rather than mysterious, and disabled, so the file
          stays what the user wrote. */}
      <TButton title={`Underline — ${NOT_IN_MARKDOWN}`} label="Underline (unavailable)" disabled>
        <span aria-hidden="true" className="text-[13px] underline">U</span>
      </TButton>
      <TButton title={`Text colour — ${NOT_IN_MARKDOWN}`} label="Text colour (unavailable)" disabled>
        <span aria-hidden="true" className="text-[13px] font-semibold">A</span>
      </TButton>
      <TButton title={`Highlight — ${NOT_IN_MARKDOWN}`} label="Highlight (unavailable)" disabled>
        <Icon><path d="m9 11-6 6v3h3l6-6" /><path d="m15 5 4 4" /><path d="M13 3 21 11l-6 6-8-8Z" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleStrike().run())} title="Strikethrough" label="Strikethrough" active={state?.strike} disabled={!canEdit}>
        <Icon><path d="M5 12h14" /><path d="M9.5 9.2c0-2 1.6-3.7 4.1-3.7 1.2 0 2.3.3 3 .8" /><path d="M15.5 14.4c.8.4 1.2 1 1.2 1.8 0 1.5-1.5 2.5-3.8 2.5-1.5 0-2.8-.4-3.8-1.1" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleCode().run())} title="Inline code" label="Inline code" active={state?.code} disabled={!canEdit}>
        <Icon><path d="m9 18-6-6 6-6" /><path d="m15 6 6 6-6 6" /></Icon>
      </TButton>

      <Divider />

      <TButton
        onClick={run((e) => {
          const url = window.prompt("Link URL");
          if (url) e.chain().focus().setLink({ href: url }).run();
        })}
        title="Insert link (⌘K)"
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
        title="Insert image"
        label="Insert image"
        disabled={!canEdit}
      >
        <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Icon>
      </TButton>

      <Divider />

      <TButton onClick={run((e) => e.chain().focus().toggleBulletList().run())} title="Bullet list" label="Bullet list" active={state?.bullet} disabled={!canEdit}>
        <Icon><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3.5 6h.01" /><path d="M3.5 12h.01" /><path d="M3.5 18h.01" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleOrderedList().run())} title="Numbered list" label="Numbered list" active={state?.ordered} disabled={!canEdit}>
        <Icon><path d="M10 6h11" /><path d="M10 12h11" /><path d="M10 18h11" /><path d="M4 6h1v4" /><path d="M4 10h2" /></Icon>
      </TButton>
      <TButton onClick={run((e) => e.chain().focus().toggleTaskList().run())} title="Task list" label="Task list" active={state?.task} disabled={!canEdit}>
        <Icon><rect x="3" y="5" width="5" height="5" rx="1" /><path d="m4.2 7.5 1.2 1.2 2-2.3" /><path d="M11 7.5h10" /><rect x="3" y="14" width="5" height="5" rx="1" /><path d="M11 16.5h10" /></Icon>
      </TButton>
      <TButton title={`Alignment — ${NOT_IN_MARKDOWN}`} label="Alignment (unavailable)" disabled>
        <Icon><path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h18" /></Icon>
      </TButton>

      <Divider />

      <TButton
        onClick={run((e) => e.chain().focus().unsetAllMarks().clearNodes().run())}
        title="Clear formatting"
        label="Clear formatting"
        disabled={!canEdit}
      >
        <Icon><path d="m16 16 5-5" /><path d="m21 16-5-5" /><path d="m3 19 6.5-6.5" /><path d="m13 3 8 8" /><path d="M3 19h8" /></Icon>
      </TButton>
    </div>
  );
}
