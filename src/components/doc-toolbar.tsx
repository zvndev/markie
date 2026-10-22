import type { ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { clearFormatting, promptForLink } from "@/lib/rich-keymap";
import { clampFontSize, fontStack, type DocAppearance } from "@/lib/doc-appearance";
import type { FormattingAction } from "@/lib/format-controls";
import { FormattingToolbar } from "./formatting-toolbar";

interface DocToolbarProps {
  editor: Editor | null;
  appearance: DocAppearance;
  onAppearance: (next: DocAppearance) => void;
  onPrint?: () => void;
  /** Open this document's version history. Absent where there is no document. */
  onHistory?: () => void;
  startControls?: ReactNode;
  // Viewers get the appearance controls and nothing that would edit the text.
  canEdit: boolean;
}

// Markdown has no syntax for underline, colour, highlight or alignment, so
// these write inline HTML. Said once, in the tooltip of each, rather than
// hidden: a document that uses them stops round-tripping byte for byte, and
// that is worth knowing before you reach for one.
const WRITES_HTML = "Saved as HTML in the file";

// The toolbar's whole reading of the document, as a pure function.
//
// Extracted from the selector so it can be proved without mounting TipTap:
// this is where a torn-down editor bites, and the crash it caused was only
// reachable through a real window.
export function docToolbarState(e: Editor | null) {
  // A destroyed editor is not a null one, and `!e` does not catch it.
  // Switching to the Source pane tears the rich editor down while this toolbar
  // still holds the reference; every accessor below reads through the view,
  // which is gone by then. e.can() threw
  //   TypeError: Cannot read properties of null (reading 'can')
  // and the error boundary took the whole app to the crash screen — so
  // pressing Cmd-F in the Source pane killed Markie and lost unsaved work.
  if (!e || e.isDestroyed) return null;
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
}

/** Shared by the compact toolbar and native formatting menus. */
export function executeDocToolbarAction(editor: Editor, action: FormattingAction): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  if (action === "link") { promptForLink(editor); return; }
  if (action === "clear") { clearFormatting(editor); return; }
  if (action === "image") {
    const url = window.prompt("Image URL");
    if (url) editor.chain().focus().setImage({ src: url }).run();
    return;
  }
  const chain = editor.chain().focus();
  switch (action) {
    case "undo": chain.undo().run(); break;
    case "redo": chain.redo().run(); break;
    case "bold": chain.toggleBold().run(); break;
    case "italic": chain.toggleItalic().run(); break;
    case "underline": chain.toggleUnderline().run(); break;
    case "strike": chain.toggleStrike().run(); break;
    case "code": chain.toggleCode().run(); break;
    case "bullet": chain.toggleBulletList().run(); break;
    case "ordered": chain.toggleOrderedList().run(); break;
    case "task": chain.toggleTaskList().run(); break;
    case "align-left": chain.setTextAlign("left").run(); break;
    case "align-center": chain.setTextAlign("center").run(); break;
    case "align-right": chain.setTextAlign("right").run(); break;
  }
}

export function setDocToolbarStyle(editor: Editor, id: string): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  if (!["paragraph", "quote", "code", "h1", "h2", "h3"].includes(id)) return;
  const chain = editor.chain().focus();
  if (id === "paragraph") chain.setParagraph().run();
  else if (id === "quote") chain.toggleBlockquote().run();
  else if (id === "code") chain.toggleCodeBlock().run();
  else chain.toggleHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
}

export function DocToolbar({
  editor,
  appearance,
  onAppearance,
  onPrint,
  onHistory,
  startControls,
  canEdit,
}: DocToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => docToolbarState(e),
  });

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

  return <FormattingToolbar
    state={state} canEdit={canEdit} appearance={appearance} onAppearance={onAppearance}
    currentStyle={currentStyle} currentFont={selecting ? "" : appearance.fontFamily}
    selecting={selecting} currentSize={currentSize} onFont={setFont} onSize={setSize}
    onStyle={(id) => { if (editor && canEdit) setDocToolbarStyle(editor, id); }}
    onAction={(action) => { if (editor && canEdit) executeDocToolbarAction(editor, action); }}
    serializationHint={WRITES_HTML}
    onColor={(color) => {
      if (!editor || editor.isDestroyed || !canEdit) return;
      const chain = editor.chain().focus();
      if (color) chain.setColor(color).run(); else chain.unsetColor().run();
    }}
    onHighlight={(color) => {
      if (!editor || editor.isDestroyed || !canEdit) return;
      const chain = editor.chain().focus();
      if (color) chain.setHighlight({ color }).run(); else chain.unsetHighlight().run();
    }}
    onPrint={onPrint} onHistory={onHistory} startControls={startControls}
  />;
}
