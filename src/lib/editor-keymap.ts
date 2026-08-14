// Keeps the source editor from stealing shortcuts the application owns.
//
// CodeMirror's default keymaps and the app's global keydown handler both run:
// preventDefault in the editor does not stop the event bubbling to window, so a
// key bound on both sides fires twice. For Mod-/ that meant the shortcuts
// dialog opened *and* the current line was silently wrapped in <!-- -->.

// Shortcuts handled globally in src/app/page.tsx.
export const APP_OWNED_SHORTCUTS = [
  "Mod-o",
  "Mod-1",
  "Mod-2",
  "Mod-3",
  "Mod-s",
  "Mod-Shift-s",
  "Mod-k",
  "Mod-l",
  "Mod-n",
  "Mod-/",
  "Mod-Shift-e",
  "Mod-Alt-t",
  // Find is the app's, not CodeMirror's. Both panes search through one bar, so
  // the editor's own search panel must never open: two search UIs with two
  // option sets and two match counts is worse than either alone.
  "Mod-f",
  "Mod-g",
  "Mod-Shift-g",
] as const;

// Keys bound by @codemirror/commands (defaultKeymap, historyKeymap) and
// @codemirror/search. Listed explicitly so a dependency bump that adds a
// binding is caught by the test instead of by a user losing text.
export const CODEMIRROR_BOUND_KEYS = [
  "Mod-[",
  "Mod-]",
  "Mod-/",
  "Mod-a",
  "Mod-i",
  "Mod-u",
  "Mod-Shift-u",
  "Mod-y",
  "Mod-z",
  "Mod-Shift-z",
  "Mod-Enter",
  "Mod-Backspace",
  "Mod-Delete",
  "Mod-Home",
  "Mod-End",
  "Mod-ArrowLeft",
  "Mod-ArrowRight",
  "Mod-Alt-\\",
  "Mod-Alt-ArrowUp",
  // @codemirror/search
  "Mod-d",
  "Mod-f",
  "Mod-g",
  "Mod-Shift-g",
  "Mod-Shift-l",
  "Mod-Alt-g",
] as const;

export function normalizeShortcut(key: string): string {
  return key.trim().toLowerCase();
}

// App shortcuts the editor would also consume. The editor neutralizes exactly
// these, leaving editor-only bindings (Mod-f find, Mod-z undo, …) intact.
export function conflictingShortcuts(
  appShortcuts: readonly string[] = APP_OWNED_SHORTCUTS,
  codemirrorKeys: readonly string[] = CODEMIRROR_BOUND_KEYS
): string[] {
  const bound = new Set(codemirrorKeys.map(normalizeShortcut));
  return appShortcuts.filter((key) => bound.has(normalizeShortcut(key)));
}
