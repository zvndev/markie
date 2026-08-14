import { describe, expect, it } from "vitest";
import {
  APP_OWNED_SHORTCUTS,
  CODEMIRROR_BOUND_KEYS,
  conflictingShortcuts,
  normalizeShortcut,
} from "./editor-keymap";

describe("editor / app keybinding conflicts", () => {
  it("treats Mod- and Cmd- spellings as the same shortcut", () => {
    expect(normalizeShortcut("Mod-/")).toBe(normalizeShortcut("mod-/"));
    expect(normalizeShortcut("Mod-Shift-S")).toBe(normalizeShortcut("mod-shift-s"));
  });

  it("flags Mod-/ , which CodeMirror binds to toggleComment", () => {
    // Regression: pressing the app's documented Help shortcut with the cursor
    // in the editor opened the shortcuts dialog AND silently wrapped the
    // current line in <!-- -->, so users lost text without noticing.
    expect(conflictingShortcuts()).toContain("Mod-/");
  });

  it("reports every app shortcut CodeMirror would also consume", () => {
    const conflicts = conflictingShortcuts();
    for (const key of conflicts) {
      expect(APP_OWNED_SHORTCUTS).toContain(key);
      expect(CODEMIRROR_BOUND_KEYS.map(normalizeShortcut)).toContain(
        normalizeShortcut(key)
      );
    }
  });

  it("finds no conflict for shortcuts CodeMirror leaves alone", () => {
    expect(conflictingShortcuts(["Mod-9"], ["Mod-/"])).toEqual([]);
  });

  it("takes the find keys away from CodeMirror", () => {
    // Find is the app's. Both panes search through one bar, and CodeMirror's
    // own panel opening on top of it would give the source pane a second
    // search box with its own options and its own match count.
    for (const key of ["Mod-f", "Mod-g", "Mod-Shift-g"]) {
      expect(APP_OWNED_SHORTCUTS).toContain(key);
      expect(conflictingShortcuts()).toContain(key);
    }
  });

  it("keeps editor-only bindings the app has no opinion about", () => {
    // Undo belongs to whichever editor has focus; the app must not take it.
    expect(APP_OWNED_SHORTCUTS).not.toContain("Mod-z");
    expect(conflictingShortcuts()).not.toContain("Mod-z");
  });
});
