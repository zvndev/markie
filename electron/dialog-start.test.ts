import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dialogStartDir } from "./dialog-start.js";

const root = mkdtempSync(path.join(os.tmpdir(), "markie-dialog-start-"));
const doc = path.join(root, "notes.md");
writeFileSync(doc, "# notes\n");

describe("where a file dialog opens", () => {
  it("starts in the folder holding the open document", () => {
    expect(dialogStartDir(doc)).toBe(root);
  });

  it("handles a name with spaces and punctuation", () => {
    const odd = path.join(root, "Q3 plan (final), v2.md");
    writeFileSync(odd, "x");
    expect(dialogStartDir(odd)).toBe(root);
  });

  // Every one of these means "no better idea than the OS default", and the
  // caller omits defaultPath entirely rather than passing something wrong.
  it("gives up rather than guessing", () => {
    expect(dialogStartDir(null as unknown as string)).toBeNull();
    expect(dialogStartDir(undefined as unknown as string)).toBeNull();
    expect(dialogStartDir("")).toBeNull();
    expect(dialogStartDir("   ")).toBeNull();
    expect(dialogStartDir(42 as unknown as string)).toBeNull();
  });

  // dirname("notes.md") is ".", which would open wherever the app was launched
  // from. That is never what the reader meant by "near this document".
  it("refuses a bare filename instead of opening the working directory", () => {
    expect(dialogStartDir("notes.md")).toBeNull();
  });

  it("returns null when the folder is gone", () => {
    expect(dialogStartDir(path.join(root, "no-such-dir", "notes.md"))).toBeNull();
  });

  it("returns null when the parent is a file rather than a folder", () => {
    expect(dialogStartDir(path.join(doc, "child.md"))).toBeNull();
  });

  // An unreadable path must not take the dialog down with it.
  it("survives a filesystem that throws", () => {
    const exploding = {
      statSync() {
        throw new Error("EACCES");
      },
    };
    expect(dialogStartDir(doc, exploding as never)).toBeNull();
  });
});
