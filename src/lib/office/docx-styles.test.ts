import { describe, expect, it } from "vitest";
import { applyDocxOperations, exportDocx, openDocx } from "./docx";
import { readZip, writeZip } from "./zip";
import { customStyleFixture } from "./docx-styles.fixture";

describe("original supported named-style resolution", () => {
  it("resolves defaults, inheritance and direct overrides without changing the imported package", async () => {
    const { document, bytes } = await customStyleFixture("EditorialLead");
    expect(document.styles).toContainEqual({ id: "EditorialLead", name: "Editorial lead" });
    expect(document.styles.some((style) => style.id === "CharacterAccent")).toBe(false);
    expect(document.paragraphs[0]).toMatchObject({ alignment: "center", spacingAfterPoints: 12 });
    expect(document.paragraphs[0].runs[0].style).toEqual({ bold: false, color: "cc0000", fontSizePoints: 9 });
    expect(document.paragraphs[0].runs[0].resolvedStyle).toEqual({ bold: false, italic: true, color: "cc0000", fontFamily: "Aptos", fontSizePoints: 9 });
    expect(document.paragraphs[0].runs[1].resolvedStyle).toMatchObject({ bold: true, italic: true, fontFamily: "Aptos", fontSizePoints: 16, color: "333333" });
    expect(document.paragraphs[1].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Cambria", fontSizePoints: 11, color: "333333" });
    expect(await exportDocx(document)).toEqual(bytes);
  });
  it("changes only the real paragraph style and preserves styles/other parts and direct run formatting on reopen", async () => {
    const { document, bytes, styles } = await customStyleFixture();
    const next = applyDocxOperations(document, [{ type: "format-paragraph", paragraphId: document.paragraphs[0].id, format: { styleId: "EditorialLead" } }]);
    const exported = await exportDocx(next), reopened = await openDocx(exported);
    expect(reopened.paragraphs[0].styleId).toBe("EditorialLead");
    expect(reopened.paragraphs[0].runs.map((run) => run.style)).toEqual(document.paragraphs[0].runs.map((run) => run.style));
    const originalParts = await readZip(bytes), nextParts = await readZip(exported);
    for (const part of originalParts.filter((part) => part.name !== "word/document.xml")) expect(nextParts.find((nextPart) => nextPart.name === part.name)?.data).toEqual(part.data);
    expect(new TextDecoder().decode(nextParts.find((part) => part.name === "word/styles.xml")!.data)).toBe(styles);
  });
  it("uses style toggle semantics but direct false is absolute and cyclic inheritance is bounded", async () => {
    const { document } = await customStyleFixture("Unbold");
    expect(document.paragraphs[0].runs[1].resolvedStyle?.bold).toBe(false);
    expect(document.paragraphs[0].runs[0].resolvedStyle?.bold).toBe(false);
    const cycle = await customStyleFixture("CycleA");
    expect(cycle.document.paragraphs[0].runs[1].resolvedStyle).toMatchObject({ bold: true, italic: true });
  });
  it("applies character-style properties after paragraph styles", async () => {
    const { bytes } = await customStyleFixture(); const parts = await readZip(bytes), encoder = new TextEncoder(), decoder = new TextDecoder();
    const main = parts.find((part) => part.name === "word/document.xml")!;
    main.data = encoder.encode(decoder.decode(main.data).replace("<w:r><w:t>Beta", '<w:r><w:rPr><w:rStyle w:val="CharacterAccent"/></w:rPr><w:t>Beta'));
    const document = await openDocx(writeZip(parts));
    expect(document.paragraphs[0].runs[1].resolvedStyle).toMatchObject({ color: "225588", underline: "single", bold: true });
    expect(document.paragraphs[0].runs[1].style).toEqual({});
  });
  it("does not misrepresent unresolved theme references or exact line heights as inherited literals", async () => {
    const { bytes } = await customStyleFixture("EditorialLead"), parts = await readZip(bytes), encoder = new TextEncoder(), decoder = new TextDecoder();
    const styles = parts.find((part) => part.name === "word/styles.xml")!;
    styles.data = encoder.encode(decoder.decode(styles.data).replace('<w:spacing w:after="240"/>', '<w:spacing w:after="240" w:line="400" w:lineRule="exact"/>').replace('<w:rPr><w:i/></w:rPr>', '<w:rPr><w:i/><w:rFonts w:asciiTheme="majorHAnsi"/><w:color w:val="778899" w:themeColor="accent1"/></w:rPr>'));
    const document = await openDocx(writeZip(parts));
    expect(document.paragraphs[0].runs[1].resolvedStyle?.fontFamily).toBeUndefined();
    expect(document.paragraphs[0].runs[1].resolvedStyle?.color).toBeUndefined();
    expect(document.paragraphs[0].lineSpacingMultiple).toBeUndefined();
    expect(document.paragraphs[0].runs[0].resolvedStyle?.color).toBe("cc0000");
  });
});
