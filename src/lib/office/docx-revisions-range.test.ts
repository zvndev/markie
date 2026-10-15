import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";

describe("true inline selection formatting", () => {
  it("formats only a selected word, preserving surrounding source run formatting", async () => {
    const original = await createDocx("Hello World!");
    const doc = applyDocxOperations(original, [{ type: "format-range", paragraphId: "p0", start: 6, end: 11, style: { bold: true } }]);
    expect(doc.paragraphs[0].runs.map((r) => [r.text, r.style.bold])).toEqual([["Hello ", undefined], ["World", true], ["!", undefined]]);
    expect(doc.text).toBe(original.text);
    expect((await openDocx(await exportDocx(doc))).paragraphs[0].runs.map((r) => [r.text, r.style.bold])).toEqual([["Hello ", undefined], ["World", true], ["!", undefined]]);
    expect(original.paragraphs[0].runs).toHaveLength(1);
  });

  it("preserves styles across a range spanning several existing runs and comment anchors", async () => {
    let doc = applyDocxOperations(await createDocx("Hello World!"), [{ type: "format-range", paragraphId: "p0", start: 6, end: 11, style: { bold: true } }, { type: "add-comment", paragraphId: "p0", author: "A", text: "Keep comment" }]);
    doc = applyDocxOperations(doc, [{ type: "format-range", paragraphId: "p0", start: 3, end: 9, style: { italic: true, color: "ff0000" } }]);
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.text).toBe("Hello World!");
    expect(saved.comments[0].text).toBe("Keep comment");
    expect(saved.paragraphs[0].runs.filter((r) => r.text).map((r) => [r.text, r.style.bold, r.style.italic])).toEqual([["Hel", undefined, undefined], ["lo ", undefined, true], ["Wor", true, true], ["ld", true, undefined], ["!", undefined, undefined]]);
  });

  it("rejects out-of-bounds/collapsed ranges and UTF-16 surrogate splits atomically", async () => {
    const doc = await createDocx("A😀B");
    for (const [start, end] of [[0, 99], [-1, 2], [1, 1], [1, 2], [2, 3], [0.5, 2]]) expect(() => applyDocxOperations(doc, [{ type: "format-range", paragraphId: "p0", start, end, style: { bold: true } }])).toThrow();
    const valid = applyDocxOperations(doc, [{ type: "format-range", paragraphId: "p0", start: 1, end: 3, style: { bold: true } }]);
    expect(valid.paragraphs[0].runs.find((r) => r.text === "😀")?.style.bold).toBe(true);
    expect(doc.modified).toBe(false);
  });
});
