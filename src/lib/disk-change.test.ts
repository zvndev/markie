import { describe, expect, it } from "vitest";
import { copyNameFor, describeDiskChange, diskChangeKind } from "./disk-change";

describe("diskChangeKind", () => {
  it("is clean when there is nothing of yours to lose", () => {
    // A reload that cannot destroy anything should not stop the user with a
    // modal, matching how UpdateStrip already treats server changes.
    expect(diskChangeKind(false)).toBe("clean");
  });

  it("is dirty when the buffer has unsaved work", () => {
    expect(diskChangeKind(true)).toBe("dirty");
  });
});

describe("describeDiskChange", () => {
  it("says nothing changed when the copies match", () => {
    expect(describeDiskChange("a\nb\n", "a\nb\n")).toMatch(/identical/i);
  });

  it("counts what the other copy adds", () => {
    const text = describeDiskChange("a\n", "a\nb\nc\n");
    expect(text).toMatch(/2 lines/);
  });

  it("counts what reloading would cost you", () => {
    const text = describeDiskChange("a\nb\nc\n", "a\n");
    expect(text).toMatch(/2 lines/);
  });

  it("speaks about the file, not the server", () => {
    // This dialog is about something on disk — an agent, another editor, a
    // sync client. Saying "the server" would name the wrong culprit.
    const text = describeDiskChange("a\n", "b\n");
    expect(text).not.toMatch(/server/i);
    expect(text).toMatch(/disk|file/i);
  });

  it("uses the singular for one line", () => {
    expect(describeDiskChange("a\n", "a\nb\n")).toMatch(/1 line\b/);
  });
});

describe("copyNameFor", () => {
  it("keeps the extension where an extension belongs", () => {
    expect(copyNameFor("notes.md")).toBe("notes (copy).md");
  });

  it("handles a name with several dots", () => {
    expect(copyNameFor("2026-08-19.design.md")).toBe("2026-08-19.design (copy).md");
  });

  it("handles a name with no extension", () => {
    expect(copyNameFor("README")).toBe("README (copy)");
  });

  it("does not stack up copies of copies", () => {
    // Resolving the same conflict twice should not produce
    // "notes (copy) (copy).md".
    expect(copyNameFor("notes (copy).md")).toBe("notes (copy 2).md");
    expect(copyNameFor("notes (copy 2).md")).toBe("notes (copy 3).md");
  });

  it("falls back to something sensible for an empty name", () => {
    expect(copyNameFor("")).toBe("untitled (copy).md");
  });
});
