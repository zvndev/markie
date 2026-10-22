import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText, type DocxOperation } from "./docx";
import { readZip, writeZip } from "./zip";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("original portable DOCX paragraph comments", () => {
  it("adds, exports and reopens comments with author/date and real OPC relationships", async () => {
    const original = await createDocx("Discuss this\nAnother paragraph");
    const doc = applyDocxOperations(original, [{ type: "add-comment", paragraphId: original.paragraphs[0].id, author: 'Writer "A"', text: "First line <&>\nSecond 😀" }]);
    expect(doc.comments).toHaveLength(1);
    expect(doc.comments[0]).toMatchObject({ paragraphId: original.paragraphs[0].id, author: 'Writer "A"', text: "First line <&>\nSecond 😀" });
    expect(doc.comments[0].date).toMatch(/^\d{4}-/);
    expect(original.comments).toHaveLength(0);
    const bytes = await exportDocx(doc);
    const reopened = await openDocx(bytes);
    expect(reopened.canEdit).toBe(true);
    expect(reopened.text).toBe(original.text);
    expect(reopened.comments[0]).toMatchObject({ author: 'Writer "A"', text: "First line <&>\nSecond 😀" });
    const entries = await readZip(bytes);
    expect(entries.some((p) => p.name === "word/comments.xml")).toBe(true);
    expect(decoder.decode(entries.find((p) => p.name === "word/_rels/document.xml.rels")!.data)).toContain("/comments");
    expect(decoder.decode(entries.find((p) => p.name === "[Content_Types].xml")!.data)).toContain("wordprocessingml.comments+xml");
  });

  it("preserves whole-paragraph anchors through run edits, paragraph replacement and insertion", async () => {
    const original = await createDocx("Original\nNext");
    const paragraphId = original.paragraphs[0].id;
    let doc = applyDocxOperations(original, [{ type: "add-comment", paragraphId, author: "A", text: "Keep anchor" }]);
    doc = replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "Run changed" }]);
    doc = applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId, text: "Paragraph changed" }, { type: "insert-paragraph", afterParagraphId: null, text: "Before" }]);
    expect(doc.comments[0].paragraphId).toBe(paragraphId);
    expect(doc.paragraphs.find((p) => p.id === paragraphId)?.text).toBe("Paragraph changed");
    const reopened = await openDocx(await exportDocx(doc));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.paragraphs.find((p) => p.id === reopened.comments[0].paragraphId)?.text).toBe("Paragraph changed");
  });

  it("handles several comments on a paragraph and deletion without losing other comments", async () => {
    const original = await createDocx("Commented\nOther");
    const paragraphId = original.paragraphs[0].id;
    let doc = applyDocxOperations(original, [{ type: "add-comment", paragraphId, author: "A", text: "One" }, { type: "add-comment", paragraphId, author: "B", text: "Two" }]);
    expect(doc.comments.map((c) => c.text)).toEqual(["One", "Two"]);
    doc = applyDocxOperations(doc, [{ type: "delete-comment", commentId: doc.comments[0].id }]);
    expect((await openDocx(await exportDocx(doc))).comments.map((c) => c.text)).toEqual(["Two"]);
    doc = applyDocxOperations(doc, [{ type: "delete-comment", commentId: doc.comments[0].id }, { type: "delete-paragraph", paragraphId }]);
    const reopened = await openDocx(await exportDocx(doc));
    expect(reopened.comments).toHaveLength(0);
    expect(reopened.text).toBe("Other");
    expect(reopened.canEdit).toBe(true);
  });

  it("protects comments from implicit deletion through paragraphs or tables", async () => {
    const original = await createDocx("A\nB");
    const doc = applyDocxOperations(original, [{ type: "add-comment", paragraphId: original.paragraphs[0].id, author: "A", text: "Protected anchor" }]);
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId: original.paragraphs[0].id }])).toThrow(/comments/);
    const table = applyDocxOperations(original, [{ type: "insert-table", rows: 1, columns: 1 }]);
    const commented = applyDocxOperations(table, [{ type: "add-comment", paragraphId: table.tables[0].rows[0].cells[0].paragraphs[0].id, author: "A", text: "Cell comment" }]);
    expect(() => applyDocxOperations(commented, [{ type: "delete-table", tableId: table.tables[0].id }])).toThrow(/comments/);
    expect((await openDocx(await exportDocx(commented))).comments).toHaveLength(1);
  });

  it("fails closed for partial ranges, orphan comments and modern thread dependencies", async () => {
    const original = await createDocx("A");
    const doc = applyDocxOperations(original, [{ type: "add-comment", paragraphId: original.paragraphs[0].id, author: "A", text: "Comment" }]);
    for (const variant of ["missing-end", "missing-comment", "partial-range", "formatted-comment"] as const) {
      const parts = await readZip(await exportDocx(doc));
      const main = parts.find((p) => p.name === "word/document.xml")!;
      const comments = parts.find((p) => p.name === "word/comments.xml")!;
      if (variant === "missing-end") main.data = encoder.encode(decoder.decode(main.data).replace(/<w:commentRangeEnd[^>]*\/>/, ""));
      if (variant === "missing-comment") comments.data = encoder.encode(decoder.decode(comments.data).replace(/<w:comment [^]*?<\/w:comment>/, ""));
      if (variant === "partial-range") main.data = encoder.encode(decoder.decode(main.data).replace(/(<w:commentRangeStart[^>]*\/>)(<w:r>)/, "$2$1"));
      if (variant === "formatted-comment") comments.data = encoder.encode(decoder.decode(comments.data).replace("<w:r>", "<w:r><w:rPr><w:b/></w:rPr>"));
      const bytes = writeZip(parts);
      const readonly = await openDocx(bytes);
      expect(readonly.canEdit, variant).toBe(false);
      expect(await exportDocx(readonly)).toEqual(bytes);
    }
  });

  it("validates comment fields and unknown IDs without mutating the source", async () => {
    const doc = await createDocx("A");
    for (const op of [
      { type: "add-comment", paragraphId: "p0", author: "", text: "A" },
      { type: "add-comment", paragraphId: "p0", author: "A", text: "" },
      { type: "add-comment", paragraphId: "p0", author: "A", text: "A\u0000" },
      { type: "add-comment", paragraphId: "absent", author: "A", text: "A" },
      { type: "delete-comment", commentId: "absent" },
    ]) expect(() => applyDocxOperations(doc, [op as DocxOperation])).toThrow();
    expect(doc.comments).toHaveLength(0);
    expect(doc.modified).toBe(false);
  });
});
