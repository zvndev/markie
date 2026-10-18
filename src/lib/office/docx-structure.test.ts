import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxRange, replaceDocxText, type DocxDocument } from "./docx";
import { replaceRichRange } from "./rich-document";
import { createRtf } from "./rtf";
import { readZip, writeZip } from "./zip";
import { indexDocxIdentities } from "./docx-edit";
import { replaceDocxSourceRange } from "./docx-structure";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const range = (doc: DocxDocument, a: number, x: number, b = a, y = x) => ({ anchor: { paragraphId: doc.paragraphs[a].id, offset: x }, focus: { paragraphId: doc.paragraphs[b].id, offset: y } });
async function source(doc: DocxDocument) { return decoder.decode((await readZip(await exportDocx(doc))).find((p) => p.name === "word/document.xml")!.data); }
async function fixture(body: string) {
  const parts = await readZip(await exportDocx(await createDocx("seed")));
  const main = parts.find((p) => p.name === "word/document.xml")!;
  main.data = encoder.encode(decoder.decode(main.data).replace(/<w:p>[^]*?<\/w:p>/, body));
  return openDocx(writeZip(parts));
}
const mixed = '<w:p xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" w14:paraId="12345678" w14:textId="22345678"><w:pPr><w:jc w:val="center"/></w:pPr><w:r w:rsidR="12345678"><w:rPr><w:b/><w:lang w:val="en-US"/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:rPr><w:i/><w:color w:themeColor="accent1"/></w:rPr><w:t>Italic</w:t></w:r></w:p>';

describe("DOCX source-preserving logical ranges", () => {
  it("protects paragraph section boundaries from cloning at both public and source seams", async () => {
    const doc = await fixture('<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>');
    expect(doc.canEdit).toBe(false);
    const bytes = await exportDocx(doc);
    expect(() => replaceDocxRange(doc, range(doc, 0, 3), "\n")).toThrow(/safely/);
    const state = { source: await source(doc), identities: new Map<number, string>(), nextId: 0 };
    indexDocxIdentities(state);
    expect(() => replaceDocxSourceRange(state, { paragraphId: "p0", offset: 3 }, { paragraphId: "p0", offset: 3 }, "\n")).toThrow(/section boundaries/);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("rejects unnormalized multiple text nodes and safely coalesces supported cache-split runs", async () => {
    const body = '<w:p><w:r><w:t>First</w:t><w:t>Second</w:t></w:r></w:p>';
    const doc = await fixture(body);
    expect(doc.canEdit).toBe(false);
    const bytes = await exportDocx(doc);
    expect(() => replaceDocxRange(doc, range(doc, 0, 2), "\n")).toThrow(/safely/);
    expect(await exportDocx(doc)).toEqual(bytes);
    const state = { source: await source(doc), identities: new Map<number, string>(), nextId: 0 };
    indexDocxIdentities(state);
    expect(() => replaceDocxSourceRange(state, { paragraphId: "p0", offset: 2 }, { paragraphId: "p0", offset: 2 }, "\n")).toThrow(/multiple text/);
    const cached = await fixture('<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>First</w:t><w:lastRenderedPageBreak/><w:t>Second</w:t></w:r></w:p>');
    expect(cached.canEdit).toBe(true);
    const changed = replaceDocxRange(cached, range(cached, 0, 7), "\n").document;
    expect(changed.text).toBe("FirstSe\ncond");
    const reopened = await openDocx(await exportDocx(changed));
    expect(reopened.text).toBe(changed.text);
    expect(reopened.paragraphs.every((p) => p.runs.every((r) => r.style.italic))).toBe(true);
  });

  it("protects unmodeled paragraph XML comments and inter-paragraph source gaps atomically", async () => {
    for (const body of [
      '<w:p><!--retain this--><w:r><w:t>First</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>First</w:t></w:r><!--retain this--></w:p>',
      '<w:p><w:r><w:t>Fi<!--retain this-->rst</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>First</w:t></w:r></w:p><!--retain this--><w:p><w:r><w:t>Last</w:t></w:r></w:p>',
    ]) {
      const doc = await fixture(body), bytes = await exportDocx(doc);
      expect(doc.canEdit).toBe(true);
      expect(() => replaceDocxRange(doc, range(doc, 0, 1, doc.paragraphs.length - 1, 2), "\n")).toThrow(/source gaps/);
      expect(await exportDocx(doc)).toEqual(bytes);
    }
  });

  it("splits mixed runs, retaining raw properties, inherited paragraph context and exact caret", async () => {
    const doc = await fixture(mixed);
    expect(doc.canEdit).toBe(true);
    const result = replaceRichRange(doc, range(doc, 0, 6), "\n");
    expect(result.document.paragraphs.map((p) => p.text)).toEqual(["BoldIt", "alic"]);
    expect(result.document.paragraphs[0].id).toBe(doc.paragraphs[0].id);
    expect(result.document.paragraphs[1].id).not.toBe(doc.paragraphs[0].id);
    expect(result.selection).toEqual({ anchor: { paragraphId: result.document.paragraphs[1].id, offset: 0 }, focus: { paragraphId: result.document.paragraphs[1].id, offset: 0 } });
    const xml = await source(result.document);
    expect(xml).toContain('<w:r w:rsidR="12345678"><w:rPr><w:b/><w:lang w:val="en-US"/></w:rPr><w:t>Bold</w:t></w:r>');
    expect(xml.match(/<w:rPr><w:i\/><w:color w:themeColor="accent1"\/><\/w:rPr>/g)).toHaveLength(2);
    expect(xml.match(/w14:paraId=/g)).toHaveLength(1);
    expect(xml.match(/w14:textId=/g)).toHaveLength(1);
    const reopened = await openDocx(await exportDocx(result.document));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.paragraphs.every((p) => p.alignment === "center")).toBe(true);
    expect(reopened.paragraphs[1].runs[0].style.italic).toBe(true);
    expect(doc.text).toBe("BoldItalic");
  });

  it("joins adjacent boundaries without repainting mixed source runs", async () => {
    const doc = await fixture(mixed);
    const split = replaceDocxRange(doc, range(doc, 0, 4), "\n").document;
    const joined = replaceDocxRange(split, range(split, 0, 4, 1, 0), "");
    expect(joined.document.text).toBe(doc.text);
    expect(joined.document.paragraphs).toHaveLength(1);
    expect(joined.document.paragraphs[0].runs.map((r) => r.style)).toEqual(doc.paragraphs[0].runs.map((r) => r.style));
    expect(joined.selection.anchor).toEqual({ paragraphId: doc.paragraphs[0].id, offset: 4 });
  });

  it("replaces reverse multiblock selections and maps the inserted end before suffix", async () => {
    const doc = await createDocx("First\nMiddle\nLast\nUntouched");
    const result = replaceDocxRange(doc, range(doc, 2, 2, 0, 2), "X\nYZ");
    expect(result.document.text).toBe("FiX\nYZst\nUntouched");
    expect(result.document.paragraphs[0].id).toBe(doc.paragraphs[0].id);
    expect(result.document.paragraphs[2].id).toBe(doc.paragraphs[3].id);
    expect(result.selection.anchor).toEqual({ paragraphId: result.document.paragraphs[1].id, offset: 2 });
    expect(result.selection.focus).toEqual(result.selection.anchor);
    expect((await openDocx(await exportDocx(result.document))).text).toBe(result.document.text);
  });

  it("replaces within mixed runs without losing untouched rich prefix/suffix", async () => {
    const doc = await fixture(mixed);
    const result = replaceDocxRange(doc, range(doc, 0, 2, 0, 7), "XYZ");
    expect(result.document.text).toBe("BoXYZlic");
    expect(result.document.paragraphs[0].runs.map((r) => [r.text, r.style.bold, r.style.italic])).toEqual([
      ["Bo", true, undefined], ["XYZ", true, undefined], ["lic", undefined, true],
    ]);
    expect(result.selection.anchor.offset).toBe(5);
    const xml = await source(result.document);
    expect(xml).toContain('<w:color w:themeColor="accent1"/>');
    expect(xml.match(/<w:lang w:val="en-US"\/>/g)).toHaveLength(2);
  });

  it("retains both paragraph inheritance contexts in multiline cross-paragraph replacement", async () => {
    let doc = await createDocx("First\nLast");
    doc = applyDocxOperations(doc, [{ type: "format-paragraph", paragraphId: doc.paragraphs[0].id, format: { alignment: "center" } }, { type: "format-paragraph", paragraphId: doc.paragraphs[1].id, format: { alignment: "right" } }]);
    const result = replaceDocxRange(doc, range(doc, 0, 2, 1, 2), "X\nY");
    expect(result.document.paragraphs.map((p) => [p.text, p.alignment])).toEqual([["FiX", "center"], ["Yst", "right"]]);
    expect((await openDocx(await exportDocx(result.document))).paragraphs.map((p) => p.alignment)).toEqual(["center", "right"]);
  });

  it("splits empty paragraphs and retains exact unaffected paragraph bytes", async () => {
    const doc = await createDocx("\nUnchanged");
    const oldXml = await source(doc), untouched = oldXml.match(/<w:p><w:r><w:t xml:space="preserve">Unchanged<\/w:t><\/w:r><\/w:p>/)![0];
    const result = replaceDocxRange(doc, range(doc, 0, 0), "\n");
    expect(result.document.paragraphs.map((p) => p.text)).toEqual(["", "", "Unchanged"]);
    expect(result.document.paragraphs[2].id).toBe(doc.paragraphs[1].id);
    expect(await source(result.document)).toContain(untouched);
    expect((await openDocx(await exportDocx(result.document))).canEdit).toBe(true);
  });

  it("creates real editable text owners for end-Enter, delete-all and blank paste lines", async () => {
    const doc = await createDocx("abc");
    const entered = replaceDocxRange(doc, range(doc, 0, 3), "\n").document;
    expect(entered.paragraphs[1].runs.some((run) => run.canEdit && run.text === "")).toBe(true);
    const typed = replaceDocxText(entered, [{ runId: entered.paragraphs[1].runs[0].id, text: "X" }]);
    expect((await openDocx(await exportDocx(typed))).text).toBe("abc\nX");
    const deleted = replaceDocxRange(doc, range(doc, 0, 0, 0, 3), "").document;
    expect(deleted.paragraphs[0].runs.some((run) => run.canEdit)).toBe(true);
    const pasted = replaceDocxRange(doc, range(doc, 0, 3), "\n\n\n").document;
    for (const paragraph of pasted.paragraphs) expect(paragraph.runs.some((run) => run.canEdit)).toBe(true);
    const repeated = replaceDocxRange(entered, range(entered, 1, 0), "\n").document;
    for (const paragraph of repeated.paragraphs) expect(paragraph.runs.some((run) => run.canEdit)).toBe(true);
    const reopened = await openDocx(await exportDocx(pasted));
    for (const paragraph of reopened.paragraphs) expect(paragraph.runs.some((run) => run.canEdit)).toBe(true);
    const formatted = await fixture(mixed);
    const trailing = replaceDocxRange(formatted, range(formatted, 0, 10), "\n").document;
    expect(trailing.paragraphs[1].runs[0].style.italic).toBe(true);
    expect(await source(trailing)).toContain('<w:color w:themeColor="accent1"/>');
  });

  it("keeps authored empty formatting runs with deterministic right affinity", async () => {
    const empty = '<w:r w:rsidR="11223344"><w:rPr><w:b/></w:rPr><w:t/></w:r>';
    const doc = await fixture(`<w:p>${empty}<w:r><w:t>Text</w:t></w:r></w:p>`);
    const result = replaceDocxRange(doc, range(doc, 0, 0), "\n").document;
    expect(await source(result)).toContain(empty);
    expect(result.paragraphs[1].runs[0].style.bold).toBe(true);
    const onlyProperties = await fixture('<w:p><w:r><w:rPr><w:i/></w:rPr></w:r></w:p>');
    const typed = replaceDocxRange(onlyProperties, range(onlyProperties, 0, 0), "Typed").document;
    expect(typed.paragraphs[0].runs[0].style.italic).toBe(true);
    expect((await openDocx(await exportDocx(typed))).text).toBe("Typed");
  });

  it("keeps no-ops byte/snapshot/generation neutral and validates graphemes", async () => {
    const doc = await createDocx("A👨‍👩‍👧‍👦éZ");
    const bytes = await exportDocx(doc);
    const result = replaceDocxRange(doc, range(doc, 0, 1), "");
    expect(result.document).toBe(doc);
    expect(result.document.revision).toBe(doc.revision);
    expect(await exportDocx(result.document)).toEqual(bytes);
    for (const offset of [2, 3, 13, -1, 99, 0.5]) expect(() => replaceDocxRange(doc, range(doc, 0, offset), "x")).toThrow();
    const changed = replaceDocxRange(doc, range(doc, 0, 1, 0, 12), "🙂\n漢字");
    expect(changed.document.text).toBe("A🙂\n漢字éZ");
    expect(changed.selection.anchor.offset).toBe(2);
  });

  it("protects every intermediate owner and table boundaries atomically", async () => {
    let doc = await createDocx("Before\nMiddle\nAfter");
    doc = applyDocxOperations(doc, [{ type: "add-comment", paragraphId: doc.paragraphs[1].id, text: "Keep", author: "Tester" }]);
    const bytes = await exportDocx(doc);
    expect(() => replaceDocxRange(doc, range(doc, 0, 1, 2, 1), "x")).toThrow(/comments/);
    expect(await exportDocx(doc)).toEqual(bytes);
    const table = applyDocxOperations(await createDocx("Before\nAfter"), [{ type: "insert-table", afterParagraphId: "p0", rows: 1, columns: 1 }]);
    expect(() => replaceDocxRange(table, range(table, 0, 1, 2, 1), "x")).toThrow(/table/);
    expect(() => replaceDocxRange(table, range(table, 0, 1, 1, 0), "x")).toThrow(/cell/);
  });

  it("guards inherited-style changes, hyperlink owners and authored page breaks", async () => {
    let doc = await createDocx("One\nTwo");
    doc = applyDocxOperations(doc, [{ type: "format-paragraph", paragraphId: doc.paragraphs[1].id, format: { alignment: "right" } }]);
    expect(() => replaceDocxRange(doc, range(doc, 0, 3, 1, 0), "")).toThrow(/properties/);
    const linked = applyDocxOperations(doc, [{ type: "set-hyperlink", paragraphId: doc.paragraphs[0].id, start: 0, end: 3, target: "https://example.com" }]);
    expect(() => replaceDocxRange(linked, range(linked, 0, 1), "\n")).toThrow(/hyperlinks/);
    const page = applyDocxOperations(doc, [{ type: "insert-page-break", paragraphId: doc.paragraphs[0].id, offset: 1 }]);
    expect(() => replaceDocxRange(page, range(page, 0, 2), "\n")).toThrow(/authored breaks/);
  });

  it("preserves unrelated package parts and metadata and local text-node namespace declarations", async () => {
    const doc = await fixture('<w:p><w:r><x:t xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">Namespaced</x:t></w:r></w:p>');
    const before = await readZip(await exportDocx(doc));
    const result = replaceDocxRange(doc, range(doc, 0, 4), "\n").document;
    const after = await readZip(await exportDocx(result));
    for (const part of before.filter((p) => p.name !== "word/document.xml")) expect(after.find((p) => p.name === part.name)!.data).toEqual(part.data);
    expect(result.metadata).toBe(doc.metadata);
    expect((await openDocx(await exportDocx(result))).text).toBe("Name\nspaced");
  });

  it("captures insertion-run namespace context when the destination rebinds its prefix", async () => {
    const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const doc = await fixture(`<w:p xmlns:q="${word}"><q:r><q:rPr><q:b/></q:rPr><q:t>First</q:t></q:r></w:p><w:p xmlns:q="urn:unrelated"><w:r><w:t>Last</w:t></w:r></w:p>`);
    const result = replaceDocxRange(doc, range(doc, 0, 2, 1, 2), "X\nY").document;
    const reopened = await openDocx(await exportDocx(result));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.text).toBe("FiX\nYst");
    expect(reopened.paragraphs[1].runs[0].style.bold).toBe(true);
    expect(() => replaceDocxRange(doc, range(doc, 0, 5, 1, 0), "")).toThrow(/namespace scopes/);
  });

  it("retains actual core metadata and its original package bytes", async () => {
    const parts = await readZip(await exportDocx(await createDocx("Source")));
    const relationships = parts.find((p) => p.name === "_rels/.rels")!;
    relationships.data = encoder.encode(decoder.decode(relationships.data).replace('</Relationships>', '<Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'));
    const core = encoder.encode('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Preserved title</dc:title><dc:creator>Original author</dc:creator></cp:coreProperties>');
    parts.push({ name: "docProps/core.xml", data: core });
    const doc = await openDocx(writeZip(parts));
    const result = replaceDocxRange(doc, range(doc, 0, 3), "\n").document;
    expect(result.metadata).toEqual({ title: "Preserved title", creator: "Original author" });
    const outputParts = await readZip(await exportDocx(result));
    expect(outputParts.find((p) => p.name === "docProps/core.xml")!.data).toEqual(core);
    expect((await openDocx(await exportDocx(result))).metadata).toEqual(doc.metadata);
  });

  it("does not silently route structural edits through lossy other-format operations", async () => {
    const doc = await createRtf("RTF");
    expect(() => replaceRichRange(doc, range(doc as unknown as DocxDocument, 0, 1), "\n")).toThrow(/not yet supported/);
  });
});
