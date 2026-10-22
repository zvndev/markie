import { describe, expect, it } from "vitest";
import { sameDocumentPath } from "./path-utils";

describe("document selection path identity", () => {
  it("matches Windows registry casing and separators without granting file access", () => {
    expect(sameDocumentPath("C:\\Docs\\Notes.md", "c:/docs/notes.md", "win32")).toBe(true);
    expect(sameDocumentPath("C:\\Docs\\Notes.md", "C:\\Docs\\Other.md", "win32")).toBe(false);
  });
  it("does not fold case on other platforms or match missing paths", () => {
    expect(sameDocumentPath("/Docs/Notes.md", "/docs/notes.md", "darwin")).toBe(false);
    expect(sameDocumentPath("/Docs/Notes.md", "/Docs/Notes.md", "darwin")).toBe(true);
    expect(sameDocumentPath(null, null, "win32")).toBe(false);
  });
});
