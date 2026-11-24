import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyDocxOperations, exportDocx, getDocxEmbeddedFonts, openDocx } from "./docx";
import { deobfuscateDocxFont, docxFontKey, readDocxEmbeddedFonts, sfntFormat } from "./docx-fonts";
import { embeddedFontDocx, FIXTURE_FONT_FAMILY, FIXTURE_FONT_KEY, FIXTURE_FONT_PART, obfuscateFont } from "./docx-fonts.fixture";
import { readZip } from "./zip";

// A free font: fixtures/README.md.
const FONT = new Uint8Array(readFileSync(new URL("./fixtures/markie-fixture-hand.ttf", import.meta.url)));

describe("fonts embedded in a Word file", () => {
  it("reads a font key the way the specification lays it out", () => {
    // The GUID's last byte is the key's first.
    expect([...docxFontKey("{00014A78-CABC-4EF0-12AC-5CD89AEFDE00}")!]).toEqual([
      0x00, 0xde, 0xef, 0x9a, 0xd8, 0x5c, 0xac, 0x12, 0xf0, 0x4e, 0xbc, 0xca, 0x78, 0x4a, 0x01, 0x00,
    ]);
    expect(docxFontKey("00014a78-cabc-4ef0-12ac-5cd89aefde00")).toEqual(docxFontKey("{00014A78-CABC-4EF0-12AC-5CD89AEFDE00}"));
    for (const bad of [undefined, "", "{nope}", "{00014A78-CABC-4EF0-12AC-5CD89AEFDE0}", "{00014A78CABC4EF012AC5CD89AEFDE00}", "{00014A78-CABC-4EF0-12AC-5CD89AEFDE00}x"]) {
      expect(docxFontKey(bad)).toBeNull();
    }
  });

  it("restores exactly the bytes that were obfuscated, and only the first 32 differ", () => {
    const hidden = obfuscateFont(FONT, FIXTURE_FONT_KEY);
    expect(sfntFormat(FONT)).toBe("truetype");
    // What is in the package is not a loadable font until the key is applied.
    expect(sfntFormat(hidden)).toBeNull();
    expect([...hidden.subarray(32)]).toEqual([...FONT.subarray(32)]);
    expect([...hidden.subarray(0, 32)]).not.toEqual([...FONT.subarray(0, 32)]);
    const restored = deobfuscateDocxFont(hidden, FIXTURE_FONT_KEY)!;
    expect(Buffer.from(restored).equals(Buffer.from(FONT))).toBe(true);
    // The part handed in is left as it was.
    expect(sfntFormat(hidden)).toBeNull();
    expect(deobfuscateDocxFont(hidden, "not a key")).toBeNull();
    expect(deobfuscateDocxFont(hidden.subarray(0, 20), FIXTURE_FONT_KEY)).toBeNull();
  });

  it("finds the embedded font of an opened document, under the name its runs use", async () => {
    const document = await openDocx(embeddedFontDocx(FONT));
    expect(document.canEdit).toBe(true);
    expect(document.paragraphs[0].runs[0].style.fontFamily).toBe(FIXTURE_FONT_FAMILY);
    const fonts = getDocxEmbeddedFonts(document);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ family: FIXTURE_FONT_FAMILY, variant: "regular", format: "truetype", part: FIXTURE_FONT_PART });
    expect(Buffer.from(fonts[0].data).equals(Buffer.from(FONT))).toBe(true);
  });

  it("gives every snapshot of one opened file the same font list", async () => {
    const document = await openDocx(embeddedFontDocx(FONT));
    const edited = applyDocxOperations(document, [{ type: "replace-paragraph", paragraphId: document.paragraphs[1].id, text: "Changed" }]);
    expect(getDocxEmbeddedFonts(edited)).toBe(getDocxEmbeddedFonts(document));
  });

  it("keeps the embedded font, still obfuscated, and the real font names when saving", async () => {
    const source = embeddedFontDocx(FONT);
    const before = new Map((await readZip(source)).map((entry) => [entry.name, entry.data]));
    const document = await openDocx(source);
    const edited = applyDocxOperations(document, [
      { type: "replace-paragraph", paragraphId: document.paragraphs[1].id, text: "Still Calibri" },
    ]);
    const saved = await exportDocx(edited);
    const after = new Map((await readZip(saved)).map((entry) => [entry.name, entry.data]));
    for (const part of [FIXTURE_FONT_PART, "word/fontTable.xml", "word/_rels/fontTable.xml.rels"]) {
      expect(Buffer.from(after.get(part)!).equals(Buffer.from(before.get(part)!))).toBe(true);
    }
    expect(sfntFormat(after.get(FIXTURE_FONT_PART)!)).toBeNull();
    const reopened = await openDocx(saved);
    expect(Buffer.from(getDocxEmbeddedFonts(reopened)[0].data).equals(Buffer.from(FONT))).toBe(true);
    // A stand-in is how a missing font is painted. It is never what is saved.
    const main = new TextDecoder().decode(after.get("word/document.xml")!);
    expect(main).toContain(`w:ascii="${FIXTURE_FONT_FAMILY}"`);
    expect(main).toContain('w:ascii="Calibri"');
    expect(main).not.toMatch(/Carlito|Markie Embedded/);
  });

  it("writes the real name of a font chosen in the editor", async () => {
    const document = await openDocx(embeddedFontDocx(FONT));
    const run = document.paragraphs[1].runs[0];
    const edited = applyDocxOperations(document, [{ type: "format-run", runId: run.id, style: { fontFamily: "Cambria" } }]);
    const main = new TextDecoder().decode((await readZip(await exportDocx(edited))).find((entry) => entry.name === "word/document.xml")!.data);
    expect(main).toContain('w:ascii="Cambria"');
    expect(main).not.toContain("Caladea");
  });

  it("treats a font it cannot restore as no font, and still opens the document", async () => {
    const wrongKey = await openDocx(embeddedFontDocx(FONT, { declaredKey: "{FFFFFFFF-0000-4000-8000-000000000001}" }));
    expect(wrongKey.text).toContain("Set in the embedded font");
    expect(getDocxEmbeddedFonts(wrongKey)).toEqual([]);
    const noKey = await openDocx(embeddedFontDocx(FONT, { declaredKey: "garbage" }));
    expect(getDocxEmbeddedFonts(noKey)).toEqual([]);
  });

  it("never throws on a malformed font table", () => {
    const bytes = (value: string) => new TextEncoder().encode(value);
    expect(readDocxEmbeddedFonts([])).toEqual([]);
    expect(readDocxEmbeddedFonts([{ name: "word/fontTable.xml", data: bytes("<not xml") }])).toEqual([]);
    expect(readDocxEmbeddedFonts([{ name: "word/fontTable.xml", data: new Uint8Array([0xff, 0xfe, 0x00]) }])).toEqual([]);
    // A relationship that walks out of the package names nothing.
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    expect(readDocxEmbeddedFonts([
      { name: "word/fontTable.xml", data: bytes(`<w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="X"><w:embedRegular r:id="rId1" w:fontKey="${FIXTURE_FONT_KEY}"/></w:font></w:fonts>`) },
      { name: "word/_rels/fontTable.xml.rels", data: bytes(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/font" Target="../../../etc/font.odttf"/></Relationships>`) },
      { name: "etc/font.odttf", data: obfuscateFont(FONT, FIXTURE_FONT_KEY) },
    ])).toEqual([]);
  });
});
