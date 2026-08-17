import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_KEYS,
  MENU_ACCELERATORS,
  canonicalChord,
  isMenuReserved,
} from "./toolbar-shortcuts";

// Reads the real application menu and checks it against the table the tooltips
// are generated from.
//
// This is a static check on purpose. An Electron menu accelerator is handled by
// the native menu before the keystroke reaches the web contents, and CDP's
// Input.dispatchKeyEvent injects *into* the web contents — downstream of the
// menu. So no amount of driving the running app can detect that the menu is
// swallowing a chord the editor also wants: the injected key reaches the editor
// either way and the test passes while the real user gets an export dialog.
// Comparing the two declarations is the only thing that actually catches it.

const main = readFileSync(
  path.join(process.cwd(), "electron", "main.js"),
  "utf-8"
);

// "CmdOrCtrl+Shift+E" and the platform-conditional form used for Redo.
function acceleratorsInMenu(source: string): string[] {
  const found = new Set<string>();
  for (const [, value] of source.matchAll(/accelerator:\s*([^\n]+)/g)) {
    for (const [, literal] of value.matchAll(/"([^"]+)"/g)) {
      // The Redo item picks its accelerator from process.platform, so the same
      // line also yields the string "darwin". A chord always has a modifier.
      if (!literal.includes("+")) continue;
      found.add(
        literal
          .replace(/CmdOrCtrl|Command|Cmd|Ctrl|Control/gi, "Mod")
          .split("+")
          .join("-")
      );
    }
  }
  return [...found];
}

const normalize = canonicalChord;

describe("the declared menu matches the real one", () => {
  it("finds the accelerators", () => {
    // A guard on the parser itself: if the regex ever stops matching, every
    // assertion below would pass vacuously.
    expect(acceleratorsInMenu(main).length).toBeGreaterThan(15);
  });

  it("declares every accelerator the menu actually claims", () => {
    const missing = acceleratorsInMenu(main).filter((k) => !isMenuReserved(k));
    expect(missing).toEqual([]);
  });

  it("claims no accelerator the menu does not have", () => {
    const real = new Set(acceleratorsInMenu(main).map(normalize));
    const phantom = MENU_ACCELERATORS.filter((k) => !real.has(normalize(k)));
    expect(phantom).toEqual([]);
  });

  // The specific regression: ⌘⇧E was Export PDF, so pressing the universal
  // align-centre chord opened a save dialog. Nothing in the running app can
  // observe this, which is why it survived a full pass of end-to-end checks.
  it("leaves the editor's chords alone", () => {
    const real = new Set(acceleratorsInMenu(main).map(normalize));
    const stolen = Object.entries(CONTROL_KEYS)
      .filter(([id]) => !["undo", "redo", "print", "zoomIn", "zoomOut"].includes(id))
      .filter(([, key]) => real.has(normalize(key)))
      .map(([id, key]) => `${id} (${key})`);
    expect(stolen).toEqual([]);
  });

  it("has the menu items the toolbar promises exist", () => {
    for (const accelerator of ["CmdOrCtrl+P", "CmdOrCtrl+=", "CmdOrCtrl+-", "CmdOrCtrl+0"]) {
      expect(main).toContain(`accelerator: "${accelerator}"`);
    }
  });
});
