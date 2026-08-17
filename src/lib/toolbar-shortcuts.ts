// The one place that decides which keyboard shortcut each toolbar control may
// advertise.
//
// A tooltip that promises a key nothing delivers is worse than no tooltip: the
// user presses it, something else happens, and now they distrust the whole row.
// That is not hypothetical here. Electron menu accelerators are consumed by the
// menu before the web page ever sees the keystroke, so the moment the File menu
// claimed ⌘⇧E for "Export PDF", TipTap's align-centre binding became
// unreachable — while still looking bound from inside the editor.
//
// So: the menu's accelerators are declared here, the editor's bindings are
// declared here, and a control's tooltip is derived from the two. A conflict
// can only ever produce a missing shortcut, never a lying one.

// Written in TipTap's notation ("Mod" = ⌘ on macOS, Ctrl elsewhere) so both
// halves of the comparison speak the same language. Lower-cased on both sides
// before comparing, because "Mod-Shift-s" and "Mod-S" mean the same chord.
export const MENU_ACCELERATORS = [
  "Mod-,", // Preferences
  "Mod-n", // New
  "Mod-o", // Open
  "Mod-l", // Open library
  "Mod-s", // Save
  "Mod-Shift-s", // Save As
  "Mod-Shift-d", // Duplicate
  "Mod-Alt-r", // Reveal in Finder
  "Mod-z", // Undo
  "Mod-Shift-z", // Redo (macOS)
  "Mod-y", // Redo (Windows/Linux)
  "Mod-f", // Find
  "Mod-Alt-f", // Find and Replace
  "Mod-Alt-t", // Format Tables
  "Mod-1", // Rich text
  "Mod-2", // Source
  "Mod-3", // Split
  "Mod-k", // Command palette
  "Mod-/", // Keyboard shortcuts
  "Mod-Shift-i", // Statistics
  "Mod-p", // Print
  "Mod-=", // Zoom in
  "Mod--", // Zoom out
  "Mod-0", // Reset zoom
] as const;

// What actually toggles each control. Values are either bound by a TipTap
// extension (noted below) or by Markie itself; either way, pressing the key
// runs the command. Anything with no entry has no shortcut, which is a fine
// answer — text colour and highlight colour are pickers, not toggles.
export const CONTROL_KEYS: Record<string, string> = {
  bold: "Mod-b", // @tiptap/extension-bold
  italic: "Mod-i", // @tiptap/extension-italic
  underline: "Mod-u", // @tiptap/extension-underline
  strike: "Mod-Shift-x", // rebound by Markie: the extension default (Mod-Shift-s) is Save As
  code: "Mod-e", // @tiptap/extension-code
  highlight: "Mod-Shift-h", // @tiptap/extension-highlight
  bullet: "Mod-Shift-8", // @tiptap/extension-list
  ordered: "Mod-Shift-7", // @tiptap/extension-list
  task: "Mod-Shift-9", // @tiptap/extension-list
  alignLeft: "Mod-Shift-l", // @tiptap/extension-text-align
  alignCenter: "Mod-Shift-e", // @tiptap/extension-text-align
  alignRight: "Mod-Shift-r", // @tiptap/extension-text-align
  link: "Mod-Shift-k", // bound by Markie; ⌘K is the command palette
  clearFormat: "Mod-\\", // bound by Markie
  undo: "Mod-z", // Edit menu
  redo: "Mod-Shift-z", // Edit menu
  print: "Mod-p", // File menu
  zoomIn: "Mod-=", // View menu
  zoomOut: "Mod--", // View menu
};

// Accelerators the menu owns AND some control also claims. Anything listed
// here is a bug in one of the two tables, except for the entries Markie
// deliberately routes through the menu (undo, redo, print, zoom), which are the
// same command reached two ways rather than two commands fighting.
const MENU_ROUTED = new Set(["undo", "redo", "print", "zoomIn", "zoomOut"]);

// Modifiers read in a fixed order on macOS (⌃⌥⇧⌘) no matter how the chord was
// written, because that is the order every Mac menu prints them in.
const MAC_ORDER = ["ctrl", "alt", "shift", "mod"];

// Windows and Linux lead with the primary modifier instead: Ctrl+Shift+E.
const WIN_ORDER = ["mod", "ctrl", "alt", "shift"];

const MODIFIER_ALIASES: Record<string, string> = {
  mod: "mod",
  cmdorctrl: "mod",
  commandorcontrol: "mod",
  cmd: "mod",
  command: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
};

// Splits a chord into its modifiers and the key itself.
//
// Reads modifiers off the front rather than splitting on "-", because the key
// can *be* "-": zoom out is "Mod--", and naive splitting loses it entirely.
export function parseChord(key: string): { mods: Set<string>; key: string } {
  let rest = key.trim().toLowerCase();
  const mods = new Set<string>();
  for (;;) {
    const match = /^([a-z]+)-(?=.)/.exec(rest);
    const alias = match && MODIFIER_ALIASES[match[1]];
    if (!alias) break;
    mods.add(alias);
    rest = rest.slice(match[0].length);
  }
  return { mods, key: rest };
}

// One spelling per chord. "Shift+CmdOrCtrl+Z" and "Mod-Shift-z" are the same
// keystroke; without this they compare as different and a genuine collision
// reads as two unrelated shortcuts.
export function canonicalChord(key: string): string {
  const { mods, key: final } = parseChord(key);
  return [...MAC_ORDER.filter((m) => mods.has(m)), final].join("-");
}

// True when the menu would swallow this chord before the editor sees it.
export function isMenuReserved(key: string): boolean {
  const target = canonicalChord(key);
  return MENU_ACCELERATORS.some((a) => canonicalChord(a) === target);
}

// The shortcut a control may honestly advertise, or null when it has none.
export function effectiveShortcut(id: string): string | null {
  const key = CONTROL_KEYS[id];
  if (!key) return null;
  if (MENU_ROUTED.has(id)) return key;
  return isMenuReserved(key) ? null : key;
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
};

const WIN_NAMES: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
};

export function shortcutDisplay(key: string, platform: "mac" | "other" = "mac"): string {
  const { mods, key: final } = parseChord(key);
  const glyph = final.length === 1 ? final.toUpperCase() : final;

  if (platform === "mac") {
    return MAC_ORDER.filter((m) => mods.has(m)).map((m) => MAC_SYMBOLS[m]).join("") + glyph;
  }
  return [...WIN_ORDER.filter((m) => mods.has(m)).map((m) => WIN_NAMES[m] ?? m), glyph].join("+");
}

// The full tooltip: what the control does, how to reach it from the keyboard,
// and any warning it carries. Composed here so no caller can assemble one that
// contradicts the tables above.
export function controlTitle(
  id: string,
  label: string,
  options: { note?: string; platform?: "mac" | "other" } = {}
): string {
  const key = effectiveShortcut(id);
  const head = key ? `${label} (${shortcutDisplay(key, options.platform ?? "mac")})` : label;
  return options.note ? `${head} - ${options.note}` : head;
}
