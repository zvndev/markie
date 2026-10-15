import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { readZip, writeZip } from "./zip";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("original DOCX styles and single-level lists", () => {
  it("creates actual portable built-in heading definitions, preserving unrelated package parts", async () => {
    const original = await createDocx("Heading\nBody");
    const doc = applyDocxOperations(original, [{ type: "format-paragraph", paragraphId: "p0", format: { styleId: "Heading1" } }]);
    expect(doc.styles.map((s) => s.id)).toContain("Heading1");
    expect(doc.styles.map((s) => s.id)).toContain("Normal");
    const reopened = await openDocx(await exportDocx(doc));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.paragraphs[0].styleId).toBe("Heading1");
    const parts = await readZip(await exportDocx(doc));
    const styles = decoder.decode(parts.find((p) => p.name === "word/styles.xml")!.data);
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('<w:sz w:val="40"/>');
    expect(() => applyDocxOperations(original, [{ type: "format-paragraph", paragraphId: "p0", format: { styleId: "UndefinedStyle" } }])).toThrow(/not defined/);
  });

  it("round-trips bullet/numbered definitions, renders numbering and clears list formatting", async () => {
    const original = await createDocx("Bullet\nOne\nTwo\nPlain");
    const doc = applyDocxOperations(original, [
      { type: "set-list", paragraphId: "p0", kind: "bullet" },
      { type: "set-list", paragraphId: "p1", kind: "numbered" },
      { type: "set-list", paragraphId: "p2", kind: "numbered" },
      { type: "format-paragraph", paragraphId: "p1", format: { spacingAfterPoints: 6, alignment: "left" } },
    ]);
    expect(doc.paragraphs.map((p) => [p.listKind, p.listNumber])).toEqual([["bullet", undefined], ["numbered", 1], ["numbered", 2], [undefined, undefined]]);
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true);
    expect(saved.text).toBe(original.text); // Markers are semantic numbering, not inserted text.
    expect(saved.paragraphs[2]).toMatchObject({ listKind: "numbered", listNumber: 2 });
    const cleared = applyDocxOperations(doc, [{ type: "set-list", paragraphId: "p1", kind: null }]);
    expect((await openDocx(await exportDocx(cleared))).paragraphs[1].listKind).toBeUndefined();
    expect(cleared.paragraphs[1].spacingAfterPoints).toBe(6);
  });

  it("fails closed for unresolved and unsupported multi-level numbering", async () => {
    const original = applyDocxOperations(await createDocx("A"), [{ type: "set-list", paragraphId: "p0", kind: "numbered" }]);
    const parts = await readZip(await exportDocx(original));
    const numbering = parts.find((p) => p.name === "word/numbering.xml")!;
    numbering.data = encoder.encode(decoder.decode(numbering.data).replace('w:val="singleLevel"', 'w:val="multilevel"'));
    const bytes = writeZip(parts);
    const readonly = await openDocx(bytes);
    expect(readonly.canEdit).toBe(false);
    expect(readonly.diagnostics.some((d) => d.code === "unsupported-numbering")).toBe(true);
    expect(await exportDocx(readonly)).toEqual(bytes);
  });
});
