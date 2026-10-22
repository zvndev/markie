import { describe, expect, it, vi } from "vitest";
import { docxStyleResolver, type DocxPartsState } from "./docx-parts";
import { docxThemeResolver } from "./docx-theme";
import { parseXml } from "./xml";
import * as xml from "./xml";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const props = (content: string) => parseXml(`<w:rPr xmlns:w="${W}">${content}</w:rPr>`);
function state(theme = `<a:accent1><a:srgbClr val="336699"/></a:accent1>`, settings = "", relationships = ""): DocxPartsState {
  const parts: Record<string, string> = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/parts/colors.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/parts/options.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="${R}/theme" Target="../parts/colors.xml"/><Relationship Id="settings" Type="${R}/settings" Target="../parts/options.xml"/>${relationships}</Relationships>`,
    "parts/colors.xml": `<a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme name="Test">${theme}</a:clrScheme><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    "parts/options.xml": `<w:settings xmlns:w="${W}">${settings}</w:settings>`,
  };
  return { entries: Object.entries(parts).map(([name, source]) => ({ name, data: new TextEncoder().encode(source) })), mainPart: "word/document.xml", partOverrides: new Map() };
}
const resolved = (s: DocxPartsState, content: string, text = "Latin") => docxStyleResolver(s).run(undefined, undefined, {}, props(content), text);
function replacePart(s: DocxPartsState, name: string, transform: (source: string) => string): DocxPartsState {
  return { ...s, entries: s.entries.map((part) => part.name === name ? { ...part, data: new TextEncoder().encode(transform(new TextDecoder().decode(part.data))) } : part) };
}
describe("bounded display-only theme resolution", () => {
  it("resolves Latin theme font pairs and theme colors ahead of cached literals", () => {
    expect(resolved(state(), '<w:rFonts w:ascii="Cached" w:asciiTheme="majorAscii"/><w:color w:val="ffffff" w:themeColor="accent1"/>')).toMatchObject({ fontFamily: "Georgia", color: "336699" });
  });
  it("maps aliases before a single DrawingML lookup and uses stored system fallback", () => {
    const s = state('<a:dk1><a:srgbClr val="111111"/></a:dk1><a:accent1><a:sysClr val="windowText" lastClr="223344"/></a:accent1>', '<w:clrSchemeMapping w:t1="accent1" w:accent1="dark1"/>');
    expect(resolved(s, '<w:color w:themeColor="dark1"/>').color).toBe("223344");
    expect(resolved(s, '<w:color w:themeColor="accent1"/>').color).toBe("111111");
  });
  it("uses HSL luminance transforms, exact hex bytes and tint precedence", () => {
    expect(resolved(state('<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>'), '<w:color w:themeColor="accent1" w:themeTint="99"/>').color).toBe("95b3d7");
    for (const [attrs, expected] of [['themeShade="00"', "000000"], ['themeTint="00"', "ffffff"], ['themeTint="FF"', "336699"], ['themeShade="FF"', "336699"], ['themeTint="00" w:themeShade="00"', "ffffff"]]) expect(resolved(state(), `<w:color w:themeColor="accent1" w:${attrs}/>`).color).toBe(expected);
    expect(resolved(state(), '<w:color w:themeColor="accent1" w:themeTint="9"/>').color).toBeUndefined();
    expect(resolved(state(), '<w:color w:val="336699" w:themeTint="00"/>').color).toBe("336699");
  });
  it("keeps language/script-sensitive themes unresolved but allows literals", () => {
    expect(resolved(state("", '<w:themeFontLang w:val="en-US"/>'), '<w:rFonts w:asciiTheme="majorAscii"/>').fontFamily).toBeUndefined();
    for (const content of ['<w:cs/>', '<w:rtl/>', '<w:rFonts w:hint="eastAsia" w:asciiTheme="majorAscii"/>']) expect(resolved(state(), `<w:rFonts w:asciiTheme="majorAscii"/>${content}`).fontFamily).toBeUndefined();
    expect(resolved(state(), '<w:rFonts w:asciiTheme="majorAscii"/>', "日本語").fontFamily).toBeUndefined();
    expect(resolved(state("", '<w:themeFontLang w:val="en-US"/>'), '<w:rFonts w:ascii="Courier New"/>').fontFamily).toBe("Courier New");
  });
  it("resolves per-layer literal/theme pairs without reviving masked lower values", () => {
    const s = state();
    const styles = `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Baseline" w:hAnsi="Baseline"/><w:color w:val="111111"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Theme"><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:color w:themeColor="accent1"/></w:rPr></w:style><w:style w:type="character" w:styleId="Literal"><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="cc0000"/></w:rPr></w:style></w:styles>`;
    const withStyles = replacePart(s, "word/_rels/document.xml.rels", (source) => source.replace("</Relationships>", `<Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`));
    withStyles.entries = [...withStyles.entries, { name: "word/styles.xml", data: new TextEncoder().encode(styles) }];
    const resolver = docxStyleResolver(withStyles);
    expect(resolver.run("Theme", undefined, {}, undefined, "Latin")).toMatchObject({ fontFamily: "Georgia", color: "336699" });
    expect(resolver.run("Theme", "Literal", {}, undefined, "Latin")).toMatchObject({ fontFamily: "Courier New", color: "cc0000" });
    expect(resolver.run("Theme", "Literal", {}, props('<w:rFonts w:asciiTheme="unknown"/><w:color w:themeColor="unknown"/>'), "Latin")).toEqual({});
    expect(resolver.run("Theme", undefined, {}, props('<w:rFonts w:ascii="Explicit"/><w:color w:val="abcdef"/>'), "Latin")).toMatchObject({ fontFamily: "Explicit", color: "abcdef" });
  });
  it("does not collapse distinct ASCII/HAnsi theme families for mixed Latin text", () => {
    const fonts = '<w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="minorHAnsi"/>';
    expect(resolved(state(), fonts, "ASCII").fontFamily).toBe("Georgia");
    expect(resolved(state(), fonts, "é").fontFamily).toBe("Arial");
    expect(resolved(state(), fonts, "Café").fontFamily).toBeUndefined();
  });
  it.each([
    ['<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="MS Mincho"/>', "日本語"],
    ['<w:rFonts w:ascii="Georgia" w:cs="Arabic Typesetting"/>', "مرحبا"],
    ['<w:rFonts w:ascii="Georgia"/><w:cs/>', "ABC"],
    ['<w:rFonts w:ascii="Georgia"/><w:rtl/>', "ABC"],
    ['<w:rFonts w:ascii="Georgia" w:hint="eastAsia"/>', "ABC"],
    ['<w:rFonts w:ascii="Georgia" w:hint="cs"/>', "ABC"],
    ['<w:rFonts w:ascii="Georgia" w:hAnsi="Arial"/>', "Café"],
  ])("does not claim one literal Latin family for script-sensitive text: %s", (fonts, text) => {
    const result = resolved(state(), `${fonts}<w:color w:themeColor="accent1"/>`, text);
    expect(result.fontFamily).toBeUndefined();
    expect(result.color).toBe("336699");
  });
  it("guards inherited literal fonts while preserving explicit supported Latin literals under themeFontLang", () => {
    const resolver = docxThemeResolver(state("", '<w:themeFontLang w:val="en-US"/>'));
    const inherited = props('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:color w:val="cc0000"/>');
    expect(resolver.run([inherited, props("<w:cs/>")], "ABC")).toEqual({ fontFamily: undefined, color: "cc0000" });
    expect(resolver.run([inherited, props('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')], "Café")).toEqual({ fontFamily: "Courier New", color: "cc0000" });
    expect(resolver.run([inherited, props('<w:cs/>'), props('<w:cs w:val="0"/>')], "ABC").fontFamily).toBe("Georgia");
  });
  it.each([
    ['<w:rFonts w:asciiTheme="majorAscii"/>', "éàü"],
    ['<w:rFonts w:hAnsiTheme="majorHAnsi"/>', "ASCII"],
    ['<w:rFonts w:asciiTheme="majorAscii"/>', "Café"],
    ['<w:rFonts w:hAnsiTheme="majorHAnsi"/>', "Café"],
    ['<w:rFonts w:ascii="Georgia"/>', "éàü"],
    ['<w:rFonts w:hAnsi="Georgia"/>', "ASCII"],
  ])("does not borrow a missing font slot: %s with %s", (fonts, text) => {
    expect(resolved(state(), fonts, text).fontFamily).toBeUndefined();
  });
  it("validates theme families and palette once rather than scanning large supplemental lists per run", () => {
    const large = replacePart(state(), "parts/colors.xml", (source) => source.replace('<a:latin typeface="Georgia"/>', `${'<a:font script="Latn" typeface="Supplemental"/>'.repeat(5000)}<a:latin typeface="Georgia"/>`));
    const spy = vi.spyOn(xml, "xmlAttribute");
    try {
      const resolver = docxThemeResolver(large);
      expect(spy.mock.calls.filter(([node]) => node.namespace === A).length).toBeGreaterThan(0);
      spy.mockClear();
      const layer = props('<w:rFonts w:asciiTheme="majorAscii"/><w:color w:themeColor="accent1" w:themeTint="ff"/>');
      for (let i = 0; i < 100; i++) expect(resolver.run([layer], "ASCII")).toEqual({ fontFamily: "Georgia", color: "336699" });
      // Structural work bound, not a timing threshold: no DrawingML property
      // reads at all after construction, regardless of run/supplemental count.
      expect(spy.mock.calls.filter(([node]) => node.namespace === A)).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it.each([
    ["external relationship", "word/_rels/document.xml.rels", (s: string) => s.replace('Id="theme"', 'Id="theme" TargetMode="External"')],
    ["duplicate ID", "word/_rels/document.xml.rels", (s: string) => s.replace('Id="settings"', 'Id="theme"')],
    ["encoded target", "word/_rels/document.xml.rels", (s: string) => s.replace("../parts/colors.xml", "../parts/%63olors.xml")],
    ["escaping target", "word/_rels/document.xml.rels", (s: string) => s.replace("../parts/colors.xml", "../../parts/colors.xml")],
    ["wrong type", "[Content_Types].xml", (s: string) => s.replace("application/vnd.openxmlformats-officedocument.theme+xml", "application/xml")],
    ["duplicate type", "[Content_Types].xml", (s: string) => s.replace("</Types>", '<Override PartName="/parts/colors.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>')],
    ["wrong root", "parts/colors.xml", (s: string) => s.replaceAll("a:theme ", "a:other ").replaceAll("</a:theme>", "</a:other>")],
    ["wrong namespace", "parts/colors.xml", (s: string) => s.replace(A, "urn:untrusted")],
  ])("leaves %s unresolved", (_label, name, transform) => {
    expect(resolved(replacePart(state(), name, transform), '<w:rFonts w:asciiTheme="majorAscii"/><w:color w:val="cached" w:themeColor="accent1"/>')).toEqual({});
  });
  it("supports Strict theme and relationship namespaces without fixed filenames", () => {
    let s = replacePart(state(), "parts/colors.xml", (source) => source.replace(A, "http://purl.oclc.org/ooxml/drawingml/main"));
    s = replacePart(s, "word/_rels/document.xml.rels", (source) => source.replaceAll(R, "http://purl.oclc.org/ooxml/officeDocument/relationships"));
    expect(resolved(s, '<w:rFonts w:asciiTheme="minorAscii"/><w:color w:themeColor="accent1"/>')).toMatchObject({ fontFamily: "Arial", color: "336699" });
  });
  it("does not trust ambiguous/external dependencies, wrong roots or transformed colors", () => {
    const duplicate = state(undefined, "", `<Relationship Id="other" Type="${R}/theme" Target="../parts/colors.xml"/>`);
    expect(resolved(duplicate, '<w:rFonts w:asciiTheme="majorAscii"/><w:color w:themeColor="accent1"/>')).not.toHaveProperty("fontFamily");
    for (const color of ['<a:accent1><a:srgbClr val="336699"><a:tint val="50000"/></a:srgbClr></a:accent1>', '<a:accent1><a:srgbClr val="wrong"/></a:accent1>', '<a:accent1><a:sysClr val="windowText"/></a:accent1>', '<a:accent1><a:srgbClr val="336699"/><a:srgbClr val="000000"/></a:accent1>']) expect(resolved(state(color), '<w:color w:themeColor="accent1"/>').color).toBeUndefined();
  });
});
