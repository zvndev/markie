import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { applyRtfOperations, createRtf, exportRtf, openRtf, replaceRtfText, isSameRtfSource } from "./rtf";
import { basicRtfFixture } from "./rtf.fixture";

const bytes = (value: string) => new TextEncoder().encode(value);
const open = (body: string) => openRtf(bytes(`{\\rtf1\\ansi ${body}}`));
describe("original bounded RTF codec", () => {
  it("projects basic rich formatting, scoped state, Unicode and paragraphs", async () => {
    const document = await openRtf(basicRtfFixture());
    expect(document.format).toBe("rtf"); expect(document.canEdit).toBe(true);
    expect(document.paragraphs).toHaveLength(2);
    expect(document.paragraphs[0]).toMatchObject({ alignment: "center", spacingBeforePoints: 6, spacingAfterPoints: 12 });
    expect(document.paragraphs[0].runs[0].style).toMatchObject({ fontFamily: "Georgia", fontSizePoints: 16, bold: true, color: "336699" });
    expect(document.text).toContain("Unicode é and 😀.");
    expect(document.paragraphs[1].runs.find(r => r.text === "italic")?.style.italic).toBe(true);
    expect(document.paragraphs[1].runs.at(-1)?.style.italic).toBeUndefined();
  });
  it("retains exact original bytes and owns defensive copies", async () => {
    const source = basicRtfFixture(), original = source.slice();
    const document = await openRtf(source); source.fill(0);
    const exported = await exportRtf(document); expect(exported).toEqual(original); exported.fill(0);
    expect(await exportRtf(document)).toEqual(original);
    await expect(exportRtf({ ...document })).rejects.toThrow("owned");
    expect(() => applyRtfOperations({ ...document }, [])).toThrow("owned");
    const buffer = Buffer.from(original), buffered = await openRtf(buffer); buffer.fill(0);
    expect(await exportRtf(buffered)).toEqual(original);
    (await exportRtf(buffered)).fill(0); expect(await exportRtf(buffered)).toEqual(original);
  });
  it("projects cleared font properties and inserted paragraphs to retained RTF defaults", async () => {
    const document = await openRtf(basicRtfFixture());
    const changed = applyRtfOperations(document, [
      { type: "format-run", runId: "p0:r0", style: { fontFamily: null, fontSizePoints: null } },
      { type: "insert-paragraph", afterParagraphId: "p1", text: "Default paragraph" },
    ]);
    const reopened = await openRtf(await exportRtf(changed));
    for (const index of [0, 2]) {
      expect(changed.paragraphs[index].runs[0].style).toMatchObject({ fontFamily: "Georgia", fontSizePoints: 12 });
      expect(reopened.paragraphs[index].runs[0].style).toMatchObject({ fontFamily: "Georgia", fontSizePoints: 12 });
    }
    expect(applyRtfOperations(reopened, [{ type: "format-run", runId: "p0:r0", style: { fontFamily: null } }]).paragraphs[0].runs[0].style.fontFamily).toBe("Georgia");
  });
  it("projects cleared paragraph properties to exact native RTF defaults", async () => {
    const document = await openRtf(basicRtfFixture());
    const changed = applyRtfOperations(document, [{ type: "format-paragraph", paragraphId: "p0", format: { alignment: null, spacingBeforePoints: null, spacingAfterPoints: null, lineSpacingMultiple: null } }]);
    const reopened = await openRtf(await exportRtf(changed));
    for (const value of [changed, reopened]) expect(value.paragraphs[0]).toMatchObject({ alignment: "left", spacingBeforePoints: 0, spacingAfterPoints: 0, lineSpacingMultiple: 1 });
    expect(changed.revision).toBe(1);
  });
  it("recognizes only actual shared source ownership", async () => {
    const first = await createRtf("First"), foreign = await createRtf("First");
    const derived = replaceRtfText(first, [{ runId: "p0:r0", text: "Changed" }]);
    expect(isSameRtfSource(first, derived)).toBe(true);
    expect(isSameRtfSource(first, foreign)).toBe(false);
    expect(isSameRtfSource({ ...first }, first)).toBe(false);
    expect(isSameRtfSource({ ...first }, { ...first })).toBe(false);
  });
  it("edits and reopens genuine RTF with paragraph/range formatting", async () => {
    const document = await openRtf(basicRtfFixture());
    const edited = applyRtfOperations(document, [
      { type: "replace-paragraph", paragraphId: "p0", text: "Changed 😀 \\ {safe}" },
      { type: "format-range", paragraphId: "p0", start: 0, end: 7, style: { italic: true, color: "123456" } },
      { type: "insert-paragraph", afterParagraphId: "p1", text: "Added" },
    ]);
    const result = await exportRtf(edited), reopened = await openRtf(result);
    expect(new TextDecoder().decode(result)).toMatch(/^\{\\rtf1/);
    expect(reopened.canEdit).toBe(true); expect(reopened.text).toBe(edited.text);
    expect(reopened.paragraphs[0].runs[0].style).toMatchObject({ italic: true, color: "123456", fontFamily: "Georgia" });
    expect(new TextDecoder().decode(result)).toContain("Markie original RTF fixture;");
    expect(await exportRtf(document)).toEqual(basicRtfFixture());
  });
  it("supports run text edits and no-op identity", async () => {
    const document = await createRtf("Hello");
    expect(replaceRtfText(document, [{ runId: "p0:r0", text: "Hello" }])).toBe(document);
    const changed = replaceRtfText(document, [{ runId: "p0:r0", text: "Bye\nnext\tcell" }]);
    expect((await openRtf(await exportRtf(changed))).text).toBe(changed.text);
    expect((await createRtf("First\nSecond")).paragraphs.map(p => p.text)).toEqual(["First", "Second"]);
  });
  it.each(["", "a\n", "a\n\n", "\n", "\n\n", "a\nb\n"])("retains real empty/trailing paragraphs: %j", async value => {
    const document = await createRtf(value);
    expect(document.text).toBe(value);
    const changed = applyRtfOperations(document, [{ type: "format-run", runId: "p0:r0", style: { bold: true } }]);
    const reopened = await openRtf(await exportRtf(changed));
    expect(reopened.text).toBe(value);
    expect(reopened.paragraphs[0].runs[0].style.bold).toBe(true);
    expect((await open(String.raw`a\par`)).paragraphs).toHaveLength(1);
  });
  it("preserves an inserted empty last paragraph without fabricating source paragraphs", async () => {
    const document = await createRtf("a");
    const changed = applyRtfOperations(document, [{ type: "insert-paragraph", afterParagraphId: "p0", text: "" }]);
    expect((await openRtf(await exportRtf(changed))).text).toBe("a\n");
    expect((await openRtf(await exportRtf(document))).text).toBe("a");
  });
  it("round-trips Unicode font names and retains known font fallback metadata", async () => {
    const document = await open(String.raw`{\fonttbl{\f0\froman\fcharset204\cpg1251 Georgia;}}\f0 text`);
    const changed = applyRtfOperations(document, [{ type: "format-run", runId: "p0:r0", style: { fontFamily: "游明朝" } }]);
    const result = await exportRtf(changed), reopened = await openRtf(result);
    expect(reopened.canEdit).toBe(true);
    expect(reopened.paragraphs[0].runs[0].style.fontFamily).toBe("游明朝");
    expect(new TextDecoder().decode(result)).toContain(String.raw`\froman\fcharset204\cpg1251 Georgia;`);
  });
  it("counts escaped bytes, controls and binary as Unicode fallback characters", async () => {
    expect((await open(String.raw`\uc2\u233\'65?X`)).text).toBe("éX");
    expect((await open(String.raw`\uc1\u233\b X`)).paragraphs[0].runs[0]).toMatchObject({ text: "éX", style: { fontSizePoints: 12 } });
    expect((await open(String.raw`\uc1\u233\bin3 {x}X`)).text).toBe("éX");
    expect((await open(String.raw`\uc1\u233{X}Y`)).text).toBe("éXY");
    expect((await open(String.raw`{\uc0\u233}\u233?`)).text).toBe("éé");
    expect((await open("First\\\nSecond")).paragraphs.map(p => p.text)).toEqual(["First", "Second"]);
    expect((await open(String.raw`\uc0{\fonttbl{\f0\fnil \u28216\u26126\u26397;}}\f0 Text`)).paragraphs[0].runs[0].style.fontFamily).toBe("游明朝");
  });
  it("decodes raw/escaped bytes with document and font codepage authority", async () => {
    expect((await open(String.raw`\ansicpg1251\'cf\'f0`)).text).toBe("Пр");
    expect((await open(String.raw`{\fonttbl{\f0\fnil\fcharset128 Japanese;}}\f0\'82\'a0`)).text).toBe("あ");
    expect((await open(String.raw`{\fonttbl{\f0\fnil\fcharset128\cpg1251 Russian;}}\f0\'cf\'f0`)).text).toBe("Пр");
    const raw = new Uint8Array([...bytes("{\\rtf1\\ansi "), 0xe9, ...bytes("}")]);
    expect((await openRtf(raw)).text).toBe("é");
  });
  it("resets character/paragraph properties without losing outer scope", async () => {
    const document = await open(String.raw`\qc\b A{\plain B}C\par\pard D`);
    expect(document.paragraphs[0].alignment).toBe("center");
    expect(document.paragraphs[0].runs.map(r => [r.text, r.style.bold])).toEqual([["A", true], ["B", undefined], ["C", true]]);
    expect(document.paragraphs[1].alignment).toBe("left");
  });
  it.each([String.raw`{\*\unknown hidden}`, String.raw`{\object secret}`, String.raw`{\field secret}`, String.raw`\intbl`, String.raw`\revised text`, String.raw`{\info{\author Person}}`, String.raw`\unknown text`, String.raw`\ansicpg9999 text`, String.raw`\sl300 text`, String.raw`{\pict image}`, String.raw`{\*\generator \u233?;}`, String.raw`\qc1 text`, String.raw`{\fonttbl{\f0\fnil Font;}{\f1\froman Font;}}text`])("keeps unsupported semantics read-only and exact: %s", async body => {
    const source = bytes(`{\\rtf1\\ansi ${body}}`), document = await openRtf(source);
    expect(document.canEdit).toBe(false); expect(document.diagnostics[0].code).toBe("rtf-unsupported");
    expect(await exportRtf(document)).toEqual(source);
    expect(() => applyRtfOperations(document, [{ type: "replace-paragraph", paragraphId: "p0", text: "loss" }])).toThrow("read-only");
  });
  it.each(["", "hello", "{\\rtf2 text}", "{\\rtf1 text", "{\\rtf1}junk", "{\\rtf1\\'xz}", "{\\rtf1\\bin5 xx}", "{\\rtf1\\u65535?}", "{\\rtf1\\uc-1}", `{\\rtf1${"{".repeat(130)}${"}".repeat(130)}}`])("rejects malformed or over-budget input: %s", async source => {
    await expect(openRtf(bytes(source))).rejects.toThrow();
  });
  it("rejects lossy edits instead of rounding or flattening styles", async () => {
    const document = await createRtf("Text");
    for (const style of [{ fontSizePoints: 10.25 }, { underline: "double" }, { fontFamily: "Bad;Font" }]) expect(() => applyRtfOperations(document, [{ type: "format-run", runId: "p0:r0", style }])).toThrow();
    expect((await openRtf(await exportRtf(applyRtfOperations(document, [{ type: "format-run", runId: "p0:r0", style: { color: "auto" } }])))).canEdit).toBe(true);
  });
  it("bounds byte and token counts before constructing a document", async () => {
    await expect(openRtf(new Uint8Array(16 * 1024 * 1024 + 1))).rejects.toThrow("byte budget");
    await expect(open("x".repeat(250_000))).rejects.toThrow("token budget");
  });
  it("rejects edits exceeding the writer/reopen token budget before accepting a snapshot", async () => {
    const document = await createRtf("a"), original = await exportRtf(document);
    expect(() => replaceRtfText(document, [{ runId: "p0:r0", text: "a".repeat(300_000) }])).toThrow("token budget");
    expect(() => applyRtfOperations(document, [{ type: "replace-paragraph", paragraphId: "p0", text: "a".repeat(300_000) }])).toThrow("token budget");
    expect(await exportRtf(document)).toEqual(original);
    const supported = replaceRtfText(document, [{ runId: "p0:r0", text: "a".repeat(20_000) }]);
    expect((await openRtf(await exportRtf(supported))).text).toBe(supported.text);
  });
});
