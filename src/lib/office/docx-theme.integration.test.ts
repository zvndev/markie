import { describe, expect, it, vi } from "vitest";
import { applyDocxOperations, exportDocx, openDocx, replaceDocxText } from "./docx";
import { themedDocxFixture, THEME_PART, SETTINGS_PART, RETAINED_PART } from "./docx-theme.fixture";
import { readZip, writeZip, type ZipEntry } from "./zip";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAIN = "word/document.xml", STYLES = "word/styles.xml", RELS = "word/_rels/document.xml.rels";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const THEME_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml";

function rewrite(parts: ZipEntry[], name: string, change: (xml: string) => string) {
  const part = parts.find((entry) => entry.name === name)!;
  part.data = encoder.encode(change(decoder.decode(part.data)));
}
async function packageVariant(change: (parts: ZipEntry[]) => void) {
  const { bytes } = await themedDocxFixture();
  const parts = await readZip(bytes);
  change(parts);
  const candidate = writeZip(parts);
  return { document: await openDocx(candidate), bytes: candidate };
}
async function variant(change: (parts: ZipEntry[]) => void) {
  return (await packageVariant(change)).document;
}
async function headingPackage(properties: string, extra?: (parts: ZipEntry[]) => void) {
  return packageVariant((parts) => {
    rewrite(parts, MAIN, (xml) => xml.replace('<w:r><w:t>Themed heading', `<w:r><w:rPr>${properties}</w:rPr><w:t>Themed heading`));
    extra?.(parts);
  });
}
async function headingWith(properties: string, extra?: (parts: ZipEntry[]) => void) {
  return (await headingPackage(properties, extra)).document;
}

describe("original theme package display and preservation", () => {
  it("resolves related arbitrary-path theme defaults and named styles without changing raw direct properties or bytes", async () => {
    const { document, bytes } = await themedDocxFixture();
    expect(document.canEdit).toBe(true);
    expect(document.text).toBe("Themed heading\nTheme body Direct");
    expect(document.paragraphs[0].runs[0]).toMatchObject({ style: {}, resolvedStyle: { fontFamily: "Georgia", fontSizePoints: 16, bold: true, color: "336699" } });
    expect(document.paragraphs[1].runs[0]).toMatchObject({ style: {}, resolvedStyle: { fontFamily: "Arial", fontSizePoints: 11, color: "222222" } });
    expect(document.paragraphs[1].runs[1]).toMatchObject({ style: { fontFamily: "Courier New", fontSizePoints: 9, color: "cc0000" }, resolvedStyle: { fontFamily: "Courier New", fontSizePoints: 9, color: "cc0000" } });
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("preserves theme, settings, styles and unknown parts byte-for-byte after text and named-style edits", async () => {
    const { document, bytes, theme, settings, styles } = await themedDocxFixture();
    const changed = applyDocxOperations(replaceDocxText(document, [{ runId: document.paragraphs[0].runs[0].id, text: "An edited heading" }]), [
      { type: "format-paragraph", paragraphId: document.paragraphs[1].id, format: { styleId: "Heading1" } },
    ]);
    const exported = await exportDocx(changed), reopened = await openDocx(exported);
    expect(reopened.paragraphs[0].text).toBe("An edited heading");
    expect(reopened.paragraphs[1].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "336699", fontSizePoints: 16 });
    expect(reopened.paragraphs[1].runs[1].resolvedStyle).toMatchObject({ fontFamily: "Courier New", color: "cc0000", fontSizePoints: 9 });
    const originals = await readZip(bytes), next = await readZip(exported);
    for (const part of originals.filter((entry) => entry.name !== MAIN)) expect(next.find((entry) => entry.name === part.name)?.data).toEqual(part.data);
    expect(decoder.decode(next.find((entry) => entry.name === THEME_PART)!.data)).toBe(theme);
    expect(decoder.decode(next.find((entry) => entry.name === SETTINGS_PART)!.data)).toBe(settings);
    expect(decoder.decode(next.find((entry) => entry.name === STYLES)!.data)).toBe(styles);
    expect(next.some((entry) => entry.name === RETAINED_PART)).toBe(true);
    const main = decoder.decode(next.find((entry) => entry.name === MAIN)!.data);
    expect(main).not.toContain('w:ascii="Georgia"');
    expect(main).not.toContain('w:val="336699"');
    expect(reopened.paragraphs[0].runs[0].style).toEqual({});
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it("only stores explicit user font/color overrides while leaving all imported dependencies untouched", async () => {
    const { document, bytes } = await themedDocxFixture();
    const edited = applyDocxOperations(document, [{ type: "format-run", runId: document.paragraphs[0].runs[0].id, style: { fontFamily: "Verdana", color: "123456" } }]);
    const exported = await exportDocx(edited), reopened = await openDocx(exported);
    expect(reopened.paragraphs[0].runs[0]).toMatchObject({ style: { fontFamily: "Verdana", color: "123456" }, resolvedStyle: { fontFamily: "Verdana", color: "123456", bold: true, fontSizePoints: 16 } });
    const next = await readZip(exported);
    for (const part of (await readZip(bytes)).filter((entry) => entry.name !== MAIN)) expect(next.find((entry) => entry.name === part.name)?.data).toEqual(part.data);
  });

  it("retains raw direct theme references during unrelated edits and replaces them only for an explicit literal choice", async () => {
    const document = await headingWith('<w:rFonts w:ascii="Cached" w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="112233" w:themeColor="accent3"/>');
    const runId = document.paragraphs[0].runs[0].id;
    expect(document.paragraphs[0].runs[0].style).toMatchObject({ fontFamily: "Cached", color: "112233" });
    expect(document.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Arial", color: "008000" });
    const unrelated = applyDocxOperations(document, [{ type: "format-run", runId, style: { italic: true } }]);
    const unrelatedBytes = await exportDocx(unrelated);
    const source = decoder.decode((await readZip(unrelatedBytes)).find((part) => part.name === MAIN)!.data);
    expect(source).toContain('w:asciiTheme="minorAscii"');
    expect(source).toContain('w:themeColor="accent3"');
    expect((await openDocx(unrelatedBytes)).paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Arial", color: "008000", italic: true });
    const chosen = applyDocxOperations(unrelated, [{ type: "format-run", runId, style: { fontFamily: "Verdana", color: "123456" } }]);
    const chosenBytes = await exportDocx(chosen);
    const chosenSource = decoder.decode((await readZip(chosenBytes)).find((part) => part.name === MAIN)!.data);
    expect(chosenSource).not.toContain("asciiTheme");
    expect(chosenSource).not.toContain('w:themeColor="accent3"');
    expect((await openDocx(chosenBytes)).paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Verdana", color: "123456", italic: true });
  });

  it("supports Strict Word, DrawingML and relationship namespaces at the same arbitrary paths", async () => {
    const doc = await variant((parts) => {
      for (const part of parts.filter((entry) => /\.(?:xml|rels)$/.test(entry.name))) rewrite(parts, part.name, (xml) => xml.replaceAll(W, "http://purl.oclc.org/ooxml/wordprocessingml/main").replaceAll(R, "http://purl.oclc.org/ooxml/officeDocument/relationships").replaceAll("http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"));
    });
    expect(doc.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "336699" });
    expect(doc.paragraphs[1].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Arial", color: "222222" });
  });

  it("applies character-style theme selection after paragraph styles", async () => {
    const doc = await headingWith('<w:rStyle w:val="ThemeAccent"/>');
    expect(doc.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "008000", fontSizePoints: 16, bold: true });
  });

  it.each([
    ['<w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/><w:color w:val="123456"/>', "Verdana", "123456"],
    ['<w:rFonts w:ascii="Verdana" w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="123456" w:themeColor="accent3"/>', "Arial", "008000"],
    ['<w:rFonts w:asciiTheme="unknown" w:hAnsiTheme="unknown"/><w:color w:val="123456" w:themeColor="unknown"/>', undefined, undefined],
  ])("uses layer-pair replacement rather than stale lower font/color values: %s", async (props, fontFamily, color) => {
    const doc = await headingWith(props);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBe(fontFamily);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBe(color);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.bold).toBe(true);
  });

  it("resolves ASCII versus high-ANSI font slots independently instead of replacing the whole font pair", async () => {
    const doc = await headingWith('<w:rFonts w:hAnsi="Verdana"/>', (parts) => rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", "Résumé</w:t>")));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    const ascii = await headingWith('<w:rFonts w:hAnsi="Verdana"/>');
    expect(ascii.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBe("Georgia");
  });

  it.each(["text1", "dark1", "background1", "light1", "text2", "dark2", "background2", "light2", "accent1", "hyperlink", "followedHyperlink"])("applies settings mapping once for %s", async (slot) => {
    const attribute = ({ text1: "t1", dark1: "t1", background1: "bg1", light1: "bg1", text2: "t2", dark2: "t2", background2: "bg2", light2: "bg2" } as Record<string, string>)[slot] ?? slot;
    const doc = await headingWith(`<w:color w:themeColor="${slot}"/>`, (parts) => rewrite(parts, SETTINGS_PART, (xml) => xml.replace('/>', `><w:clrSchemeMapping w:${attribute}="accent3" w:accent3="accent4"/></w:settings>`)));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBe("008000");
  });

  it.each([
    ["text1", "222222"], ["dark1", "222222"], ["background1", "FFFFFF"], ["light1", "FFFFFF"],
    ["text2", "444444"], ["dark2", "444444"], ["background2", "EEEEEE"], ["light2", "EEEEEE"],
    ["hyperlink", "0000FF"], ["followedHyperlink", "800080"],
  ])("uses specification default mapping %s → %s when settings omit it", async (slot, color) => {
    expect((await headingWith(`<w:color w:themeColor="${slot}"/>`)).paragraphs[0].runs[0].resolvedStyle?.color?.toUpperCase()).toBe(color);
  });

  it.each([
    ['w:themeTint="00"', "FFFFFF"], ['w:themeTint="FF"', "808080"],
    ['w:themeShade="00"', "000000"], ['w:themeShade="FF"', "808080"],
    ['w:themeShade="80"', "404040"], ['w:themeTint="80"', "BFBFBF"],
    ['w:themeShade="00" w:themeTint="FF"', "808080"],
  ])("uses deterministic HSL luminance endpoints/achromatic math and tint precedence: %s", async (transform, expected) => {
    const doc = await headingWith(`<w:color w:themeColor="accent2" ${transform}/>`);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color?.toUpperCase()).toBe(expected);
  });

  it.each(['w:themeTint="F"', 'w:themeShade="100"', 'w:themeTint="GG"'])("does not guess malformed two-hex transforms: %s", async (transform) => {
    const doc = await headingWith(`<w:color w:val="123456" w:themeColor="accent2" ${transform}/>`);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBeUndefined();
  });

  it("does not apply theme transforms to literal-only colors", async () => {
    const doc = await headingWith('<w:color w:val="123456" w:themeTint="00"/>');
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBe("123456");
  });

  it("lets inherited theme pairs replace lower literals and higher literal pairs replace character themes", async () => {
    const doc = await headingWith('<w:rStyle w:val="ThemeAccent"/><w:rFonts w:ascii="Verdana" w:hAnsi="Verdana"/><w:color w:val="123456"/>', (parts) => rewrite(parts, STYLES, (xml) => xml.replace('<w:name w:val="Normal"/>', '<w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:color w:val="ABCDEF"/></w:rPr>')));
    expect(doc.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Verdana", color: "123456" });
    const inherited = await variant((parts) => rewrite(parts, STYLES, (xml) => xml.replace('<w:name w:val="Normal"/>', '<w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:color w:val="ABCDEF"/></w:rPr>')));
    expect(inherited.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "336699" });
  });

  it("uses the high-ANSI slot for an entirely high-ANSI run without discarding the ASCII slot", async () => {
    const doc = await headingWith('<w:rFonts w:hAnsi="Verdana"/>', (parts) => rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", "éàü</w:t>")));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBe("Verdana");
  });

  it("masks only the selected font slot when a higher unknown theme replaces a literal", async () => {
    const doc = await headingWith('<w:rFonts w:ascii="Verdana" w:asciiTheme="unknown"/>');
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    const highAnsi = await headingWith('<w:rFonts w:ascii="Verdana" w:asciiTheme="unknown"/>', (parts) => rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", "éàü</w:t>")));
    expect(highAnsi.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBe("Georgia");
  });

  it("keeps display color unresolved for an invalid selected settings mapping rather than using its literal cache", async () => {
    const doc = await variant((parts) => rewrite(parts, SETTINGS_PART, (xml) => xml.replace('/>', '><w:clrSchemeMapping w:accent1="invalid"/></w:settings>')));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBeUndefined();
    expect(doc.paragraphs[1].runs[1].resolvedStyle?.color).toBe("cc0000");
  });

  it("does not substitute a guessed OS color when a system slot lacks a valid stored lastClr", async () => {
    const doc = await variant((parts) => rewrite(parts, THEME_PART, (xml) => xml.replace('lastClr="222222"', 'lastClr="invalid"')));
    expect(doc.paragraphs[1].runs[0].resolvedStyle?.color).toBeUndefined();
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBe("336699");
  });

  it("uses defaults for absent settings, without reading an unrelated settings-shaped part", async () => {
    const doc = await variant((parts) => {
      rewrite(parts, RELS, (xml) => xml.replace(/<Relationship Id="rSettings"[^>]+\/>/, ""));
      rewrite(parts, SETTINGS_PART, (xml) => xml.replace('/>', '><w:themeFontLang w:val="ja-JP"/><w:clrSchemeMapping w:accent1="accent3"/></w:settings>'));
    });
    expect(doc.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "336699" });
  });

  it.each([
    ["duplicate settings", (parts: ZipEntry[]) => rewrite(parts, RELS, (xml) => xml.replace('</Relationships>', `<Relationship Id="rSettings2" Type="${R}/settings" Target="preferences/theme-settings.xml"/></Relationships>`))],
    ["wrong settings root", (parts: ZipEntry[]) => rewrite(parts, SETTINGS_PART, (xml) => xml.replace("w:settings ", "w:notSettings "))],
    ["wrong settings content type", (parts: ZipEntry[]) => rewrite(parts, "[Content_Types].xml", (xml) => xml.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml", "application/xml"))],
    ["external settings", (parts: ZipEntry[]) => rewrite(parts, RELS, (xml) => xml.replace('Target="preferences/theme-settings.xml"', 'Target="https://example.test/settings.xml" TargetMode="External"'))],
  ])("does not guess theme fonts or mapped colors for %s", async (_label, change) => {
    const doc = await variant(change);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBeUndefined();
    expect(doc.paragraphs[1].runs[1].resolvedStyle).toMatchObject({ fontFamily: "Courier New", color: "cc0000" });
  });

  it.each(["ja-JP", "en-US", "ar-SA"])("keeps supplied themeFontLang %s script selection unresolved, without losing explicit literals/colors", async (language) => {
    const doc = await variant((parts) => rewrite(parts, SETTINGS_PART, (xml) => xml.replace('/>', `><w:themeFontLang w:val="${language}"/></w:settings>`)));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBe("336699");
    expect(doc.paragraphs[1].runs[1].resolvedStyle?.fontFamily).toBe("Courier New");
  });

  it.each(["日本語", "مرحبا", "English 日本語"])("does not label unsupported/mixed scripts as the Latin theme font: %s", async (text) => {
    const doc = await variant((parts) => rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", `${text}</w:t>`)));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
  });

  it.each([
    { label: "Japanese with an East Asian face", text: "日本語", properties: '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="MS Mincho"/>', inherited: "" },
    { label: "Arabic with a complex-script face", text: "مرحبا", properties: '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Traditional Arabic"/>', inherited: "" },
    { label: "inherited complex-script forcing on ASCII", text: "Themed heading", properties: '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>', inherited: '<w:cs/>' },
    { label: "inherited right-to-left forcing on ASCII", text: "Themed heading", properties: '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>', inherited: '<w:rtl/>' },
    { label: "East Asian hint with an ASCII literal", text: "Themed heading", properties: '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:hint="eastAsia"/>', inherited: "" },
  ])("does not claim a literal Latin face for $label and preserves raw authority", async ({ text, properties, inherited }) => {
    const { document, bytes } = await headingPackage(properties, (parts) => {
      rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", `${text}</w:t>`));
      if (inherited) rewrite(parts, STYLES, (xml) => xml.replace('<w:b/>', `${inherited}<w:b/>`));
    });
    const run = document.paragraphs[0].runs[0];
    expect(run.style.fontFamily).toBe("Georgia");
    expect(run.resolvedStyle?.fontFamily).toBeUndefined();
    expect(run.resolvedStyle?.color).toBe("336699");
    expect(await exportDocx(document)).toEqual(bytes);
    const reopened = await openDocx(bytes);
    expect(await exportDocx(reopened)).toEqual(bytes);
    expect(reopened.paragraphs[0].runs[0].style.fontFamily).toBe("Georgia");
    expect(reopened.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    const main = decoder.decode((await readZip(bytes)).find((part) => part.name === MAIN)!.data);
    expect(main).toContain(properties);
  });

  it("keeps an explicit Latin literal supported even when themeFontLang is unresolved", async () => {
    const { document, bytes } = await headingPackage('<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/>', (parts) => rewrite(parts, SETTINGS_PART, (xml) => xml.replace('/>', '><w:themeFontLang w:val="ja-JP"/></w:settings>')));
    expect(document.paragraphs[0].runs[0].style.fontFamily).toBe("Georgia");
    expect(document.paragraphs[0].runs[0].resolvedStyle).toMatchObject({ fontFamily: "Georgia", color: "336699" });
    expect(await exportDocx(document)).toEqual(bytes);
    expect(await exportDocx(await openDocx(bytes))).toEqual(bytes);
  });

  it.each([
    { label: "missing high-ANSI slot for high-ANSI text", attribute: "hAnsiTheme", text: "éàü" },
    { label: "missing ASCII slot for ASCII text", attribute: "asciiTheme", text: "Themed heading" },
    { label: "missing high-ANSI slot for mixed Latin text", attribute: "hAnsiTheme", text: "Café" },
    { label: "missing ASCII slot for mixed Latin text", attribute: "asciiTheme", text: "Café" },
  ])("does not borrow a different font slot for $label", async ({ attribute, text }) => {
    const { document, bytes } = await packageVariant((parts) => {
      rewrite(parts, STYLES, (xml) => xml.replace(new RegExp(` w:${attribute}="[^"]*"`, "g"), ""));
      rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", `${text}</w:t>`));
    });
    expect(document.paragraphs[0].runs[0].style).toEqual({});
    expect(document.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    expect(document.paragraphs[0].runs[0].resolvedStyle?.color).toBe("336699");
    expect(await exportDocx(document)).toEqual(bytes);
    const reopened = await openDocx(bytes);
    expect(reopened.paragraphs[0].runs[0].style).toEqual({});
    expect(reopened.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
  });

  it.each(["asciiTheme", "hAnsiTheme"])("keeps a mixed Latin run unresolved when %s is unknown", async (attribute) => {
    const { document, bytes } = await headingPackage(`<w:rFonts w:ascii="Cached" w:hAnsi="Cached" w:${attribute}="unknown"/>`, (parts) => rewrite(parts, MAIN, (xml) => xml.replace("Themed heading</w:t>", "Café</w:t>")));
    expect(document.paragraphs[0].runs[0].style.fontFamily).toBe("Cached");
    expect(document.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    expect(document.paragraphs[0].runs[0].resolvedStyle?.color).toBe("336699");
    expect(await exportDocx(document)).toEqual(bytes);
  });

  it.each([
    ["unrelated", (parts: ZipEntry[]) => rewrite(parts, RELS, (xml) => xml.replace(/<Relationship Id="rTheme"[^>]+\/>/, ""))],
    ["duplicate relationships", (parts: ZipEntry[]) => rewrite(parts, RELS, (xml) => xml.replace('</Relationships>', `<Relationship Id="rTheme2" Type="${R}/theme" Target="../assets/themes/editorial.xml"/></Relationships>`))],
    ["wrong root", (parts: ZipEntry[]) => rewrite(parts, THEME_PART, (xml) => xml.replaceAll("a:theme ", "a:notTheme ").replaceAll("</a:theme>", "</a:notTheme>"))],
    ["wrong content type", (parts: ZipEntry[]) => rewrite(parts, "[Content_Types].xml", (xml) => xml.replace(THEME_TYPE, "application/xml"))],
    ["missing font", (parts: ZipEntry[]) => rewrite(parts, THEME_PART, (xml) => xml.replace('typeface="Georgia"', 'typeface=""'))],
    ["unknown font token", (parts: ZipEntry[]) => rewrite(parts, STYLES, (xml) => xml.replaceAll("majorAscii", "unknown").replaceAll("majorHAnsi", "unknown"))],
  ])("does not invent a heading theme font for %s", async (_label, change) => {
    const doc = await variant(change);
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
    expect(doc.paragraphs[1].runs[1].resolvedStyle?.fontFamily).toBe("Courier New");
  });

  it.each([
    ["invalid RGB", (xml: string) => xml.replace('val="336699"', 'val="NOTRGB"')],
    ["unknown color node", (xml: string) => xml.replace('<a:accent1><a:srgbClr val="336699"/></a:accent1>', '<a:accent1><a:prstClr val="red"/></a:accent1>')],
    ["unsupported transform", (xml: string) => xml.replace('<a:srgbClr val="336699"/>', '<a:srgbClr val="336699"><a:alpha val="50000"/></a:srgbClr>')],
    ["duplicate slot", (xml: string) => xml.replace('</a:clrScheme>', '<a:accent1><a:srgbClr val="123456"/></a:accent1></a:clrScheme>')],
  ])("does not use stale literal caches for %s", async (_label, change) => {
    const doc = await variant((parts) => rewrite(parts, THEME_PART, change));
    expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBeUndefined();
    expect(doc.paragraphs[1].runs[1].resolvedStyle?.color).toBe("cc0000");
  });

  it("never fetches an external theme and retains the existing package read-only diagnostic", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network access is forbidden"));
    try {
      const doc = await variant((parts) => rewrite(parts, RELS, (xml) => xml.replace('Target="../assets/themes/editorial.xml"', 'Target="https://example.test/theme.xml" TargetMode="External"')));
      expect(doc.canEdit).toBe(false);
      expect(doc.diagnostics).toContainEqual(expect.objectContaining({ code: "external-relationship" }));
      expect(doc.paragraphs[0].runs[0].resolvedStyle?.fontFamily).toBeUndefined();
      expect(doc.paragraphs[0].runs[0].resolvedStyle?.color).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("preserves package preflight rejection for a theme relationship with a missing target", async () => {
    await expect(variant((parts) => rewrite(parts, RELS, (xml) => xml.replace('Target="../assets/themes/editorial.xml"', 'Target="../assets/themes/missing.xml"')))).rejects.toMatchObject({ code: "invalid-relationships" });
  });
});
