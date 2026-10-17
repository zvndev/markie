import { describe, expect, it } from "vitest";
import { applySimpleRichOperations, createRichSnapshot, rebaseSimpleRichDefaults, replaceSimpleRichText } from "./rich-text-model";
import type { DocxOperation } from "./docx-types";

const fixture = () => createRichSnapshot("rtf", [{ runs: [{ text: "Hello ", style: { bold: true, color: "336699" } }, { text: "world" }] }, { runs: [{ text: "Second" }] }]);
describe("native rich projection and basic transactions", () => {
  it("freezes all projection data without retaining mutable codec inputs", () => {
    const style = { bold: true }, inputs = [{ runs: [{ text: "hello", style }] }];
    const doc = createRichSnapshot("odt", inputs);
    style.bold = false; inputs[0].runs[0].text = "changed";
    expect(doc.paragraphs[0].runs[0]).toMatchObject({ id: "p0:r0", text: "hello", style: { bold: true } });
    expect(Object.isFrozen(doc)).toBe(true); expect(Object.isFrozen(doc.paragraphs[0].runs[0].style)).toBe(true);
  });
  it("keeps identities across text edits, original snapshots and no-op transactions", () => {
    const doc = fixture();
    expect(replaceSimpleRichText(doc, [{ runId: "p0:r0", text: "Hello " }])).toBe(doc);
    expect(applySimpleRichOperations(doc, [])).toBe(doc);
    const next = replaceSimpleRichText(doc, [{ runId: "p0:r0", text: "New " }]);
    expect(next.text).toBe("New world\nSecond"); expect(doc.text).toBe("Hello world\nSecond");
    expect(next).toMatchObject({ format: "rtf", revision: 1, modified: true });
    expect(next.paragraphs[0].runs[0].id).toBe("p0:r0");
  });
  it("splits formatting ranges once, supports explicit null clearing and preserves other properties", () => {
    const doc = applySimpleRichOperations(fixture(), [{ type: "format-range", paragraphId: "p0", start: 2, end: 8, style: { bold: null, italic: true } }]);
    expect(doc.paragraphs[0].runs.map((r) => r.text)).toEqual(["He", "llo ", "wo", "rld"]);
    expect(doc.paragraphs[0].runs[1].style).toEqual({ color: "336699", italic: true });
    const ids = doc.paragraphs.flatMap((p) => p.runs.map((r) => r.id)); expect(new Set(ids).size).toBe(ids.length);
    const next = applySimpleRichOperations(doc, [{ type: "insert-paragraph", afterParagraphId: "p0", text: "Inserted" }, { type: "delete-paragraph", paragraphId: "p1" }]);
    expect(next.text).toBe("Hello world\nInserted"); expect(next.paragraphs[0].id).toBe("p0");
  });
  it("changes supported paragraph formatting and clears fields without introducing named styles", () => {
    const doc = applySimpleRichOperations(fixture(), [{ type: "format-paragraph", paragraphId: "p0", format: { alignment: "center", spacingAfterPoints: 12, lineSpacingMultiple: 1.5 } }]);
    expect(doc.paragraphs[0]).toMatchObject({ alignment: "center", spacingAfterPoints: 12, lineSpacingMultiple: 1.5 });
    const clear = applySimpleRichOperations(doc, [{ type: "format-paragraph", paragraphId: "p0", format: { alignment: null, spacingAfterPoints: null } }]);
    expect(clear.paragraphs[0].alignment).toBeUndefined(); expect(clear.paragraphs[0].spacingAfterPoints).toBeUndefined();
  });
  it.each(["insert-table", "set-list", "insert-image", "set-hyperlink", "add-comment", "accept-all-revisions"])("rejects %s rather than losing source", (type) => {
    expect(() => applySimpleRichOperations(fixture(), [{ type } as DocxOperation])).toThrow();
  });
  it("rejects foreign, readonly, duplicate, invalid Unicode, unknown and out-of-bounds edits atomically", () => {
    const doc = fixture();
    expect(() => replaceSimpleRichText({ ...doc }, [])).toThrow(/Unowned/);
    expect(() => replaceSimpleRichText(createRichSnapshot("rtf", [{ runs: [{ text: "x" }] }], { canEdit: false }), [])).toThrow(/read-only/);
    expect(() => replaceSimpleRichText(doc, [{ runId: "p0:r0", text: "x" }, { runId: "p0:r0", text: "y" }])).toThrow(/Duplicate/);
    expect(() => replaceSimpleRichText(doc, [{ runId: "unknown", text: "x" }])).toThrow(/Unknown/);
    expect(() => replaceSimpleRichText(doc, [{ runId: "p0:r0", text: "\ud800" }])).toThrow();
    expect(() => applySimpleRichOperations(doc, [{ type: "format-range", paragraphId: "p0", start: -1, end: 2, style: {} }])).toThrow();
    expect(() => applySimpleRichOperations(doc, [{ type: "format-run", runId: "p0:r0", style: { fontSizePoints: NaN } }])).toThrow();
    expect(() => applySimpleRichOperations(doc, [{ type: "format-paragraph", paragraphId: "p0", format: { styleId: "Normal" } }])).toThrow();
    expect(doc.revision).toBe(0);
  });
  it("rejects formatting through half a Unicode character", () => {
    const doc = createRichSnapshot("rtf", [{ runs: [{ text: "a😀b" }] }]);
    expect(() => applySimpleRichOperations(doc, [{ type: "format-range", paragraphId: "p0", start: 1, end: 2, style: { bold: true } }])).toThrow(/Unicode/);
  });
  it("counts paragraph separators in the same text budget on creation and atomic mutation", () => {
    const input = "a".repeat(999_999);
    const doc = createRichSnapshot("rtf", [{ runs: [{ text: input }] }]);
    const boundary = applySimpleRichOperations(doc, [{ type: "insert-paragraph", afterParagraphId: "p0", text: "" }]);
    expect(boundary.text.length).toBe(1_000_000);
    expect(createRichSnapshot("rtf", boundary.paragraphs).text).toBe(boundary.text);
    const sourceId = boundary.paragraphs[1].id;
    expect(() => applySimpleRichOperations(boundary, [{ type: "insert-paragraph", afterParagraphId: sourceId, text: "" }])).toThrow(/size/);
    expect(boundary.revision).toBe(1); expect(boundary.paragraphs[1].id).toBe(sourceId);
    expect(boundary.paragraphs).toHaveLength(2); expect(boundary.text.length).toBe(1_000_000);
    const afterFailure = applySimpleRichOperations(boundary, [{ type: "delete-paragraph", paragraphId: sourceId }, { type: "insert-paragraph", afterParagraphId: "p0", text: "" }]);
    expect(afterFailure.paragraphs[1].id).toBe("p~2");
  });
  it("rebases missing defaults in one projection pass without changing edit state or explicit values", () => {
    const initial = createRichSnapshot("odt", [{ runs: [{ text: "a", style: { bold: false, underline: "none" } }, { text: "b" }], spacingAfterPoints: 0 }]);
    const edited = applySimpleRichOperations(initial, [{ type: "insert-paragraph", afterParagraphId: "p0", text: "new" }]);
    const defaults = { run: { bold: true, underline: "single", fontFamily: "Georgia", fontSizePoints: 12 }, paragraph: { alignment: "left", spacingAfterPoints: 9, lineSpacingMultiple: 1 } };
    const next = rebaseSimpleRichDefaults(edited, defaults);
    expect(next.paragraphs[0].runs[0].style).toMatchObject({ bold: false, underline: "none", fontFamily: "Georgia", fontSizePoints: 12 });
    expect(next.paragraphs[0].spacingAfterPoints).toBe(0); expect(next.paragraphs[1].spacingAfterPoints).toBe(9);
    expect(next.revision).toBe(edited.revision); expect(next.modified).toBe(edited.modified); expect(next.text).toBe(edited.text);
    expect(next.paragraphs.map((p) => p.id)).toEqual(edited.paragraphs.map((p) => p.id));
    expect(next.paragraphs.flatMap((p) => p.runs.map((r) => r.id))).toEqual(edited.paragraphs.flatMap((p) => p.runs.map((r) => r.id)));
    expect(Object.isFrozen(next.paragraphs[0].runs[0].style)).toBe(true);
    expect(rebaseSimpleRichDefaults(next, defaults)).toBe(next);
    const inserted = applySimpleRichOperations(next, [{ type: "insert-paragraph", afterParagraphId: next.paragraphs[1].id, text: "next" }]);
    expect(inserted.paragraphs[2].id).toBe("p~2");
    expect(() => rebaseSimpleRichDefaults({ ...next }, defaults)).toThrow(/Unowned/);
    expect(() => rebaseSimpleRichDefaults(next, { run: { fontSizePoints: NaN } })).toThrow();
    expect(() => rebaseSimpleRichDefaults(next, { paragraph: { spacingAfterPoints: -1 } })).toThrow();
  });
});
