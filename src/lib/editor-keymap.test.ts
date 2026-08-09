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

  it("keeps editor-only bindings such as Mod-f available", () => {
    // Find/replace inside the source editor is CodeMirror's and must survive:
    // the app deliberately does not bind Mod-f.
    expect(APP_OWNED_SHORTCUTS).not.toContain("Mod-f");
    expect(conflictingShortcuts()).not.toContain("Mod-f");
  });
});
