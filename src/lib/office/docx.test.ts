import { describe, expect, it } from "vitest";
import { createDocx, exportDocx, openDocx, replaceDocxText } from "./docx";
import { readZip, writeZip, type ZipEntry } from "./zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
async function fixture(transform: (entries: ZipEntry[]) => ZipEntry[] | void): Promise<Uint8Array> {
  const entries = await readZip(await exportDocx(await createDocx("Hello\nWorld")));
  const result = transform(entries);
  return writeZip(result || entries);
}
function changeXml(entries: ZipEntry[], name: string, change: (xml: string) => string): void {
  const entry = entries.find((e) => e.name === name)!;
  entry.data = encoder.encode(change(decoder.decode(entry.data)));
}
function body(entries: ZipEntry[], markup: string): void {
  changeXml(entries, "word/document.xml", () => `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${markup}</w:body></w:document>`);
}
function addRelationship(entries: ZipEntry[], kind: string, target: string, extra = ""): void {
  const mainRels = "word/_rels/document.xml.rels";
  entries.push({ name: mainRels, data: encoder.encode(`<Relationships xmlns="${REL}"><Relationship Id="rId2" Type="${R}/${kind}" Target="${target}"${extra}/></Relationships>`) });
}

describe("original DOCX package text foundation", () => {
  it("creates minimal packages and exposes immutable text snapshots", async () => {
    const doc = await createDocx("Hello 😀\r\nSecond line\n");
    expect(doc.format).toBe("docx");
    expect(doc.text).toBe("Hello 😀\nSecond line\n");
    expect(doc.canEdit).toBe(true);
    expect(doc.paragraphs).toHaveLength(3);
    expect(doc.modified).toBe(false);
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.paragraphs[0].runs[0].style)).toBe(true);
  });

  it("returns the byte-identical owned original when untouched or reverted", async () => {
    const bytes = await fixture(() => {});
    const original = new Uint8Array(bytes);
    const pending = openDocx(bytes);
    bytes.fill(0); // Mutating the caller's buffer during async inflation cannot change the snapshot.
    const doc = await pending;
    const exported = await exportDocx(doc);
    expect(exported).toEqual(original);
    exported.fill(0);
    expect(await exportDocx(doc)).toEqual(original);
    const run = doc.paragraphs[0].runs[0];
    const changed = replaceDocxText(doc, [{ runId: run.id, text: "Changed" }]);
    const reverted = replaceDocxText(changed, [{ runId: run.id, text: run.text }]);
    expect(reverted.modified).toBe(false);
    expect(await exportDocx(reverted)).toEqual(original);
  });

  it("edits explicit runs, escapes markup, preserves styling and all unrelated part payloads", async () => {
    const bytes = await fixture((entries) => {
      body(entries, '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:i w:val="false"/><w:sz w:val="28"/><w:rFonts w:ascii="Arial"/><w:color w:val="123456"/></w:rPr><w:t>Hello</w:t></w:r><w:r><w:t> tail</w:t></w:r></w:p>');
      entries.push({ name: "custom/preserve.bin", data: new Uint8Array([0, 1, 255, 2]) });
      changeXml(entries, "[Content_Types].xml", (xml) => xml.replace("</Types>", '<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
    });
    const doc = await openDocx(bytes);
    expect(doc.paragraphs[0].styleId).toBe("Heading1");
    expect(doc.paragraphs[0].alignment).toBe("center");
    expect(doc.paragraphs[0].runs[0].style).toMatchObject({ bold: true, italic: false, fontFamily: "Arial", fontSizePoints: 14, color: "123456" });
    const edited = replaceDocxText(doc, [{ runId: "p0:r0", text: "  <&> 😀\r  " }]);
    expect(doc.text).toBe("Hello tail");
    expect(edited.revision).toBe(1);
    expect(edited.modified).toBe(true);
    const output = await exportDocx(edited);
    const reopened = await openDocx(output);
    expect(reopened.text).toBe("  <&> 😀\r   tail");
    expect(reopened.paragraphs[0].runs[0].style).toEqual(doc.paragraphs[0].runs[0].style);
    const before = await readZip(bytes);
    const after = await readZip(output);
    for (const part of before.filter((p) => p.name !== "word/document.xml")) {
      expect(after.find((p) => p.name === part.name)?.data).toEqual(part.data);
    }
    expect(decoder.decode(after.find((p) => p.name === "word/document.xml")!.data)).toContain('<w:t xml:space="preserve">  &lt;&amp;&gt; 😀&#13;  </w:t>');
  });

  it("reads strict namespaces and arbitrary Word namespace prefixes", async () => {
    const bytes = await fixture((entries) => {
      changeXml(entries, "word/document.xml", (xml) => xml.replaceAll(W, "http://purl.oclc.org/ooxml/wordprocessingml/main").replaceAll("w:", "q:").replace("xmlns:w", "xmlns:q"));
      changeXml(entries, "_rels/.rels", (xml) => xml.replaceAll(R, "http://purl.oclc.org/ooxml/officeDocument/relationships"));
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect((await openDocx(await exportDocx(replaceDocxText(doc, [{ runId: "p0:r0", text: "Strict" }])))).text).toBe("Strict\nWorld");
  });

  it("resolves the main part through relationships, not a hardcoded path", async () => {
    const bytes = await fixture((entries) => {
      entries.find((e) => e.name === "word/document.xml")!.name = "content/main.xml";
      changeXml(entries, "_rels/.rels", (xml) => xml.replace("word/document.xml", "content/main.xml"));
      changeXml(entries, "[Content_Types].xml", (xml) => xml.replace("word/document.xml", "content/main.xml"));
    });
    const doc = await openDocx(bytes);
    expect(doc.text).toBe("Hello\nWorld");
    expect((await openDocx(await exportDocx(replaceDocxText(doc, [{ runId: "p1:r0", text: "Elsewhere" }])))).text).toBe("Hello\nElsewhere");
  });

  it.each([
    '<w:p><w:r><w:t>A</w:t><w:drawing/></w:r></w:p>',
    '<w:p><w:r><w:t>A</w:t><w:unknown/></w:r></w:p>',
    '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>A</w:t></w:r></w:p>',
    '<w:p><w:ins w:id="1"><w:r><w:t>A</w:t></w:r></w:ins></w:p>',
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:t>A</w:t></w:r></w:p>',
    '<w:p><w:bookmarkStart w:id="1" w:name="x"/><w:r><w:t>A</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>A</w:t></w:r></w:p>',
    '<w:p w:unknown="true"><w:r><w:t>A</w:t></w:r></w:p>',
  ])("fails closed for unsupported markup while preserving original bytes: %s", async (markup) => {
    const bytes = await fixture((entries) => body(entries, markup));
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => ["unsupported-markup", "unsupported-comments", "unsupported-revisions"].includes(d.code) && d.message.includes("Read-only"))).toBe(true);
    expect(() => replaceDocxText(doc, [{ runId: "p0:r0", text: "no" }])).toThrow(/safely edited/);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("keeps a run with several text nodes read-only and verbatim while the rest of the document stays editable", async () => {
    const markup = '<w:p><w:r><w:t>A</w:t><w:t>B</w:t></w:r></w:p><w:p><w:r><w:t>Plain</w:t></w:r></w:p>';
    const bytes = await fixture((entries) => body(entries, markup));
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.paragraphs[0].runs[0]).toMatchObject({ text: "AB", canEdit: false });
    expect(() => replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "no" }])).toThrow(/Unknown/);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: doc.paragraphs[1].runs[0].id, text: "Edited" }]));
    const xml = decoder.decode((await readZip(output)).find((e) => e.name === "word/document.xml")!.data);
    expect(xml).toContain("<w:r><w:t>A</w:t><w:t>B</w:t></w:r>");
    expect((await openDocx(output)).text).toBe("AB\nEdited");
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("preserves an unreferenced external hyperlink relationship without fetching it, and stays editable", async () => {
    const bytes = await fixture((entries) => addRelationship(entries, "hyperlink", "https://example.invalid/private", ' TargetMode="External"'));
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.hyperlinks).toEqual([]);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "Changed" }]));
    const rels = (await readZip(output)).find((e) => e.name === "word/_rels/document.xml.rels")!;
    expect(decoder.decode(rels.data)).toContain('Target="https://example.invalid/private" TargetMode="External"');
  });

  it.each(["attachedTemplate", "image", "oleObject", "frame", "subDocument"])("keeps external %s targets read-only because Word would load them", async (kind) => {
    const bytes = await fixture((entries) => addRelationship(entries, kind, "https://example.invalid/remote", ' TargetMode="External"'));
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "external-relationship")).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("honors document protection and revision settings outside the main part", async () => {
    const bytes = await fixture((entries) => {
      addRelationship(entries, "settings", "settings.xml");
      entries.push({ name: "word/settings.xml", data: encoder.encode(`<w:settings xmlns:w="${W}"><w:documentProtection w:edit="readOnly"/></w:settings>`) });
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "protected-or-review-document")).toBe(true);
  });

  it("finds protection in extensionless or non-.xml parts via content types, not filenames", async () => {
    const bytes = await fixture((entries) => {
      addRelationship(entries, "settings", "settings.dat");
      entries.push({ name: "word/settings.dat", data: encoder.encode(`<w:settings xmlns:w="${W}"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>`) });
      changeXml(entries, "[Content_Types].xml", (xml) => xml.replace("</Types>", '<Override PartName="/word/settings.dat" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "protected-or-review-document")).toBe(true);
  });

  it("fails closed if a settings relationship has an opaque content type", async () => {
    const bytes = await fixture((entries) => {
      addRelationship(entries, "settings", "settings.dat");
      entries.push({ name: "word/settings.dat", data: encoder.encode(`<w:settings xmlns:w="${W}"><w:trackRevisions/></w:settings>`) });
      changeXml(entries, "[Content_Types].xml", (xml) => xml.replace("</Types>", '<Default Extension="dat" ContentType="application/octet-stream"/></Types>'));
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "opaque-formatting-dependency")).toBe(true);
  });

  it("does not trust dependency role names from unrecognized relationship namespaces", async () => {
    const bytes = await fixture((entries) => {
      addRelationship(entries, "settings", "settings.xml");
      entries.push({ name: "word/settings.xml", data: encoder.encode(`<w:settings xmlns:w="${W}"/>`) });
      changeXml(entries, "word/_rels/document.xml.rels", (xml) => xml.replace(`${R}/settings`, "https://unrecognized.invalid/settings"));
    });
    expect((await openDocx(bytes)).canEdit).toBe(false);
  });

  it("rejects malformed XML closing tags before edits or export", async () => {
    await expect(openDocx(await fixture((entries) => changeXml(entries, "word/document.xml", (xml) => xml.replace("</w:t>", "</ w:t>"))))).rejects.toThrow(/closing XML tag/);
  });

  it.each([
    (xml: string) => xml.replace("w:pgSz w:w=", "w:pgSz\u00a0w:w="),
    (xml: string) => xml.replace("<?xml version", "<?XML version"),
    (xml: string) => xml + "&#32;",
  ])("rejects malformed XML declaration or non-XML whitespace in an editable package", async (change) => {
    await expect(openDocx(await fixture((entries) => changeXml(entries, "word/document.xml", change)))).rejects.toThrow();
  });

  it("extracts core metadata without interpreting custom XML", async () => {
    const bytes = await fixture((entries) => {
      changeXml(entries, "_rels/.rels", (xml) => xml.replace("</Relationships>", `<Relationship Id="core" Type="${REL}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`));
      entries.push({ name: "docProps/core.xml", data: encoder.encode('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Generated title</dc:title><dc:creator>Test author</dc:creator></cp:coreProperties>') });
    });
    const doc = await openDocx(bytes);
    expect(doc.metadata).toEqual({ title: "Generated title", creator: "Test author" });
    expect(doc.canEdit).toBe(true);
  });

  it("rejects missing relationship targets and unresolved document references", async () => {
    await expect(openDocx(await fixture((entries) => addRelationship(entries, "styles", "missing.xml")))).rejects.toThrow(/missing/);
    await expect(openDocx(await fixture((entries) => body(entries, '<w:p><w:hyperlink r:id="absent"><w:r><w:t>A</w:t></w:r></w:hyperlink></w:p>')))).rejects.toThrow(/Unresolved/);
    await expect(openDocx(await fixture((entries) => addRelationship(entries, "styles", "../../escape.xml")))).rejects.toThrow(/escapes/);
    await expect(openDocx(await fixture((entries) => changeXml(entries, "_rels/.rels", (xml) => xml.replace("word/document.xml", "https://bad.test/a"))))).rejects.toThrow(/unsafe/);
  });

  it("rejects macros, duplicate relationship IDs and malformed manifests/XML", async () => {
    await expect(openDocx(await fixture((entries) => changeXml(entries, "[Content_Types].xml", (xml) => xml.replace("wordprocessingml.document.main+xml", "word.document.macroEnabled.main+xml"))))).rejects.toThrow(/non-macro/);
    await expect(openDocx(await fixture((entries) => changeXml(entries, "_rels/.rels", (xml) => xml.replace("</Relationships>", `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`))))).rejects.toThrow(/duplicate/);
    await expect(openDocx(await fixture((entries) => changeXml(entries, "[Content_Types].xml", () => `<Types xmlns="${CT}"/>`)))).rejects.toThrow(/no declared/);
    await expect(openDocx(await fixture((entries) => changeXml(entries, "word/document.xml", (xml) => '<!DOCTYPE x [<!ENTITY x "a">]>' + xml)))).rejects.toThrow(/DTD/);
  });

  it("rejects invalid edit IDs, duplicate edits, control characters, tabs, breaks and forged snapshots atomically", async () => {
    const doc = await createDocx("A");
    expect(() => replaceDocxText(doc, [{ runId: "missing", text: "B" }])).toThrow(/Unknown/);
    expect(() => replaceDocxText(doc, [{ runId: "p0:r0", text: "B" }, { runId: "p0:r0", text: "C" }])).toThrow(/duplicate/);
    for (const text of ["a\nb", "a\tb", "\u0000", "\ud800"]) expect(() => replaceDocxText(doc, [{ runId: "p0:r0", text }])).toThrow();
    expect(doc.text).toBe("A");
    expect(() => replaceDocxText({ ...doc }, [])).toThrow(/originate/);
    await expect(exportDocx({ ...doc })).rejects.toThrow(/originate/);
  });

  it("bounds edits and handles self-closing text nodes without corrupting XML", async () => {
    const bytes = await fixture((entries) => body(entries, "<w:p><w:r><w:t/></w:r></w:p>"));
    const doc = await openDocx(bytes, { maxEntryBytes: 2000 });
    expect((await openDocx(await exportDocx(replaceDocxText(doc, [{ runId: "p0:r0", text: "new" }])))).text).toBe("new");
    expect(() => replaceDocxText(doc, [{ runId: "p0:r0", text: "A".repeat(3000) }])).toThrow(/limit/);
  });
});
