// Synthetic specification-shaped package, never copied from an Office engine.
import { applyDocxOperations, createDocx, exportDocx, openDocx } from "./docx";
import { readZip, writeZip } from "./zip";

export async function customStyleFixture(styleId = "EditorialBody", characterStyle?: string) {
  const seed = applyDocxOperations(await createDocx("Alpha Beta\nSecond paragraph"), [{ type: "format-paragraph", paragraphId: "p0", format: { styleId: "Heading1" } }]);
  const parts = await readZip(await exportDocx(seed)), encoder = new TextEncoder(), decoder = new TextDecoder();
  const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:rFonts w:ascii="Cambria"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="DefaultDoc"><w:name w:val="Document default"/><w:rPr><w:color w:val="333333"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="EditorialBody"><w:name w:val="Editorial body"/><w:basedOn w:val="DefaultDoc"/><w:rPr><w:b/><w:sz w:val="32"/><w:rFonts w:ascii="Aptos"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="EditorialLead"><w:name w:val="Editorial lead"/><w:basedOn w:val="EditorialBody"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Unbold"><w:name w:val="Toggle bold off"/><w:basedOn w:val="EditorialBody"/><w:rPr><w:b/></w:rPr></w:style>
    <w:style w:type="character" w:styleId="CharacterAccent"><w:name w:val="Character accent"/><w:rPr><w:color w:val="225588"/><w:u/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="CycleA"><w:basedOn w:val="CycleB"/><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CycleB"><w:basedOn w:val="CycleA"/><w:rPr><w:b/></w:rPr></w:style>
  </w:styles>`;
  parts.find((part) => part.name === "word/styles.xml")!.data = encoder.encode(styles);
  const main = parts.find((part) => part.name === "word/document.xml")!;
  main.data = encoder.encode(decoder.decode(main.data).replace(/<w:p>.*?<\/w:p>/, `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:rPr><w:b w:val="0"/><w:color w:val="cc0000"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">Alpha </w:t></w:r><w:r>${characterStyle ? `<w:rPr><w:rStyle w:val="${characterStyle}"/></w:rPr>` : ""}<w:t>Beta</w:t></w:r></w:p>`));
  const bytes = writeZip(parts);
  return { bytes, styles, document: await openDocx(bytes) };
}
