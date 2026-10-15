import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText, type DocxOperation } from "./docx";
import { readZip, writeZip } from "./zip";

const encode = new TextEncoder();
const decode = new TextDecoder();
async function reopened(doc: Awaited<ReturnType<typeof createDocx>>) { return openDocx(await exportDocx(doc)); }

describe("original DOCX immutable rich operations", () => {
  it("round-trips full direct run formatting and lets null remove it", async () => {
    const original = await createDocx("Typography");
    const id = original.paragraphs[0].runs[0].id;
    const edited = applyDocxOperations(original, [{ type: "format-run", runId: id, style: { bold: true, italic: false, underline: "double", color: "1255AA", fontFamily: 'A "quoted" font', fontSizePoints: 18.5 } }]);
    expect(edited.paragraphs[0].runs[0].id).toBe(id);
    expect(edited.paragraphs[0].runs[0].style).toMatchObject({ bold: true, italic: false, underline: "double", color: "1255AA", fontFamily: 'A "quoted" font', fontSizePoints: 18.5 });
    expect((await reopened(edited)).paragraphs[0].runs[0].style).toEqual(edited.paragraphs[0].runs[0].style);
    expect(original.paragraphs[0].runs[0].style.bold).toBeUndefined();
    const cleared = applyDocxOperations(edited, [{ type: "format-run", runId: id, style: { bold: null, italic: null, underline: null, color: null, fontFamily: null, fontSizePoints: null } }]);
    expect((await reopened(cleared)).paragraphs[0].runs[0].style).toEqual(original.paragraphs[0].runs[0].style);
  });

  it("preserves opaque paragraph identities through insert, replace, formatting and delete", async () => {
    const original = await createDocx("One\nTwo\nThree");
    const [one, two, three] = original.paragraphs;
    const doc = applyDocxOperations(original, [
      { type: "insert-paragraph", afterParagraphId: null, text: "Before" },
      { type: "insert-paragraph", afterParagraphId: one.id, text: "After one" },
      { type: "replace-paragraph", paragraphId: two.id, text: "Replaced" },
      { type: "format-paragraph", paragraphId: two.id, format: { alignment: "center", spacingBeforePoints: 6, spacingAfterPoints: 12, lineSpacingMultiple: 1.5 } },
      { type: "delete-paragraph", paragraphId: three.id },
    ]);
    expect(doc.text).toBe("Before\nOne\nAfter one\nReplaced");
    expect(doc.paragraphs.find((p) => p.text === "One")?.id).toBe(one.id);
    expect(doc.paragraphs.find((p) => p.text === "Replaced")).toMatchObject({ id: two.id, alignment: "center", spacingBeforePoints: 6, spacingAfterPoints: 12, lineSpacingMultiple: 1.5 });
    const saved = await reopened(doc);
    expect(saved.text).toBe(doc.text);
    expect(saved.paragraphs[3]).toMatchObject({ alignment: "center", spacingBeforePoints: 6, spacingAfterPoints: 12, lineSpacingMultiple: 1.5 });
    expect(original.text).toBe("One\nTwo\nThree");
  });

  it("round-trips page paper, orientation and margins without changing text", async () => {
    const doc = await createDocx("Layout");
    const edited = applyDocxOperations(doc, [{ type: "set-page-layout", layout: { paper: "a4", orientation: "landscape", marginTopPoints: 36, marginRightPoints: 48, marginBottomPoints: 54, marginLeftPoints: 60 } }]);
    const saved = await reopened(edited);
    expect(saved.pageLayout).toMatchObject({ widthPoints: 841.9, heightPoints: 595.3, orientation: "landscape", marginTopPoints: 36, marginRightPoints: 48, marginBottomPoints: 54, marginLeftPoints: 60 });
    expect(saved.text).toBe("Layout");
    const portrait = applyDocxOperations(edited, [{ type: "set-page-layout", layout: { orientation: "portrait" } }]);
    expect(portrait.pageLayout.widthPoints).toBeLessThan(portrait.pageLayout.heightPoints);
  });

  it("preserves existing valid signed top/bottom margins through unrelated layout changes", async () => {
    const parts = await readZip(await exportDocx(await createDocx("Signed margins")));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encode.encode(decode.decode(main.data).replace('w:top="1440"', 'w:top="-720"').replace('w:bottom="1440"', 'w:bottom="-360"'));
    const doc = await openDocx(writeZip(parts));
    expect(doc.pageLayout).toMatchObject({ marginTopPoints: -36, marginBottomPoints: -18 });
    const changed = applyDocxOperations(doc, [{ type: "set-page-layout", layout: { orientation: "landscape" } }]);
    expect((await reopened(changed)).pageLayout).toMatchObject({ marginTopPoints: -36, marginBottomPoints: -18, orientation: "landscape" });
  });

  it("creates rectangular tables in body order, edits cells and deletes the table safely", async () => {
    const original = await createDocx("Before\nAfter");
    const doc = applyDocxOperations(original, [{ type: "insert-table", afterParagraphId: original.paragraphs[0].id, rows: 2, columns: 2, cells: [["A", "B"], ["C", "D"]] }]);
    expect(doc.blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect(doc.tables[0].rows.map((r) => r.cells.map((c) => c.paragraphs[0].text))).toEqual([["A", "B"], ["C", "D"]]);
    const cellParagraph = doc.tables[0].rows[1].cells[1].paragraphs[0];
    const edited = applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId: cellParagraph.id, text: "Edited cell" }, { type: "format-paragraph", paragraphId: cellParagraph.id, format: { alignment: "right" } }]);
    const saved = await reopened(edited);
    expect(saved.canEdit).toBe(true);
    expect(saved.tables[0].rows[1].cells[1].paragraphs[0]).toMatchObject({ text: "Edited cell", alignment: "right" });
    expect(saved.text).toBe("Before\nA\nB\nC\nEdited cell\nAfter");
    const without = applyDocxOperations(edited, [{ type: "delete-table", tableId: doc.tables[0].id }]);
    expect((await reopened(without)).text).toBe(original.text);
    expect(without.paragraphs[1].id).toBe(original.paragraphs[1].id);
  });

  it("supports multiple paragraphs inside cells without allowing empty cells", async () => {
    const doc = applyDocxOperations(await createDocx("A"), [{ type: "insert-table", rows: 1, columns: 1 }]);
    const paragraphId = doc.tables[0].rows[0].cells[0].paragraphs[0].id;
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId }])).toThrow(/at least/);
    const added = applyDocxOperations(doc, [{ type: "insert-paragraph", afterParagraphId: paragraphId, text: "Second" }]);
    const deleted = applyDocxOperations(added, [{ type: "delete-paragraph", paragraphId }]);
    expect((await reopened(deleted)).tables[0].rows[0].cells[0].paragraphs.map((p) => p.text)).toEqual(["Second"]);
  });

  it("handles self-closing empty paragraphs and strict/default namespaces", async () => {
    const parts = await readZip(await exportDocx(await createDocx("A")));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encode.encode(decode.decode(main.data).replace(/<w:p>.*?<\/w:p>/, "<w:p/>").replaceAll("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"));
    const original = await openDocx(writeZip(parts));
    const id = original.paragraphs[0].id;
    const formatted = applyDocxOperations(original, [{ type: "format-paragraph", paragraphId: id, format: { alignment: "right" } }, { type: "replace-paragraph", paragraphId: id, text: "Now text" }]);
    expect(formatted.paragraphs[0].id).toBe(id);
    expect((await reopened(formatted)).paragraphs[0]).toMatchObject({ text: "Now text", alignment: "right" });
  });

  it("keeps run edit compatibility after structure or formatting mutations", async () => {
    const original = await createDocx("One\nTwo");
    const id = original.paragraphs[1].runs[0].id;
    const inserted = applyDocxOperations(original, [{ type: "insert-paragraph", afterParagraphId: null, text: "Before" }, { type: "format-run", runId: id, style: { bold: true } }]);
    const replaced = replaceDocxText(inserted, [{ runId: id, text: "Changed" }]);
    expect((await reopened(replaced)).text).toBe("Before\nOne\nChanged");
    expect(replaced.paragraphs[2].runs[0].id).toBe(id);
    expect(replaced.paragraphs[2].runs[0].style.bold).toBe(true);
  });

  it("keeps text-node local namespace declarations during run replacement", async () => {
    const parts = await readZip(await exportDocx(await createDocx("Local namespace")));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encode.encode(decode.decode(main.data).replace('<w:t xml:space="preserve">Local namespace</w:t>', '<q:t xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xml:space="default">Local namespace</q:t>'));
    const original = await openDocx(writeZip(parts));
    const changed = replaceDocxText(original, [{ runId: "p0:r0", text: " Updated " }]);
    expect((await reopened(changed)).text).toBe(" Updated ");
  });

  it("rejects invalid formatting and structural operations atomically", async () => {
    const doc = await createDocx("Original");
    const invalid: unknown[] = [
      { type: "format-run", runId: "p0:r0", style: { bold: "yes" } },
      { type: "format-run", runId: "p0:r0", style: { color: 'red" foo="bar' } },
      { type: "format-run", runId: "p0:r0", style: { fontSizePoints: NaN } },
      { type: "format-run", runId: "p0:r0", style: { fontSizePoints: 12.2 } },
      { type: "format-run", runId: "p0:r0", style: { fontFamily: "Bad\nfont" } },
      { type: "format-run", runId: "p0:r0", style: { unknown: true } },
      { type: "format-paragraph", paragraphId: "p0", format: { styleId: 'a"/>evil' } },
      { type: "format-paragraph", paragraphId: "p0", format: { alignment: "invalid" } },
      { type: "format-paragraph", paragraphId: "p0", format: { lineSpacingMultiple: -1 } },
      { type: "set-page-layout", layout: { paper: "constructor" } },
      { type: "set-page-layout", layout: { orientation: "diagonal" } },
      { type: "set-page-layout", layout: { marginLeftPoints: 600 } },
      { type: "set-page-layout", layout: { marginTopPoints: Infinity } },
      { type: "insert-table", rows: 0, columns: 2 },
      { type: "insert-table", rows: 1.5, columns: 2 },
      { type: "insert-table", rows: 100, columns: 20 },
      { type: "insert-table", rows: 2, columns: 2, cells: [["A"]] },
      { type: "replace-paragraph", paragraphId: "p0", text: "A\nB" },
      { type: "delete-paragraph", paragraphId: "p0" },
      { type: "delete-table", tableId: "absent" },
      { type: "format-run", runId: "absent", style: { bold: true } },
    ];
    for (const op of invalid) {
      expect(() => applyDocxOperations(doc, [{ type: "format-run", runId: "p0:r0", style: { bold: true } }, op as DocxOperation]), JSON.stringify(op)).toThrow();
      expect(doc.text).toBe("Original");
      expect(doc.modified).toBe(false);
    }
    expect(await exportDocx(doc)).toEqual(await exportDocx(await createDocx("Original")));
  });

  it("continues to reject unsupported ranges and merged tables untouched", async () => {
    const doc = applyDocxOperations(await createDocx("A"), [{ type: "insert-table", rows: 1, columns: 1 }]);
    const parts = await readZip(await exportDocx(doc));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encode.encode(decode.decode(main.data).replace("</w:tcPr>", '<w:gridSpan xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:val="2"/></w:tcPr>'));
    const bytes = writeZip(parts);
    const readonly = await openDocx(bytes);
    expect(readonly.canEdit).toBe(false);
    expect(() => applyDocxOperations(readonly, [{ type: "set-page-layout", layout: { paper: "a4" } }])).toThrow(/safely/);
    expect(await exportDocx(readonly)).toEqual(bytes);
  });
});
