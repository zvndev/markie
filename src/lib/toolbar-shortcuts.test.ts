import { describe, expect, it } from "vitest";
import {
  CONTROL_KEYS,
  MENU_ACCELERATORS,
  canonicalChord,
  controlTitle,
  effectiveShortcut,
  isMenuReserved,
  shortcutDisplay,
} from "./toolbar-shortcuts";

describe("what a control may advertise", () => {
  it("gives the standard chord for the standard controls", () => {
    expect(effectiveShortcut("bold")).toBe("Mod-b");
    expect(effectiveShortcut("italic")).toBe("Mod-i");
    expect(effectiveShortcut("underline")).toBe("Mod-u");
    expect(effectiveShortcut("alignCenter")).toBe("Mod-Shift-e");
  });

  it("has no shortcut for controls that are pickers rather than toggles", () => {
    expect(effectiveShortcut("textColour")).toBeNull();
    expect(effectiveShortcut("image")).toBeNull();
  });

  // The whole reason this module exists.
  it("refuses to advertise a chord the menu would swallow first", () => {
    // Save As owns ⌘⇧S, so strikethrough may not claim it...
    expect(isMenuReserved("Mod-Shift-s")).toBe(true);
    // ...which is why strikethrough is bound to ⌘⇧X instead, and that is free.
    expect(CONTROL_KEYS.strike).toBe("Mod-Shift-x");
    expect(effectiveShortcut("strike")).toBe("Mod-Shift-x");
  });

  it("is case-insensitive about the chord, because Mod-S and Mod-Shift-s are one key", () => {
    expect(isMenuReserved("mod-shift-S")).toBe(true);
    expect(isMenuReserved("MOD-F")).toBe(true);
  });

  it("still advertises the shortcuts the menu itself runs", () => {
    // These are one command reached two ways, not two commands colliding.
    expect(effectiveShortcut("undo")).toBe("Mod-z");
    expect(effectiveShortcut("print")).toBe("Mod-p");
    expect(effectiveShortcut("zoomIn")).toBe("Mod-=");
  });

  it("keeps the link on ⌘⇧K because ⌘K is the command palette", () => {
    expect(isMenuReserved("Mod-k")).toBe(true);
    expect(effectiveShortcut("link")).toBe("Mod-Shift-k");
  });

  // A guard against the failure this module was written to prevent: someone
  // adds a menu accelerator later and a tooltip quietly starts lying.
  it("has no editor control claiming a chord the menu already owns", () => {
    const lying = Object.entries(CONTROL_KEYS)
      .filter(([id]) => !["undo", "redo", "print", "zoomIn", "zoomOut"].includes(id))
      .filter(([, key]) => isMenuReserved(key));
    expect(lying).toEqual([]);
  });

  it("has no two controls bound to the same chord", () => {
    const keys = Object.values(CONTROL_KEYS).map((k) => k.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares no accelerator twice in the menu table", () => {
    const keys = MENU_ACCELERATORS.map((k) => k.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("how a chord reads", () => {
  it("prints Mac modifiers in menu order regardless of how it was written", () => {
    expect(shortcutDisplay("Mod-Shift-e")).toBe("⇧⌘E");
    expect(shortcutDisplay("Shift-Mod-e")).toBe("⇧⌘E");
    expect(shortcutDisplay("Mod-b")).toBe("⌘B");
    expect(shortcutDisplay("Mod-Alt-Shift-x")).toBe("⌥⇧⌘X");
  });

  it("spells them out everywhere else", () => {
    expect(shortcutDisplay("Mod-Shift-e", "other")).toBe("Ctrl+Shift+E");
    expect(shortcutDisplay("Mod-b", "other")).toBe("Ctrl+B");
  });

  it("leaves non-letter keys alone", () => {
    expect(shortcutDisplay("Mod-\\")).toBe("⌘\\");
    expect(shortcutDisplay("Mod-Shift-8")).toBe("⇧⌘8");
  });

  // Zoom out is "Mod--": the key is itself a hyphen, so a chord cannot be
  // understood by splitting on hyphens.
  it("survives a chord whose key is the separator", () => {
    expect(shortcutDisplay("Mod--")).toBe("⌘-");
    expect(shortcutDisplay("Mod--", "other")).toBe("Ctrl+-");
    expect(canonicalChord("Mod--")).toBe("mod--");
    expect(canonicalChord("Mod--")).not.toBe(canonicalChord("Mod-="));
  });

  it("reads one chord the same however it was spelled", () => {
    expect(canonicalChord("Shift+CmdOrCtrl+Z".replace(/\+/g, "-"))).toBe(
      canonicalChord("Mod-Shift-z")
    );
    expect(canonicalChord("Cmd-Shift-E")).toBe(canonicalChord("Mod-Shift-e"));
  });
});

describe("the tooltip a control shows", () => {
  it("names the action and the key", () => {
    expect(controlTitle("bold", "Bold")).toBe("Bold (⌘B)");
  });

  it("names only the action when there is no key to promise", () => {
    expect(controlTitle("textColour", "Text colour")).toBe("Text colour");
  });

  it("carries the warning through", () => {
    expect(controlTitle("underline", "Underline", { note: "Saved as HTML in the file" })).toBe(
      "Underline (⌘U) - Saved as HTML in the file"
    );
    expect(controlTitle("textColour", "Text colour", { note: "Saved as HTML in the file" })).toBe(
      "Text colour - Saved as HTML in the file"
    );
  });

  it("follows the platform", () => {
    expect(controlTitle("bold", "Bold", { platform: "other" })).toBe("Bold (Ctrl+B)");
  });
});
