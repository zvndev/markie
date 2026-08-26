// The one rule this file exists to keep: a line drawn *inside* something the
// user is reading is typography, and a line drawn *around* a piece of app
// furniture is chrome. They are different weights on purpose, and they used to
// share `--border`. Raising that token for card edges (real: they were close
// to invisible) also thickened every heading underline, table rule, and gutter
// edge in the app, and the first person to open a document said so.
//
// This is a source test rather than a rendered one because the defect lives in
// the stylesheet, not in the DOM: it is a token chosen once, by hand, at author
// time. A screenshot catches it only if someone happens to screenshot that view
// in that mode, which is exactly how it got shipped the first time.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// Comments are stripped first so a failure names the selector and nothing
// else: a rule preceded by a paragraph of explanation would otherwise report
// the paragraph as part of its selector.
const CSS = fs
  .readFileSync(path.join(__dirname, "globals.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// Selectors that draw on a reading surface: the rendered markdown body, the
// source editor, and the rich editor's ProseMirror root.
const READING_SURFACE = /markdown-body|cm-editor|ProseMirror/;

type Rule = { line: number; selector: string; declarations: string[] };

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    out.push({
      line: css.slice(0, m.index).split("\n").length,
      selector: m[1].replace(/\s+/g, " ").trim(),
      declarations: m[2]
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return out;
}

describe("document rules and chrome borders stay separate tokens", () => {
  it("draws nothing on a reading surface with the chrome border token", () => {
    const offenders = rules(CSS)
      .filter((r) => READING_SURFACE.test(r.selector))
      .flatMap((r) =>
        r.declarations
          .filter((d) => d.includes("var(--border)"))
          .map((d) => `${r.selector} { ${d} }  (globals.css:${r.line})`)
      );

    // Named rather than counted: a failure should say which line to look at.
    expect(offenders).toEqual([]);
  });

  it("still uses the document rule token where documents draw lines", () => {
    // Guards the other direction: someone "simplifying" the stylesheet by
    // collapsing the two tokens back together would pass the test above by
    // deleting every rule it checks.
    const used = rules(CSS).filter((r) =>
      r.declarations.some((d) => d.includes("var(--doc-rule)"))
    );
    expect(used.length).toBeGreaterThanOrEqual(7);
    expect(used.some((r) => /markdown-body/.test(r.selector))).toBe(true);
    expect(used.some((r) => /cm-editor/.test(r.selector))).toBe(true);
  });

  it("leaves app furniture on the chrome border token", () => {
    // The raise that caused all this was correct for these; the fix must not
    // have quietly reverted them to the old near-invisible hairline.
    const chrome = rules(CSS).filter(
      (r) => !READING_SURFACE.test(r.selector) && r.selector.startsWith(".markie-")
    );
    const usingBorder = chrome.filter((r) =>
      r.declarations.some((d) => d.includes("var(--border)"))
    );
    expect(usingBorder.length).toBeGreaterThan(0);
  });
});
