import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, type DocxOperation } from "./docx";
import { readZip, writeZip } from "./zip";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("original OPC mutation of override-only content-type manifests", () => {
  it.each([
    { label: "styles", operation: { type: "format-paragraph", paragraphId: "p0", format: { styleId: "Heading1" } } },
    { label: "comments", operation: { type: "add-comment", paragraphId: "p0", author: "A", text: "Portable comment" } },
    { label: "numbering", operation: { type: "set-list", paragraphId: "p0", kind: "numbered" } },
  ])("adds the new main relationship type declaration for $label without changing untouched originals", async ({ label, operation }) => {
    const parts = await readZip(await exportDocx(await createDocx("Original")));
    const manifest = parts.find((p) => p.name === "[Content_Types].xml")!;
    manifest.data = encoder.encode(decoder.decode(manifest.data).replace(/<Default Extension="rels"[^>]*\/>/, '<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'));
    const bytes = writeZip(parts);
    const original = await openDocx(bytes);
    expect(original.canEdit).toBe(true); expect(await exportDocx(original)).toEqual(bytes);
    const doc = applyDocxOperations(original, [operation as DocxOperation]);
    const candidate = await exportDocx(doc);
    const reopened = await openDocx(candidate);
    expect(reopened.canEdit).toBe(true);
    expect(reopened.text).toBe("Original");
    const exported = await readZip(candidate);
    const types = decoder.decode(exported.find((p) => p.name === "[Content_Types].xml")!.data);
    expect(types).toContain('PartName="/word/_rels/document.xml.rels"');
    expect(exported.some((p) => p.name === `word/${label}.xml`)).toBe(true);
    if (label === "styles") expect(reopened.paragraphs[0].styleId).toBe("Heading1");
    if (label === "comments") expect(reopened.comments[0].text).toBe("Portable comment");
    if (label === "numbering") expect(reopened.paragraphs[0].listKind).toBe("numbered");
    expect(await exportDocx(original)).toEqual(bytes);
  });
});
