import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { docToolbarState, DocToolbar, executeDocToolbarAction, setDocToolbarStyle } from "./doc-toolbar";
import { DEFAULT_APPEARANCE } from "@/lib/doc-appearance";
import type { Editor } from "@tiptap/react";
import { Editor as RichEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";

// The toolbar reads the document through a live TipTap editor. The pane switch
// destroys that editor while the toolbar still holds the reference, and every
// accessor here reads through a view that is gone by then.

function liveEditor(overrides: Partial<Record<string, unknown>> = {}): Editor {
  return {
    isDestroyed: false,
    isActive: vi.fn(() => false),
    state: { selection: { empty: true } },
    can: () => ({ undo: () => true, redo: () => false }),
    ...overrides,
  } as unknown as Editor;
}

// What @tiptap/core actually leaves behind after destroy(): isDestroyed flips
// true and the accessors below throw rather than return anything.
function destroyedEditor(): Editor {
  const dead = () => {
    throw new TypeError("Cannot read properties of null (reading 'can')");
  };
  return {
    isDestroyed: true,
    isActive: dead,
    can: dead,
    get state(): never {
      return dead();
    },
  } as unknown as Editor;
}

describe("docToolbarState", () => {
  it("reads the document from a live editor", () => {
    const state = docToolbarState(liveEditor());
    expect(state).not.toBeNull();
    expect(state?.canUndo).toBe(true);
    expect(state?.canRedo).toBe(false);
    expect(state?.hasSelection).toBe(false);
  });

  it("returns null for no editor at all", () => {
    expect(docToolbarState(null)).toBeNull();
  });

  it("returns null for a destroyed editor instead of throwing", () => {
    // Switching to the Source pane destroys the rich editor. The next render of
    // the toolbar ran this selector against the corpse, e.can() threw, and the
    // error boundary replaced Markie with the crash screen — so pressing ⌘F in
    // the Source pane killed the app and took unsaved changes with it.
    // `!e` never caught this: a destroyed editor is an object, not null.
    expect(() => docToolbarState(destroyedEditor())).not.toThrow();
    expect(docToolbarState(destroyedEditor())).toBeNull();
  });

  it("never touches the editor once it is destroyed", () => {
    // Not just "does not throw": it must not read through the dead view at all,
    // because what a torn-down editor does on access is not ours to rely on.
    const isActive = vi.fn(() => false);
    const can = vi.fn(() => ({ undo: () => true, redo: () => true }));
    docToolbarState({ isDestroyed: true, isActive, can } as unknown as Editor);
    expect(isActive).not.toHaveBeenCalled();
    expect(can).not.toHaveBeenCalled();
  });
});

describe("page width control", () => {
  it("steps the width up from the default when Wider is clicked", () => {
    const onAppearance = vi.fn();
    render(
      <DocToolbar
        editor={null}
        appearance={DEFAULT_APPEARANCE}
        onAppearance={onAppearance}
        onPrint={() => {}}
        canEdit
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Wider" }));

    expect(onAppearance).toHaveBeenCalledWith({ ...DEFAULT_APPEARANCE, width: "900" });
  });
});

describe("Markdown formatting adapter", () => {
  it("omits unavailable print instead of exposing a no-op action", () => {
    render(<DocToolbar editor={null} appearance={DEFAULT_APPEARANCE} onAppearance={vi.fn()} canEdit />);
    expect(screen.queryByRole("button", { name: "Print" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Document formatting" })).toBeInTheDocument();
  });

  it("shares real formatting behavior with native menus and refuses read-only or destroyed targets", () => {
    const editor = new RichEditor({ extensions: [StarterKit], content: "<p>Original text</p>" });
    try {
      editor.commands.setTextSelection({ from: 1, to: 9 });
      executeDocToolbarAction(editor, "bold");
      expect(editor.isActive("bold")).toBe(true);
      setDocToolbarStyle(editor, "h3");
      expect(editor.isActive("heading", { level: 3 })).toBe(true);
      const before = editor.getHTML();
      setDocToolbarStyle(editor, "not-a-style");
      expect(editor.getHTML()).toBe(before);
      editor.setEditable(false);
      executeDocToolbarAction(editor, "italic");
      setDocToolbarStyle(editor, "paragraph");
      expect(editor.getHTML()).toBe(before);
    } finally { editor.destroy(); }
    expect(() => executeDocToolbarAction(editor, "bold")).not.toThrow();
    expect(() => setDocToolbarStyle(editor, "h1")).not.toThrow();
  });

  it("keeps viewing font and size changes out of Markdown with no text selected", () => {
    const editor = new RichEditor({ extensions: [StarterKit, TextStyle, FontFamily, FontSize], content: "<p>Original text</p>" });
    const onAppearance = vi.fn();
    const { unmount } = render(<DocToolbar editor={editor} appearance={DEFAULT_APPEARANCE} onAppearance={onAppearance} onPrint={() => {}} canEdit />);
    try {
      fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "georgia" } });
      fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "100" } });
      expect(onAppearance.mock.calls).toEqual([
        [{ ...DEFAULT_APPEARANCE, fontFamily: "georgia" }], [{ ...DEFAULT_APPEARANCE, fontSize: 32 }],
      ]);
      expect(editor.getHTML()).toBe("<p>Original text</p>");
    } finally { unmount(); editor.destroy(); }
  });

  it("routes selected text changes through the real TipTap editor and retains Markdown's serialization warning", () => {
    const editor = new RichEditor({ extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize], content: "<p>Original text</p>" });
    const onAppearance = vi.fn();
    const { unmount } = render(<DocToolbar editor={editor} appearance={DEFAULT_APPEARANCE} onAppearance={onAppearance} onPrint={() => {}} canEdit />);
    try {
      act(() => { editor.commands.setTextSelection({ from: 1, to: 9 }); });
      expect(screen.getByRole("combobox", { name: "Font" }).title).toContain("Saved as HTML in the file");
      fireEvent.click(screen.getByRole("button", { name: "Bold" }));
      expect(editor.isActive("bold")).toBe(true);
      fireEvent.change(screen.getByRole("combobox", { name: "Font" }), { target: { value: "georgia" } });
      fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "100" } });
      fireEvent.change(screen.getByRole("combobox", { name: "Text colour" }), { target: { value: "#dc2626" } });
      expect(editor.getAttributes("textStyle")).toMatchObject({ fontFamily: "Georgia, Charter, serif", fontSize: "32px", color: "#dc2626" });
      expect(onAppearance).not.toHaveBeenCalled();
      fireEvent.change(screen.getByRole("combobox", { name: "Paragraph style" }), { target: { value: "h2" } });
      expect(editor.isActive("heading", { level: 2 })).toBe(true);
    } finally { unmount(); editor.destroy(); }
  });
});
