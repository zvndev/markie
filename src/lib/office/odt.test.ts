import { describe, expect, it } from "vitest";
import { applyOdtOperations, createOdt, exportOdt, isSameOdtSource, openOdt, replaceOdtText } from "./odt";
import { ODT_FIXTURE_CONTENT, ODT_FIXTURE_STYLES, odtFixture } from "./odt.fixture";
import { readZip, writeZip } from "./zip";
import { createDocx } from "./docx";
import type { NativeRichDocument } from "./rich-text-types";

describe("original bounded ODT codec", () => {
  it("reads defaults, per-property parent inheritance, spans and relative sizes", async () => {
    const doc = await openOdt(odtFixture());
    expect(doc.format).toBe("odt"); expect(doc.canEdit).toBe(true);
    expect(doc.paragraphs[0].text).toBe("OpenDocument editing works.");
    expect(doc.paragraphs[0]).toMatchObject({ alignment: "center", spacingBeforePoints: 3, spacingAfterPoints: 6 });
    expect(doc.paragraphs[0].runs.find(r => r.text.includes("editing"))?.style).toMatchObject({ bold: true, fontFamily: "Georgia", fontSizePoints: 20, color: "336699" });
    expect(doc.paragraphs[1].text).toBe("Unicode: café, Ελληνικά, 日本語, 👋  tabs\tand\nlines.");
  });
  it("inherits enclosing span and paragraph properties before family defaults", async () => {
    const styles = ODT_FIXTURE_STYLES.replace('<office:styles>', '<office:styles><style:default-style style:family="text"><style:text-properties fo:font-size="10pt" fo:color="#ff0000" fo:font-family="Courier New" fo:font-style="italic"/></style:default-style>');
    const content = ODT_FIXTURE_CONTENT.replace('  editing </text:span>', 'outer <text:span>inner</text:span> end</text:span>');
    const doc = await openOdt(odtFixture({ styles, content }));
    for (const run of doc.paragraphs[0].runs.filter(r => /outer|inner|end/.test(r.text))) {
      expect(run.style).toMatchObject({ fontSizePoints: 20, color: "336699", fontFamily: "Georgia", bold: true, italic: true });
    }
    expect(doc.paragraphs[0].runs.find(r => r.text.includes("inner"))?.style.fontSizePoints).toBe(20);
    const next = applyOdtOperations(doc, [{ type: "replace-paragraph", paragraphId: doc.paragraphs[1].id, text: "Edit" }]);
    const restored = await openOdt(await exportOdt(next));
    for (const run of restored.paragraphs[0].runs.filter(r => /outer|inner|end/.test(r.text))) expect(run.style).toMatchObject({ fontSizePoints: 20, color: "336699", fontFamily: "Georgia", bold: true, italic: true });
  });
  it("exports unchanged source byte for byte and owns an isolated input copy", async () => {
    const bytes = odtFixture(), original = bytes.slice();
    const pending = openOdt(bytes); bytes.fill(0); const doc = await pending;
    expect(await exportOdt(doc)).toEqual(original);
    const exported = await exportOdt(doc); exported.fill(0); expect(await exportOdt(doc)).toEqual(original);
  });
  it("edits and reopens same-format while preserving all unrelated part bytes", async () => {
    const bytes = odtFixture(), before = await readZip(bytes), doc = await openOdt(bytes);
    const next = applyOdtOperations(doc, [{ type: "format-range", paragraphId: doc.paragraphs[0].id, start: 0, end: 12, style: { italic: true, color: "990000" } },
      { type: "format-paragraph", paragraphId: doc.paragraphs[1].id, format: { alignment: "right", spacingAfterPoints: 9 } }]);
    const changed = replaceOdtText(next, [{ runId: next.paragraphs[1].runs[0].id, text: " Retained  spaces\tand\nUnicode 👋 " }]);
    const output = await exportOdt(changed), after = await readZip(output), reopened = await openOdt(output);
    expect(reopened.paragraphs[0].runs[0].style).toMatchObject({ italic: true, color: "990000", fontFamily: "Georgia" });
    expect(reopened.paragraphs[1]).toMatchObject({ alignment: "right", spacingAfterPoints: 9 });
    expect(reopened.paragraphs[1].text).toBe(" Retained  spaces\tand\nUnicode 👋 ");
    for (const part of before.filter(e => e.name !== "content.xml")) expect(after.find(e => e.name === part.name)?.data).toEqual(part.data);
    expect(new TextDecoder().decode(output.slice(30, 38))).toBe("mimetype");
    expect(new DataView(output.buffer).getUint16(8, true)).toBe(0);
    expect(new DataView(output.buffer).getUint16(28, true)).toBe(0);
    expect(await exportOdt(doc)).toEqual(bytes);
  });
  it("creates a real ODT package and handles empty and new paragraphs", async () => {
    const doc = await createOdt("Hello\n\n World ");
    expect(doc.text).toBe("Hello\n\n World ");
    const next = applyOdtOperations(doc, [{ type: "insert-paragraph", afterParagraphId: doc.paragraphs[0].id, text: "Inserted" }]);
    expect((await openOdt(await exportOdt(next))).text).toBe("Hello\nInserted\n\n World ");
  });
  it("keeps unchanged/no-op operations byte neutral", async () => {
    const bytes = odtFixture(), doc = await openOdt(bytes);
    expect(await exportOdt(replaceOdtText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: doc.paragraphs[0].runs[0].text }]))).toEqual(bytes);
  });
  it("keeps clear-format defaults identical on the canvas and after reopening", async () => {
    const bytes = odtFixture(), doc = await openOdt(bytes);
    const next = applyOdtOperations(doc, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { fontFamily: null, fontSizePoints: null, color: null } }]);
    expect(next.paragraphs[0].runs[0].style).toMatchObject({ fontFamily: "Georgia", fontSizePoints: 12, color: "222222" });
    const output = await exportOdt(next), reopened = await openOdt(output);
    expect(reopened.paragraphs[0].runs[0].style).toMatchObject(next.paragraphs[0].runs[0].style);
    const originalParts = await readZip(bytes), editedParts = await readZip(output);
    expect(editedParts.find(p => p.name === "styles.xml")?.data).toEqual(originalParts.find(p => p.name === "styles.xml")?.data);
    const inserted = applyOdtOperations(doc, [{ type: "insert-paragraph", text: "New defaults" }]);
    const restored = await openOdt(await exportOdt(inserted));
    expect(restored.paragraphs[0].runs[0].style).toMatchObject(inserted.paragraphs[0].runs[0].style);
    expect(inserted.paragraphs[0].runs[0].style).toMatchObject({ fontFamily: "Georgia", fontSizePoints: 12, color: "222222" });
  });
  it("rebases paragraph resets to retained default alignment and spacing", async () => {
    const styles = ODT_FIXTURE_STYLES.replace('<style:default-style style:family="paragraph">', '<style:default-style style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="2pt" fo:margin-bottom="4pt" fo:line-height="150%"/>');
    const doc = await openOdt(odtFixture({ styles }));
    const next = applyOdtOperations(doc, [{ type: "format-paragraph", paragraphId: doc.paragraphs[0].id, format: { alignment: null, spacingBeforePoints: null, spacingAfterPoints: null, lineSpacingMultiple: null } }]);
    expect(next.paragraphs[0]).toMatchObject({ alignment: "right", spacingBeforePoints: 2, spacingAfterPoints: 4, lineSpacingMultiple: 1.5 });
    const restored = await openOdt(await exportOdt(next));
    expect(restored.paragraphs[0]).toMatchObject({ alignment: "right", spacingBeforePoints: 2, spacingAfterPoints: 4, lineSpacingMultiple: 1.5 });
  });
  it.each(['fo:line-height="600%"', 'fo:line-height="49%"', 'fo:margin-top="1001pt"', 'fo:margin-bottom="2000pt"'])("rejects imported defaults outside the editable model bounds: %s", async property => {
    const styles = ODT_FIXTURE_STYLES.replace('<style:default-style style:family="paragraph">', `<style:default-style style:family="paragraph"><style:paragraph-properties ${property}/>`);
    await expect(openOdt(odtFixture({ styles }))).rejects.toThrow("supported");
  });
  it("accepts and edits paragraph defaults exactly at the model limits", async () => {
    const styles = ODT_FIXTURE_STYLES.replace('<style:default-style style:family="paragraph">', '<style:default-style style:family="paragraph"><style:paragraph-properties fo:line-height="500%" fo:margin-top="1000pt" fo:margin-bottom="1000pt"/>');
    const doc = await openOdt(odtFixture({ styles }));
    const next = applyOdtOperations(doc, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { italic: true } }]);
    const restored = await openOdt(await exportOdt(next));
    expect(restored.paragraphs[1]).toMatchObject({ lineSpacingMultiple: 5, spacingBeforePoints: 1000, spacingAfterPoints: 1000 });
  });
  it("bounds explicit-space expansion cumulatively before allocating repeated strings", async () => {
    const content = ODT_FIXTURE_CONTENT.replace(/<office:text>[\s\S]*<\/office:text>/, `<office:text><text:p>${'<text:s text:c="100000"/>'.repeat(11)}</text:p></office:text>`);
    await expect(openOdt(odtFixture({ content }))).rejects.toThrow("decoded text");
    const across = ODT_FIXTURE_CONTENT.replace(/<office:text>[\s\S]*<\/office:text>/, `<office:text>${'<text:p><text:s text:c="100000"/></text:p>'.repeat(11)}</office:text>`);
    await expect(openOdt(odtFixture({ content: across }))).rejects.toThrow("decoded text");
  });
  it("reopens an edited million-space document within the original parser budgets", async () => {
    const content = ODT_FIXTURE_CONTENT.replace(/<office:text>[\s\S]*<\/office:text>/, `<office:text><text:p>${'<text:s text:c="100000"/>'.repeat(10)}</text:p></office:text>`);
    const doc = await openOdt(odtFixture({ content }));
    expect(doc.text.length).toBe(1_000_000);
    const next = applyOdtOperations(doc, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { bold: true } }]);
    const output = await exportOdt(next);
    expect(output.length).toBeLessThan(10000);
    const restored = await openOdt(output);
    expect(restored.text).toBe(next.text);
    expect(restored.paragraphs[0].runs[0].style.bold).toBe(true);
  });
  it("rejects generated candidates beyond reader node budgets before returning save bytes", async () => {
    const doc = await createOdt("safe");
    const next = replaceOdtText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "\t".repeat(100001) }]);
    await expect(exportOdt(next)).rejects.toThrow("structure exceeds");
    expect((await openOdt(await exportOdt(doc))).text).toBe("safe");
  });
  it.each(["<office:text>", "<office:body>", '<office:automatic-styles>'])('rejects direct structural text under %s', async tag => {
    await expect(openOdt(odtFixture({ content: ODT_FIXTURE_CONTENT.replace(tag, `${tag}Silent loss`) }))).rejects.toThrow();
  });
  it("rejects foreign snapshots and unsupported mutations", async () => {
    const foreign = await createDocx("foreign") as unknown as NativeRichDocument;
    await expect(exportOdt(foreign)).rejects.toThrow("original ODT session");
    expect(() => applyOdtOperations(foreign, [])).toThrow("original ODT session");
    const doc = await openOdt(odtFixture());
    expect(() => applyOdtOperations(doc, [{ type: "set-page-layout", layout: { marginLeftPoints: 1000 } }])).toThrow("Margins");
    expect(() => applyOdtOperations(doc, [{ type: "insert-table", rows: 1, columns: 1 }])).toThrow();
  });
  it("recognizes only owned snapshots from the same opened source", async () => {
    const bytes = odtFixture(), first = await openOdt(bytes), second = await openOdt(bytes);
    const derived = applyOdtOperations(first, [{ type: "replace-paragraph", paragraphId: first.paragraphs[0].id, text: "Derived" }]);
    expect(isSameOdtSource(first, first)).toBe(true);
    expect(isSameOdtSource(first, derived)).toBe(true);
    expect(isSameOdtSource(first, second)).toBe(false);
    expect(isSameOdtSource(first, { ...first })).toBe(false);
    expect(isSameOdtSource({ ...first }, { ...first })).toBe(false);
  });
  it.each([{ color: "auto" }, { underline: "wave" }, { fontFamily: "Arial, serif" }])("rejects unrepresentable formatting before mutation %s", async style => {
    const bytes = odtFixture(), doc = await openOdt(bytes);
    expect(() => applyOdtOperations(doc, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style }])).toThrow();
    expect(await exportOdt(doc)).toEqual(bytes);
  });
  it("rejects literal carriage-return edits rather than losing them on reopening", async () => {
    const doc = await createOdt("safe");
    expect(() => replaceOdtText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "a\rb" }])).toThrow("carriage returns");
    await expect(createOdt("a\rb")).rejects.toThrow("carriage returns");
  });
  it("retains locally declared arbitrary namespace prefixes in existing automatic styles", async () => {
    const content = ODT_FIXTURE_CONTENT.replace(/<office:automatic-styles>[\s\S]*<\/office:automatic-styles>/, '<office:automatic-styles xmlns:z="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><z:style z:name="Centered" z:family="paragraph" z:parent-style-name="Body"/><z:style z:name="Accent" z:family="text"><z:text-properties fo:font-weight="bold"/></z:style></office:automatic-styles>');
    const doc = await openOdt(odtFixture({ content }));
    const next = applyOdtOperations(doc, [{ type: "replace-paragraph", paragraphId: doc.paragraphs[0].id, text: "Changed" }]);
    expect((await openOdt(await exportOdt(next))).paragraphs[0].text).toBe("Changed");
  });
  it("can edit a self-closing automatic-styles container without corrupting XML", async () => {
    const doc = await createOdt("simple");
    const parts = await readZip(await exportOdt(doc));
    const bytes = writeZip(parts.map(p => p.name === "content.xml" ? { ...p, data: new TextEncoder().encode(new TextDecoder().decode(p.data).replace('<office:body>', '<office:automatic-styles/><office:body>')) } : p));
    const opened = await openOdt(bytes);
    const next = applyOdtOperations(opened, [{ type: "format-run", runId: opened.paragraphs[0].runs[0].id, style: { bold: true } }]);
    expect((await openOdt(await exportOdt(next))).paragraphs[0].runs[0].style.bold).toBe(true);
  });
  it.each([
    ["table", '<table:table xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"/>'],
    ["heading", '<text:h>Not silently flattened</text:h>'],
    ["review", '<text:tracked-changes/>'],
    ["image", '<draw:frame xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"/>'],
  ])("rejects unsupported %s blocks", async (_name, node) => {
    await expect(openOdt(odtFixture({ content: ODT_FIXTURE_CONTENT.replace("<office:text>", `<office:text>${node}`) }))).rejects.toThrow("Unsupported ODT block");
  });
  it.each([
    ['<text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com">link</text:a>'],
    ['<text:bookmark text:name="hidden"/>'],
    ['<text:span text:style-name="Missing">text</text:span>'],
    ['<text:s text:c="100001"/>'],
    ['<text:s text:c="0"/>'],
  ])("rejects unsupported inline semantics %s", async node => {
    await expect(openOdt(odtFixture({ content: ODT_FIXTURE_CONTENT.replace("works.", node) }))).rejects.toThrow();
  });
  it("collapses raw whitespace across multiple nested span boundaries, not NBSP", async () => {
    const content = ODT_FIXTURE_CONTENT.replace(/<office:text>[\s\S]*<\/office:text>/, '<office:text><text:p>  a <text:span>  <text:span>b </text:span> </text:span> c\u00a0 d  </text:p></office:text>');
    expect((await openOdt(odtFixture({ content }))).text).toBe("a b c\u00a0 d");
  });
  it.each([
    ['fo:background-color="#ffff00"'], ['style:font-name-asian="CJK"'], ['fo:font-size="garbage"'], ['fo:font-size="1200pt"'],
    ['style:text-underline-type="double"'], ['style:font-size-rel="2pt"'], ['fo:font-weight="600"'],
  ])("rejects unsupported style properties %s", async property => {
    await expect(openOdt(odtFixture({ styles: ODT_FIXTURE_STYLES.replace('fo:font-size="16pt"', property) }))).rejects.toThrow();
  });
  it("rejects cyclic or missing style ancestry", async () => {
    await expect(openOdt(odtFixture({ styles: ODT_FIXTURE_STYLES.replace('style:name="Body"', 'style:name="Body" style:parent-style-name="Body"') }))).rejects.toThrow("Cyclic");
  });
  it("requires mimetype first and rejects wrong manifest media", async () => {
    const entries = await readZip(odtFixture());
    await expect(openOdt(writeZip([entries[1], entries[0], ...entries.slice(2)]))).rejects.toThrow("first");
    const swapped = entries.map(e => e.name === "META-INF/manifest.xml" ? { ...e, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('manifest:media-type="text/xml"', 'manifest:media-type="text/plain"')) } : e);
    await expect(openOdt(writeZip(swapped))).rejects.toThrow("media types");
  });
  it("rejects undeclared, missing, duplicate, encrypted and signed entries", async () => {
    const entries = await readZip(odtFixture());
    await expect(openOdt(writeZip([...entries, { name: "undeclared.bin", data: new Uint8Array([1]) }]))).rejects.toThrow("undeclared");
    await expect(openOdt(writeZip(entries.filter(e => e.name !== "meta.xml")))).rejects.toThrow("missing part");
    const manifest = new TextDecoder().decode(entries.find(e => e.name === "META-INF/manifest.xml")!.data);
    await expect(openOdt(odtFixture({ manifest: manifest.replace("</manifest:manifest>", '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>') }))).rejects.toThrow("duplicate");
    await expect(openOdt(odtFixture({ manifest: manifest.replace('manifest:media-type="text/xml"/>', 'manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>') }))).rejects.toThrow("Encrypted");
    await expect(openOdt(odtFixture({ extra: [{ name: "META-INF/documentsignatures.xml", data: new Uint8Array() }] }))).rejects.toThrow("Signed");
  });
  it("rejects DTDs and unsupported package versions", async () => {
    await expect(openOdt(odtFixture({ content: '<!DOCTYPE x SYSTEM "file:///secret">' + ODT_FIXTURE_CONTENT }))).rejects.toThrow("DTD");
    await expect(openOdt(odtFixture({ content: ODT_FIXTURE_CONTENT.replace('office:version="1.3"', 'office:version="1.4"') }))).rejects.toThrow("1.2/1.3");
  });
});
