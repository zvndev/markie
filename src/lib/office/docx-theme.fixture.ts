// Team-authored, specification-shaped OOXML; never produced by another Office engine.
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { readZip, writeZip } from "./zip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const THEME_PART = "assets/themes/editorial.xml";
export const SETTINGS_PART = "word/preferences/theme-settings.xml";
export const RETAINED_PART = "customXml/retained.xml";

export async function themedDocxFixture() {
  const seed = applyDocxOperations(await createDocx("Themed heading\nTheme body Direct"), [
    { type: "format-paragraph", paragraphId: "p0", format: { styleId: "Heading1" } },
  ]);
  const parts = await readZip(await exportDocx(seed));
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const solidFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const theme = `<a:theme xmlns:a="${A}" name="Markie synthetic editorial"><a:themeElements>
    <a:clrScheme name="Editorial colors">
      <a:dk1><a:sysClr val="windowText" lastClr="222222"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="444444"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="336699"/></a:accent1><a:accent2><a:srgbClr val="808080"/></a:accent2>
      <a:accent3><a:srgbClr val="008000"/></a:accent3><a:accent4><a:srgbClr val="800080"/></a:accent4>
      <a:accent5><a:srgbClr val="008080"/></a:accent5><a:accent6><a:srgbClr val="800000"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Editorial fonts"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Editorial shapes"><a:fillStyleLst>${solidFill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${`<a:ln w="9525">${solidFill}<a:prstDash val="solid"/></a:ln>`.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solidFill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements></a:theme>`;
  const settings = `<w:settings xmlns:w="${W}"/>`;
  const styles = `<w:styles xmlns:w="${W}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorAscii" w:hAnsiTheme="minorHAnsi"/><w:color w:val="999999" w:themeColor="text1"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Themed heading"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:b/><w:color w:val="999999" w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="ThemeAccent"><w:name w:val="Themed accent"/><w:rPr><w:rFonts w:asciiTheme="majorAscii" w:hAnsiTheme="majorHAnsi"/><w:color w:themeColor="accent3"/></w:rPr></w:style>
  </w:styles>`;
  parts.find((part) => part.name === "word/styles.xml")!.data = encoder.encode(styles);
  const main = parts.find((part) => part.name === "word/document.xml")!;
  main.data = encoder.encode(decoder.decode(main.data).replace(/<w:p>.*?<\/w:p><w:p>.*?<\/w:p>/, '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Themed heading</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Theme body </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:color w:val="cc0000"/><w:sz w:val="18"/></w:rPr><w:t>Direct</w:t></w:r></w:p>'));
  const relationships = parts.find((part) => part.name === "word/_rels/document.xml.rels")!;
  relationships.data = encoder.encode(decoder.decode(relationships.data).replace('</Relationships>', `<Relationship Id="rTheme" Type="${R}/theme" Target="../assets/themes/editorial.xml"/><Relationship Id="rSettings" Type="${R}/settings" Target="preferences/theme-settings.xml"/></Relationships>`));
  parts.push({ name: THEME_PART, data: encoder.encode(theme) }, { name: SETTINGS_PART, data: encoder.encode(settings) }, { name: RETAINED_PART, data: encoder.encode('<retained xmlns="urn:markie:synthetic">Untouched original payload</retained>') });
  const manifest = parts.find((part) => part.name === "[Content_Types].xml")!;
  manifest.data = encoder.encode(decoder.decode(manifest.data).replace('</Types>', `<Override PartName="/${THEME_PART}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/${SETTINGS_PART}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`));
  const bytes = writeZip(parts);
  return { document: await openDocx(bytes), bytes, theme, settings, styles };
}
