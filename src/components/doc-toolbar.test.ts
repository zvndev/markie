import { describe, expect, it, vi } from "vitest";
import { docToolbarState } from "./doc-toolbar";
import type { Editor } from "@tiptap/react";

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
