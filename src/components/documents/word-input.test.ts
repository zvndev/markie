import { describe, expect, it } from "vitest";
import { paragraphInput } from "./word-input";
import type { DocxParagraph } from "@/lib/office/docx";

const source: DocxParagraph = { id: "p", text: "alpha beta", revisionIds: [], runs: [
  { id: "a", text: "alpha ", style: { bold: true }, canEdit: true, pageBreaks: [] },
  { id: "b", text: "beta", style: { italic: true }, canEdit: true, pageBreaks: [] },
] };
describe("private paragraph range input", () => {
  it("replaces a mixed-run range without flattening untouched runs", () => {
    expect(paragraphInput(source, 3, 8, "X")).toEqual({ edits: [{ runId: "a", text: "alpX" }, { runId: "b", text: "ta" }], caret: 4 });
    expect(source.runs[1].style.italic).toBe(true);
  });
  it("keeps no-op edits empty and uses the right run at an insertion boundary", () => {
    expect(paragraphInput(source, 0, 5, "alpha").edits).toEqual([]);
    expect(paragraphInput(source, 6, 6, "X")).toEqual({ edits: [{ runId: "b", text: "Xbeta" }], caret: 7 });
  });
  it.each(["😀", "e\u0301", "👩‍👩‍👧‍👦"])("deletes one complete %s grapheme in either direction", (value) => {
    const p = { ...source, text: `A${value}B`, runs: [{ ...source.runs[0], text: `A${value}B` }] };
    expect(paragraphInput(p, 1 + value.length, 1 + value.length, "", "backward").edits).toEqual([{ runId: "a", text: "AB" }]);
    expect(paragraphInput(p, 1, 1, "", "forward").edits).toEqual([{ runId: "a", text: "AB" }]);
  });
  it("refuses inline owners, protected runs and invalid Unicode boundaries", () => {
    expect(() => paragraphInput({ ...source, runs: [{ ...source.runs[0], hyperlinkId: "h" }, source.runs[1]] }, 1, 2, "X")).toThrow();
    expect(() => paragraphInput({ ...source, runs: [{ ...source.runs[0], canEdit: false }, source.runs[1]] }, 1, 2, "X")).toThrow();
    const p = { ...source, text: "😀", runs: [{ ...source.runs[0], text: "😀" }] };
    expect(() => paragraphInput(p, 1, 1, "X")).toThrow();
  });
});
