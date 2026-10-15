import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText } from "./docx";
import { safeDocxHyperlinkTarget } from "./docx-hyperlinks";
import { readZip, writeZip } from "./zip";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("original safe DOCX text hyperlinks", () => {
  it("wraps only selected text in a real external relationship and reopens editable", async () => {
    const original = await createDocx("Read this document now");
    const doc = applyDocxOperations(original, [{ type: "set-hyperlink", paragraphId: "p0", start: 10, end: 18, target: "https://example.com/docs?q=one&x=two" }]);
    expect(doc.text).toBe(original.text);
    expect(doc.hyperlinks[0]).toMatchObject({ text: "document", target: "https://example.com/docs?q=one&x=two", paragraphId: "p0" });
    expect(doc.paragraphs[0].runs.find((r) => r.text === "document")?.target).toBe(doc.hyperlinks[0].target);
    const parts = await readZip(await exportDocx(doc));
    expect(decoder.decode(parts.find((p) => p.name === "word/document.xml")!.data)).toContain("<w:hyperlink ");
    expect(decoder.decode(parts.find((p) => p.name === "word/_rels/document.xml.rels")!.data)).toContain('TargetMode="External"');
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true); expect(saved.hyperlinks[0].target).toBe(doc.hyperlinks[0].target);
    expect(original.hyperlinks).toHaveLength(0);
  });

  it("keeps formatting/text/paragraph comments when linking, editing text, styling a range and unlinking", async () => {
    let doc = applyDocxOperations(await createDocx("Hello World"), [{ type: "format-range", paragraphId: "p0", start: 6, end: 11, style: { bold: true } }, { type: "set-hyperlink", paragraphId: "p0", start: 0, end: 11, target: "mailto:writer@example.com" }, { type: "add-comment", paragraphId: "p0", author: "A", text: "Comment survives" }]);
    expect(doc.comments).toHaveLength(1);
    const linkRun = doc.paragraphs[0].runs.find((r) => r.text === "World")!;
    doc = replaceDocxText(doc, [{ runId: linkRun.id, text: "Earth" }]);
    doc = applyDocxOperations(doc, [{ type: "format-range", paragraphId: "p0", start: 1, end: 9, style: { italic: true } }]);
    expect(doc.hyperlinks[0].text).toBe("Hello Earth");
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true); expect(saved.comments[0].text).toBe("Comment survives");
    expect(saved.paragraphs[0].runs.filter((r) => r.text && r.style.bold).map((r) => r.text).join("")).toBe("Earth");
    const removed = applyDocxOperations(doc, [{ type: "remove-hyperlink", hyperlinkId: doc.hyperlinks[0].id }]);
    const reopened = await openDocx(await exportDocx(removed));
    expect(reopened.text).toBe("Hello Earth"); expect(reopened.hyperlinks).toHaveLength(0); expect(reopened.comments).toHaveLength(1);
    expect(decoder.decode((await readZip(await exportDocx(removed))).find((p) => p.name === "word/_rels/document.xml.rels")!.data)).not.toContain("mailto:");
  });

  it("updates one link without changing another link sharing its original relationship", async () => {
    const original = applyDocxOperations(await createDocx("Link"), [{ type: "set-hyperlink", paragraphId: "p0", start: 0, end: 4, target: "https://example.com/private-token" }]);
    const parts = await readZip(await exportDocx(original));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    const xml = decoder.decode(main.data);
    const link = xml.match(/<w:hyperlink[^]*?<\/w:hyperlink>/)![0];
    main.data = encoder.encode(xml.replace(link, link + link));
    const doc = await openDocx(writeZip(parts));
    const secondId = doc.hyperlinks[1].id;
    const updated = applyDocxOperations(doc, [{ type: "update-hyperlink", hyperlinkId: doc.hyperlinks[0].id, target: "https://other.example/path" }]);
    expect(updated.hyperlinks.map((l) => l.target)).toEqual(["https://other.example/path", "https://example.com/private-token"]);
    expect(updated.hyperlinks[1].id).toBe(secondId);
    const removed = applyDocxOperations(updated, [{ type: "remove-hyperlink", hyperlinkId: updated.hyperlinks[0].id }, { type: "remove-hyperlink", hyperlinkId: secondId }]);
    expect((await openDocx(await exportDocx(removed))).text).toBe("LinkLink");
    const relXml = decoder.decode((await readZip(await exportDocx(removed))).find((p) => p.name === "word/_rels/document.xml.rels")!.data);
    expect(relXml).not.toContain("private-token"); expect(relXml).not.toContain("other.example");
  });

  it("declares newly created main relationship parts when the original manifest used overrides only", async () => {
    const parts = await readZip(await exportDocx(await createDocx("Link")));
    const manifest = parts.find((p) => p.name === "[Content_Types].xml")!;
    manifest.data = encoder.encode(decoder.decode(manifest.data).replace(/<Default Extension="rels"[^>]*\/>/, '<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'));
    const doc = await openDocx(writeZip(parts));
    const linked = applyDocxOperations(doc, [{ type: "set-hyperlink", paragraphId: "p0", start: 0, end: 4, target: "https://example.com" }]);
    expect((await openDocx(await exportDocx(linked))).canEdit).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.com", "//example.com", "https:example.com", "https://user:password@example.com", "https://example.com/\npath", "https://example.com/%0Aheader", "https://example.com/%00", "https://example.com\\evil", " https://example.com", "https://example.com\u00a0", "mailto:user@example.com?bcc=other@example.com", "mailto:user%0d%0a@example.com", "mailto:bad"])('rejects unsafe/unsupported target "%s"', (target) => {
    expect(() => safeDocxHyperlinkTarget(target)).toThrow();
  });

  it("keeps malicious imported targets read-only/byte-identical and rejects destructive paragraph flattening", async () => {
    const original = applyDocxOperations(await createDocx("Link\nOther"), [{ type: "set-hyperlink", paragraphId: "p0", start: 0, end: 4, target: "https://example.com" }]);
    expect(() => applyDocxOperations(original, [{ type: "replace-paragraph", paragraphId: "p0", text: "Flatten" }])).toThrow(/Remove hyperlinks/);
    expect(() => applyDocxOperations(original, [{ type: "track-paragraph-text", paragraphId: "p0", text: "Flatten", author: "A" }])).toThrow(/Remove hyperlinks/);
    const parts = await readZip(await exportDocx(original));
    const rel = parts.find((p) => p.name === "word/_rels/document.xml.rels")!;
    rel.data = encoder.encode(decoder.decode(rel.data).replace("https://example.com/", "javascript:alert(1)"));
    const bytes = writeZip(parts);
    const readonly = await openDocx(bytes);
    expect(readonly.canEdit).toBe(false); expect(await exportDocx(readonly)).toEqual(bytes);
  });
});
