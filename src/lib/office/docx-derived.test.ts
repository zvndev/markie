import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText, type DocxOperation } from "./docx";
import { readZip, writeZip } from "./zip";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
async function fixture(contents = '<w:proofErr w:type="spellStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="spellEnd"/>') {
  const entries = await readZip(await exportDocx(await createDocx("Hello\nWorld")));
  const main = entries.find((part) => part.name === "word/document.xml")!;
  main.data = encoder.encode(decoder.decode(main.data).replace(/<w:p>.*?<\/w:p>/, `<w:p>${contents}</w:p>`));
  const manifest = entries.find((part) => part.name === "[Content_Types].xml")!;
  manifest.data = encoder.encode(decoder.decode(manifest.data).replace("</Types>", '<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
  entries.push({ name: "custom/preserved.bin", data: new Uint8Array([0, 255, 18]) });
  return writeZip(entries);
}
async function source(bytes: Uint8Array) { return decoder.decode((await readZip(bytes)).find((part) => part.name === "word/document.xml")!.data); }

describe("passive Word proofing and calculated page boundaries", () => {
  it("opens ordinary proofing/cache markers without warnings and preserves untouched and identical-edit bytes", async () => {
    const bytes = await fixture(), document = await openDocx(bytes);
    expect(document.canEdit).toBe(true);
    expect(document.diagnostics.filter((item) => item.severity === "warning")).toEqual([]);
    expect(document.text).toBe("Hello\nWorld");
    expect(document.pageBreaks).toEqual([]);
    expect(await exportDocx(document)).toEqual(bytes);
    expect(await exportDocx(replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "Hello" }]))).toEqual(bytes);
    expect(await exportDocx(applyDocxOperations(document, []))).toEqual(bytes);
    expect(await exportDocx(applyDocxOperations(document, [{ type: "accept-all-revisions" }]))).toEqual(bytes);
  });

  it("invalidates derived analysis on real text changes without changing unrelated part payloads", async () => {
    const bytes = await fixture(), document = await openDocx(bytes);
    const changed = replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "Corrected" }]);
    const output = await exportDocx(changed), xml = await source(output);
    expect(xml).not.toMatch(/proofErr|lastRenderedPageBreak/);
    expect((await openDocx(output))).toMatchObject({ canEdit: true, text: "Corrected\nWorld" });
    const original = await readZip(bytes), saved = await readZip(output);
    for (const part of original.filter((part) => part.name !== "word/document.xml")) expect(saved.find((next) => next.name === part.name)?.data).toEqual(part.data);
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("preserves proofing on formatting, clears calculated pagination, and retains authored page breaks", async () => {
    const bytes = await fixture('<w:proofErr w:type="gramStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/><w:br w:type="page"/></w:r><w:proofErr w:type="gramEnd"/>');
    const document = await openDocx(bytes);
    expect(document.canEdit).toBe(true);
    const changed = applyDocxOperations(document, [{ type: "format-run", runId: document.paragraphs[0].runs[0].id, style: { bold: true } }]);
    const xml = await source(await exportDocx(changed));
    expect(xml).toContain('w:type="gramStart"'); expect(xml).toContain('w:type="gramEnd"');
    expect(xml).not.toContain("lastRenderedPageBreak"); expect(xml).toContain('<w:br w:type="page"/>');
    expect((await openDocx(await exportDocx(changed))).pageBreaks).toHaveLength(1);
  });

  it("edits and range-formats all text of cache-split runs without losing later text or local namespaces", async () => {
    const bytes = await fixture(`<w:r><w:rPr><w:i/></w:rPr><q:t xmlns:q="${W}">Hello</q:t><w:lastRenderedPageBreak/><w:t xml:space="preserve"> world</w:t></w:r>`);
    const document = await openDocx(bytes);
    expect(document.canEdit).toBe(true); expect(document.paragraphs[0].runs[0].text).toBe("Hello world");
    expect(await exportDocx(document)).toEqual(bytes);
    const changed = replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "New whole run" }]);
    expect((await openDocx(await exportDocx(changed))).text).toBe("New whole run\nWorld");
    const formatted = applyDocxOperations(document, [{ type: "format-range", paragraphId: document.paragraphs[0].id, start: 6, end: 11, style: { bold: true } }]);
    const reopened = await openDocx(await exportDocx(formatted));
    expect(reopened.text).toBe("Hello world\nWorld");
    expect(reopened.paragraphs[0].runs.find((run) => run.text === "world")?.style).toMatchObject({ bold: true, italic: true });
  });

  it.each(["replace-paragraph", "delete-paragraph", "insert-paragraph", "format-paragraph"] as const)("supports %s around cached annotations", async (type) => {
    const bytes = await fixture(), document = await openDocx(bytes), paragraphId = document.paragraphs[0].id;
    const operation: DocxOperation = type === "replace-paragraph" ? { type, paragraphId, text: "Replacement" }
      : type === "insert-paragraph" ? { type, afterParagraphId: paragraphId, text: "Inserted" }
      : type === "format-paragraph" ? { type, paragraphId, format: { alignment: "center" } } : { type, paragraphId };
    const changed = applyDocxOperations(document, [operation]), output = await exportDocx(changed), reopened = await openDocx(output);
    expect(reopened.canEdit).toBe(true); expect(await source(output)).not.toContain("lastRenderedPageBreak");
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("keeps the source and cache bytes intact when an atomic operation batch fails", async () => {
    const bytes = await fixture(), document = await openDocx(bytes);
    expect(() => applyDocxOperations(document, [
      { type: "format-run", runId: document.paragraphs[0].runs[0].id, style: { bold: true } },
      { type: "replace-paragraph", paragraphId: "missing", text: "No" },
    ])).toThrow();
    expect(document.modified).toBe(false); expect(await exportDocx(document)).toEqual(bytes);
  });

  it("keeps adjacent text nodes that are not a cached page split read-only per run, never merging them", async () => {
    const bytes = await fixture('<w:r><w:t>Hello</w:t><w:t>world</w:t><w:lastRenderedPageBreak/></w:r>');
    const document = await openDocx(bytes);
    expect(document.canEdit).toBe(true);
    expect(document.paragraphs[0].runs[0]).toMatchObject({ text: "Helloworld", canEdit: false });
    expect(() => replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "Blocked" }])).toThrow(/Unknown/);
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("confines invalidation of an in-run text edit to the edited paragraph", async () => {
    const bytes = await fixture('<w:proofErr w:type="spellStart"/><w:r><w:t>Hello</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="spellEnd"/></w:p><w:p><w:proofErr w:type="gramStart"/><w:r><w:t>Next</w:t><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="gramEnd"/>');
    const document = await openDocx(bytes);
    const before = await source(bytes);
    const changed = replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "Corrected" }]);
    const after = await source(await exportDocx(changed));
    const second = (xml: string) => xml.slice(xml.indexOf("gramStart") - 30);
    expect(second(after)).toBe(second(before));
    expect(after.slice(0, after.indexOf("gramStart"))).not.toMatch(/spellStart|spellEnd|lastRenderedPageBreak/);
  });

  it.each(["spellStart", "spellEnd", "gramStart", "gramEnd"])("treats unmatched %s as ignorable, per the public specification", async (type) => {
    const document = await openDocx(await fixture(`<w:proofErr w:type="${type}"/><w:r><w:t>Hello</w:t></w:r>`));
    expect(document.canEdit).toBe(true);
  });

  it.each([
    '<w:proofErr/>', '<w:proofErr w:type="other"/>', '<w:proofErr w:type="spellStart" w:unknown="1"/>',
    '<w:proofErr w:type="gramStart">hidden</w:proofErr>', '<w:proofErr w:type="gramStart"><w:r/></w:proofErr>',
    '<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak w:type="page"/></w:r>',
    '<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak>hidden</w:lastRenderedPageBreak></w:r>',
    '<w:r><w:t>Hello</w:t><w:lastRenderedPageBreak><w:t>hidden</w:t></w:lastRenderedPageBreak></w:r>',
    '<w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t>Hello</w:t></w:r>',
  ])("continues protecting malformed or unrelated unsupported markup: %s", async (markup) => {
    const bytes = await fixture(markup), document = await openDocx(bytes);
    expect(document.canEdit).toBe(false); expect(await exportDocx(document)).toEqual(bytes);
    expect(() => replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0]?.id ?? "missing", text: "Blocked" }])).toThrow(/safely/);
  });
});
