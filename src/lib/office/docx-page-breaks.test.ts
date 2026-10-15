import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { readZip, writeZip } from "./zip";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("original explicit DOCX page breaks", () => {
  it("inserts a true page break at a caret, preserving logical text and run formatting", async () => {
    const original = applyDocxOperations(await createDocx("BeforeAfter"), [{ type: "format-run", runId: "p0:r0", style: { bold: true } }, { type: "add-comment", paragraphId: "p0", author: "A", text: "Keep anchor" }]);
    const doc = applyDocxOperations(original, [{ type: "insert-page-break", paragraphId: "p0", offset: 6 }]);
    expect(doc.text).toBe("BeforeAfter"); expect(doc.pageBreaks[0].offset).toBe(6);
    expect(doc.paragraphs[0].runs.filter((r) => r.text).map((r) => [r.text, r.style.bold])).toEqual([["Before", true], ["After", true]]);
    expect(doc.paragraphs[0].runs.find((r) => r.pageBreaks.length)?.pageBreaks[0].offset).toBe(0);
    const parts = await readZip(await exportDocx(doc));
    expect(decoder.decode(parts.find((p) => p.name === "word/document.xml")!.data)).toContain('<w:br w:type="page"/>');
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true); expect(saved.pageBreaks[0].offset).toBe(6); expect(saved.comments).toHaveLength(1);
    const removed = applyDocxOperations(doc, [{ type: "remove-page-break", pageBreakId: doc.pageBreaks[0].id }]);
    expect((await openDocx(await exportDocx(removed))).pageBreaks).toHaveLength(0);
  });

  it("removes only the break when an imported run also contains ordinary text", async () => {
    const parts = await readZip(await exportDocx(await createDocx("KEEP TEXT")));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encoder.encode(decoder.decode(main.data).replace("</w:t>", '</w:t><w:br w:type="page"/>'));
    const bytes = writeZip(parts);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true); expect(doc.pageBreaks[0].offset).toBe(9);
    expect(await exportDocx(doc)).toEqual(bytes);
    const removed = applyDocxOperations(doc, [{ type: "remove-page-break", pageBreakId: doc.pageBreaks[0].id }]);
    const saved = await openDocx(await exportDocx(removed));
    expect(saved.text).toBe("KEEP TEXT"); expect(saved.pageBreaks).toHaveLength(0);
  });

  it("supports boundary/empty paragraphs and blocks unsafe offsets and destructive flattening", async () => {
    const blank = applyDocxOperations(await createDocx(""), [{ type: "insert-page-break", paragraphId: "p0", offset: 0 }]);
    expect((await openDocx(await exportDocx(blank))).pageBreaks).toHaveLength(1);
    const original = await createDocx("A😀B\nOther");
    for (const offset of [-1, 2, 0.5, Infinity, 99]) expect(() => applyDocxOperations(original, [{ type: "insert-page-break", paragraphId: "p0", offset }])).toThrow();
    const doc = applyDocxOperations(original, [{ type: "insert-page-break", paragraphId: "p0", offset: 3 }]);
    expect(() => applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId: "p0", text: "Flatten" }])).toThrow(/Remove hyperlinks/);
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId: "p0" }])).toThrow();
    expect(() => applyDocxOperations(doc, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Tracked", author: "A" }])).toThrow();
    expect(original.pageBreaks).toHaveLength(0);
  });

  it.each(['<w:br/>', '<w:br w:type="column"/>', '<w:br w:type="page" w:clear="all"/>'])("keeps unsupported breaks read-only without silently dropping them", async (br) => {
    const parts = await readZip(await exportDocx(await createDocx("A")));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encoder.encode(decoder.decode(main.data).replace("</w:t>", `</w:t>${br}`));
    const bytes = writeZip(parts);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false); expect(await exportDocx(doc)).toEqual(bytes);
  });
});
