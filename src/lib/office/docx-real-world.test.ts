import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, getDocxImageBytes, openDocx, replaceDocxRange, replaceDocxText, type DocxDocument } from "./docx";
import { decodeDocxXml, encodeDocxXml } from "./docx-encoding";
import { readZip, writeZip, zipCrc32, type ZipEntry } from "./zip";

/* Synthetic, invented-text fixtures reproducing the structural shapes common in
 * Word, Google Docs and generator exports. No real document content is used. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const ROOT = `xmlns:w="${W}" xmlns:r="${R}" xmlns:w14="${W14}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:mc="${MC}" mc:Ignorable="w14"`;

interface Fixture {
  parts?: Record<string, string | Uint8Array>;
  /** Relationship XML fragments for word/_rels/document.xml.rels. */
  rels?: string[];
  /** Relationship XML fragments appended to the package _rels/.rels. */
  packageRels?: string[];
  defaults?: Record<string, string>;
  mainBytes?: (xml: string) => Uint8Array;
}

async function build(body: string, options: Fixture = {}): Promise<Uint8Array> {
  const entries: ZipEntry[] = await readZip(await exportDocx(await createDocx("Seed")));
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ROOT}><w:body>${body}</w:body></w:document>`;
  entries.find((e) => e.name === "word/document.xml")!.data = options.mainBytes ? options.mainBytes(xml) : encoder.encode(xml);
  const manifest = entries.find((e) => e.name === "[Content_Types].xml")!;
  const defaults = Object.entries({ png: "image/png", jpeg: "image/jpeg", odttf: "application/vnd.openxmlformats-officedocument.obfuscatedFont", ...options.defaults })
    .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`).join("");
  manifest.data = encoder.encode(decoder.decode(manifest.data).replace("<Default", `${defaults}<Default`));
  for (const [name, data] of Object.entries(options.parts ?? {})) entries.push({ name, data: typeof data === "string" ? encoder.encode(data) : data });
  if (options.rels?.length) entries.push({ name: "word/_rels/document.xml.rels", data: encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}">${options.rels.join("")}</Relationships>`) });
  if (options.packageRels?.length) {
    const packageRels = entries.find((e) => e.name === "_rels/.rels")!;
    packageRels.data = encoder.encode(decoder.decode(packageRels.data).replace("</Relationships>", `${options.packageRels.join("")}</Relationships>`));
  }
  return writeZip(entries);
}

async function parts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return new Map((await readZip(bytes)).map((e) => [e.name, e.data]));
}
async function mainXml(bytes: Uint8Array): Promise<string> {
  return decoder.decode((await parts(bytes)).get("word/document.xml")!);
}
/** Every part except the main document must be byte-identical after an edit. */
async function expectOnlyMainChanged(before: Uint8Array, after: Uint8Array): Promise<void> {
  const a = await parts(before), b = await parts(after);
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [name, data] of a) if (name !== "word/document.xml") expect(b.get(name), name).toEqual(data);
}
function runOf(doc: DocxDocument, text: string) {
  const run = doc.paragraphs.flatMap((p) => p.runs).find((r) => r.text === text);
  if (!run) throw new Error(`No run ${text}`);
  return run;
}
function png(): Uint8Array {
  const chunk = (name: string, data: Uint8Array) => {
    const output = new Uint8Array(data.length + 12);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length); output.set(encoder.encode(name), 4); output.set(data, 8);
    view.setUint32(8 + data.length, zipCrc32(output.subarray(4, 8 + data.length)));
    return output;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1); new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", deflateSync(new Uint8Array([0, 10, 20, 30, 255]))), ...chunk("IEND", new Uint8Array())]);
}

const HEADER = `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Invented header</w:t></w:r></w:p></w:hdr>`;
const FOOTER = `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
const SECTION = '<w:sectPr w:rsidR="00AB12CD"><w:headerReference w:type="default" r:id="rIdH1"/><w:headerReference w:type="first" r:id="rIdH2"/><w:footerReference w:type="default" r:id="rIdF1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:pgNumType w:start="1"/><w:cols w:space="720"/><w:titlePg/><w:docGrid w:linePitch="360"/></w:sectPr>';

/** A package shaped like a typical Word/SharePoint export: headers/footers,
 * thumbnail, customXml, stylesWithEffects, embedded fonts, add-in task panes,
 * comment people/extension parts and a doubled-up external hyperlink rel. */
async function wordPackage(body: string, header = HEADER): Promise<Uint8Array> {
  return build(body + SECTION, {
    parts: {
      "word/header1.xml": header, "word/header2.xml": HEADER, "word/footer1.xml": FOOTER,
      "docProps/thumbnail.jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      "customXml/item1.xml": '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>',
      "customXml/itemProps1.xml": '<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{00000000-0000-0000-0000-000000000001}"/>',
      "customXml/_rels/item1.xml.rels": `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/customXmlProps" Target="itemProps1.xml"/></Relationships>`,
      "word/stylesWithEffects.xml": `<w:styles xmlns:w="${W}"/>`,
      "word/fontTable.xml": `<w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="Invented Sans"><w:embedRegular r:id="rIdFont1" w:fontKey="{00000000-0000-0000-0000-000000000002}"/></w:font></w:fonts>`,
      "word/_rels/fontTable.xml.rels": `<Relationships xmlns="${REL}"><Relationship Id="rIdFont1" Type="${R}/font" Target="fonts/font1.odttf"/></Relationships>`,
      "word/fonts/font1.odttf": new Uint8Array([1, 2, 3, 4]),
      "word/webextensions/taskpanes.xml": '<wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11"/>',
      "word/webextensions/_rels/taskpanes.xml.rels": `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/></Relationships>`,
      "word/webextensions/webextension1.xml": '<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{00000000-0000-0000-0000-000000000003}"/>',
      "word/people.xml": '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>',
      "word/commentsExtended.xml": '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"/>',
    },
    rels: [
      `<Relationship Id="rIdH1" Type="${R}/header" Target="header1.xml"/>`, `<Relationship Id="rIdH2" Type="${R}/header" Target="header2.xml"/>`,
      `<Relationship Id="rIdF1" Type="${R}/footer" Target="footer1.xml"/>`, `<Relationship Id="rIdCx" Type="${R}/customXml" Target="../customXml/item1.xml"/>`,
      `<Relationship Id="rIdSwe" Type="http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects" Target="stylesWithEffects.xml"/>`,
      `<Relationship Id="rIdFonts" Type="${R}/fontTable" Target="fontTable.xml"/>`,
      `<Relationship Id="rIdPeople" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>`,
      `<Relationship Id="rIdCex" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>`,
      `<Relationship Id="rIdUnused" Type="${R}/hyperlink" Target="https://example.invalid/unused" TargetMode="External"/>`,
      `<Relationship Id="rIdBare" Type="${R}/hyperlink" Target="www.example.invalid" TargetMode="External"/>`,
    ],
    packageRels: [
      `<Relationship Id="rIdThumb" Type="${REL}/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>`,
      `<Relationship Id="rIdPanes" Type="http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes" Target="word/webextensions/taskpanes.xml"/>`,
    ],
  });
}

describe("real-world Word packages: inert dependencies ride along verbatim", () => {
  it("opens a header/footer/customXml/thumbnail/font/add-in package editable and changes only the edited text", async () => {
    const bytes = await wordPackage('<w:p><w:r><w:t>Alpha bravo</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.diagnostics.filter((d) => d.severity === "warning")).toEqual([]);
    expect(doc.diagnostics.some((d) => d.code === "unrendered-header-footer" && d.severity === "info")).toBe(true);
    expect(doc.canEdit).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Alpha bravo").id, text: "Alpha charlie" }]));
    await expectOnlyMainChanged(bytes, output);
    expect(await mainXml(output)).toBe((await mainXml(bytes)).replace("<w:t>Alpha bravo</w:t>", '<w:t xml:space="preserve">Alpha charlie</w:t>'));
    expect((await openDocx(output)).canEdit).toBe(true);
  });

  it("keeps every headerReference, footerReference and titlePg in order when page layout changes", async () => {
    const bytes = await wordPackage('<w:p><w:r><w:t>Body</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    const output = await exportDocx(applyDocxOperations(doc, [{ type: "set-page-layout", layout: { orientation: "landscape" } }]));
    const section = /<w:sectPr[^]*<\/w:sectPr>/.exec(await mainXml(output))![0];
    const order = [...section.matchAll(/<w:(\w+)/g)].map((m) => m[1]);
    expect(order).toEqual(["sectPr", "headerReference", "headerReference", "footerReference", "pgSz", "pgMar", "pgNumType", "cols", "titlePg", "docGrid"]);
    expect(section).toContain('w:type="first" r:id="rIdH2"');
    expect((await openDocx(output)).pageLayout.orientation).toBe("landscape");
  });

  it("keeps a header with pending tracked changes read-only", async () => {
    const tracked = `<w:hdr xmlns:w="${W}"><w:p><w:ins w:id="9" w:author="Reviewer" w:date="2024-01-01T00:00:00Z"><w:r><w:t>Added</w:t></w:r></w:ins></w:p></w:hdr>`;
    const bytes = await wordPackage('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', tracked);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "unsupported-revisions" && d.part === "word/header1.xml")).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("keeps script, data and file-path hyperlink destinations read-only even when unreferenced", async () => {
    for (const target of ["javascript:alert(1)", "file:///C:/invented/run.exe", "../../invented/local.docx", "\\\\server\\share\\x.doc"]) {
      const bytes = await build('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', { rels: [`<Relationship Id="rIdX" Type="${R}/hyperlink" Target="${target.replace(/&/g, "&amp;")}" TargetMode="External"/>`] });
      const doc = await openDocx(bytes);
      expect(doc.canEdit, target).toBe(false);
      expect(doc.diagnostics.some((d) => d.code === "external-relationship")).toBe(true);
    }
  });
});

describe("real-world Word markup: formatting properties are opaque passthrough", () => {
  const P_PR = '<w:pPr><w:pStyle w:val="Normal"/><w:keepNext/><w:widowControl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:spacing w:after="120"/><w:contextualSpacing/><w:outlineLvl w:val="1"/><w:rPr><w:b/><w:lang w:val="en-GB"/></w:rPr></w:pPr>';
  const R_PR = '<w:rPr><w:rFonts w:ascii="Invented Serif" w:hAnsi="Invented Serif"/><w:caps/><w:color w:val="1F3864"/><w:kern w:val="2"/><w:highlight w:val="yellow"/><w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:vertAlign w:val="superscript"/><w:lang w:val="en-US"/><w14:ligatures w14:val="standardContextual"/></w:rPr>';
  const paragraph = `<w:p w:rsidR="00112233" w:rsidRDefault="00112233" w:rsidP="00445566" w14:paraId="1A2B3C4D" w14:textId="5E6F7A8B">${P_PR}<w:r w:rsidRPr="00778899">${R_PR}<w:t>Opaque formatting</w:t></w:r></w:p>`;

  it("edits text inside unmodeled pPr/rPr without touching either", async () => {
    const bytes = await build(paragraph + '<w:p><w:r><w:t>Second</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Opaque formatting").id, text: "Still opaque" }]));
    const xml = await mainXml(output);
    expect(xml).toContain(P_PR); expect(xml).toContain(R_PR);
    await expectOnlyMainChanged(bytes, output);
  });

  it("inserts modeled run properties at their schema position, keeping unmodeled and extension properties", async () => {
    const doc = await openDocx(await build(paragraph));
    const output = await exportDocx(applyDocxOperations(doc, [{ type: "format-run", runId: runOf(doc, "Opaque formatting").id, style: { bold: true, underline: "single", fontSizePoints: 11 } }]));
    const rPr = /<w:r w:rsidRPr="00778899"><w:rPr>([^]*?)<\/w:rPr>/.exec(await mainXml(output))![1];
    expect([...rPr.matchAll(/<(\w+:\w+)/g)].map((m) => m[1])).toEqual(["w:rFonts", "w:b", "w:caps", "w:color", "w:kern", "w:sz", "w:highlight", "w:u", "w:shd", "w:vertAlign", "w:lang", "w14:ligatures"]);
    expect((await openDocx(output)).paragraphs[0].runs[0].style).toMatchObject({ bold: true, underline: "single", fontSizePoints: 11 });
  });

  it("inserts paragraph alignment and list numbering at their schema positions without disturbing pBdr, tabs or the paragraph-mark rPr", async () => {
    const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const doc = await openDocx(await build(paragraph, { parts: { "word/numbering.xml": numbering }, rels: [`<Relationship Id="rIdN" Type="${R}/numbering" Target="numbering.xml"/>`] }));
    const changed = applyDocxOperations(doc, [{ type: "format-paragraph", paragraphId: doc.paragraphs[0].id, format: { alignment: "center" } }, { type: "set-list", paragraphId: doc.paragraphs[0].id, kind: "bullet" }]);
    const pPr = /<w:pPr>([^]*?)<\/w:pPr>/.exec(await mainXml(await exportDocx(changed)))![1];
    expect([...pPr.matchAll(/<(w:\w+)/g)].map((m) => m[1]).filter((n) => !["w:bottom", "w:tab", "w:b", "w:lang", "w:ilvl", "w:numId"].includes(n)))
      .toEqual(["w:pStyle", "w:keepNext", "w:widowControl", "w:numPr", "w:pBdr", "w:shd", "w:tabs", "w:spacing", "w:contextualSpacing", "w:jc", "w:outlineLvl", "w:rPr"]);
    const reopened = await openDocx(await exportDocx(changed));
    expect(reopened.paragraphs[0]).toMatchObject({ alignment: "center", listKind: "bullet" });
  });

  it("splits a paragraph copying opaque pPr to both halves and rPr to both run fragments; joins only identical pPr", async () => {
    const doc = await openDocx(await build(paragraph + '<w:p><w:r><w:t>Plain</w:t></w:r></w:p>'));
    const split = replaceDocxRange(doc, { anchor: { paragraphId: doc.paragraphs[0].id, offset: 6 }, focus: { paragraphId: doc.paragraphs[0].id, offset: 6 } }, "\n").document;
    const xml = await mainXml(await exportDocx(split));
    expect(xml.split(P_PR)).toHaveLength(3);
    expect(xml.split(R_PR)).toHaveLength(3);
    expect(xml.match(/w14:paraId/g)).toHaveLength(1);
    expect(split.text).toBe("Opaque\n formatting\nPlain");
    const rejoined = replaceDocxRange(split, { anchor: { paragraphId: split.paragraphs[0].id, offset: 6 }, focus: { paragraphId: split.paragraphs[1].id, offset: 0 } }, "").document;
    expect(rejoined.text).toBe("Opaque formatting\nPlain");
    expect(() => replaceDocxRange(rejoined, { anchor: { paragraphId: rejoined.paragraphs[0].id, offset: 17 }, focus: { paragraphId: rejoined.paragraphs[1].id, offset: 0 } }, "")).toThrow(/different paragraph properties/);
  });

  it("opens Word/Google table shapes (borders, header rows, merged cells, doubled layout, empty grid) editable and verbatim", async () => {
    const cell = (text: string, props = "") => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${props}<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/><w:tcMar><w:top w:w="100" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
    const tblPr = '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="6000" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>';
    const table = `<w:tbl>${tblPr}<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:tblGridChange w:id="0"><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid></w:tblGridChange></w:tblGrid>`
      + `<w:tr w:rsidR="00AA0000" w14:paraId="0A0B0C0D" w14:textId="77777777"><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${cell("Head A", '<w:gridSpan w:val="2"/>')}${cell("Head B")}</w:tr>`
      + `<w:tr><w:tblPrEx><w:tblCellMar><w:left w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx>${cell("One", '<w:vMerge w:val="restart"/>')}${cell("Two")}${cell("Three")}</w:tr>`
      + `<w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr>${cell("Four")}${cell("Five")}</w:tr></w:tbl>`;
    const emptyGrid = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/><w:tr>${cell("X")}${cell("Y")}</w:tr><w:tr>${cell("Z", '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`;
    const bytes = await build(`<w:p><w:r><w:t>Before</w:t></w:r></w:p>${table}${emptyGrid}<w:p/>`);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.tables.map((t) => t.rows.map((r) => r.cells.length))).toEqual([[2, 3, 2], [2, 1]]);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Two").id, text: "Deux" }]));
    expect(await mainXml(output)).toBe((await mainXml(bytes)).replace("<w:t>Two</w:t>", '<w:t xml:space="preserve">Deux</w:t>'));
  });

  it.each([
    ["paragraph property revision", '<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:pPr/></w:pPrChange></w:pPr><w:r><w:t>A</w:t></w:r></w:p>'],
    ["run property revision", '<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>A</w:t></w:r></w:p>'],
    ["tracked paragraph mark", '<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p>'],
    ["hidden paragraph mark", '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>A</w:t></w:r></w:p>'],
    ["duplicate run property", '<w:p><w:r><w:rPr><w:b/><w:b w:val="0"/></w:rPr><w:t>A</w:t></w:r></w:p>'],
    ["text inside properties", '<w:p><w:pPr>hidden</w:pPr><w:r><w:t>A</w:t></w:r></w:p>'],
    ["nested table", '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p/></w:tc></w:tr></w:tbl><w:p/>'],
    ["row wider than its grid", '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl><w:p/>'],
    ["content control", '<w:sdt><w:sdtPr><w:alias w:val="X"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>A</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p/>'],
    ["unbalanced field", '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>A</w:t></w:r></w:p>'],
    ["legacy form field", '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Check1"/></w:ffData></w:fldChar></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'],
    ["unpaired body bookmark", '<w:bookmarkStart w:id="4" w:name="_orphan"/><w:p><w:r><w:t>A</w:t></w:r></w:p>'],
  ])("still keeps %s read-only and byte-identical", async (_label, markup) => {
    const bytes = await build(markup);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(await exportDocx(doc)).toEqual(bytes);
  });
});

describe("real-world inline content: per-run locks instead of whole-document locks", () => {
  it("keeps tab and line-break runs read-only while neighbouring text stays editable and formatting offsets stay aligned", async () => {
    const bytes = await build('<w:p><w:r><w:t>Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Value</w:t></w:r></w:p><w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.text).toBe("Name\tValue\nLine one\nLine two");
    expect(doc.paragraphs[0].runs.map((r) => r.canEdit)).toEqual([true, false, true]);
    expect(doc.paragraphs[1].runs[0].canEdit).toBe(false);
    const formatted = applyDocxOperations(doc, [{ type: "format-range", paragraphId: doc.paragraphs[0].id, start: 5, end: 10, style: { bold: true } }]);
    expect(formatted.paragraphs[0].runs.find((r) => r.text === "Value")?.style.bold).toBe(true);
    expect(() => applyDocxOperations(doc, [{ type: "format-range", paragraphId: doc.paragraphs[0].id, start: 3, end: 6, style: { bold: true } }])).toThrow(/mixed/);
    const linked = applyDocxOperations(doc, [{ type: "set-hyperlink", paragraphId: doc.paragraphs[0].id, start: 5, end: 10, target: "https://example.invalid/" }]);
    expect(linked.hyperlinks[0].text).toBe("Value");
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId: doc.paragraphs[0].id }])).toThrow(/tabs/);
  });

  it("treats a multi-paragraph field (table of contents) as read-only runs that refuse structural edits", async () => {
    const field = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:hyperlink w:anchor="_Toc1" w:history="1"><w:r><w:t>Intro</w:t></w:r></w:hyperlink></w:p>'
      + '<w:p><w:hyperlink w:anchor="_Toc2" w:history="1"><w:r><w:t>Scope</w:t></w:r></w:hyperlink><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    const bytes = await build(`${field}<w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Intro</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p><w:p><w:bookmarkStart w:id="1" w:name="_Toc2"/><w:r><w:t>Scope</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.hyperlinks).toEqual([]);
    expect(doc.paragraphs.slice(0, 2).flatMap((p) => p.runs).every((r) => !r.canEdit)).toBe(true);
    expect(doc.paragraphs[2].runs[0].canEdit).toBe(true);
    const at = (index: number, offset: number) => ({ anchor: { paragraphId: doc.paragraphs[index].id, offset }, focus: { paragraphId: doc.paragraphs[index].id, offset } });
    expect(() => replaceDocxRange(doc, at(1, 2), "\n")).toThrow(/field/);
    expect(() => applyDocxOperations(doc, [{ type: "insert-paragraph", afterParagraphId: doc.paragraphs[0].id, text: "x" }])).toThrow(/field/);
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId: doc.paragraphs[1].id }])).toThrow(/fields/);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: doc.paragraphs[2].runs[0].id, text: "Introduction" }]));
    expect(await mainXml(output)).toContain(field);
  });

  it("keeps internal-anchor and bare-address hyperlinks as opaque containers whose plain text stays editable", async () => {
    const bytes = await build('<w:p><w:hyperlink w:anchor="_Top"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>Back to top</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="rIdBare"><w:r><w:t>example site</w:t></w:r></w:hyperlink></w:p><w:p><w:bookmarkStart w:id="0" w:name="_Top"/><w:bookmarkEnd w:id="0"/></w:p>',
      { rels: [`<Relationship Id="rIdBare" Type="${R}/hyperlink" Target="www.example.invalid" TargetMode="External"/>`] });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.hyperlinks).toEqual([]);
    expect(doc.paragraphs.flatMap((p) => p.runs).every((r) => r.target === undefined)).toBe(true);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Back to top").id, text: "Top" }]));
    expect(await mainXml(output)).toContain('<w:hyperlink w:anchor="_Top"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">Top</w:t></w:r></w:hyperlink>');
    await expectOnlyMainChanged(bytes, output);
  });

  it("preserves body-level bookmarks between paragraphs", async () => {
    const bytes = await build('<w:bookmarkStart w:id="0" w:name="_gjdgxs"/><w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/><w:p><w:r><w:t>Next</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.blocks).toHaveLength(2);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Next").id, text: "Changed" }]));
    expect(await mainXml(output)).toContain('<w:bookmarkStart w:id="0" w:name="_gjdgxs"/><w:p><w:r><w:t>Kept</w:t></w:r></w:p><w:bookmarkEnd w:id="0"/>');
  });

  it("accepts cropped/outlined inline pictures declared by extension, with repeated drawing ids, and still deletes one safely", async () => {
    const picture = (id: string, rid: string) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" wp14:anchorId="0A1B2C3D" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture" descr="Invented picture" title=""/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image.png"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}" cstate="print"/><a:srcRect l="10" t="0" r="10" b="0"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="9525"><a:noFill/><a:headEnd/><a:tailEnd/></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const bytes = await build(`<w:p>${picture("1", "rIdImg1")}</w:p><w:p>${picture("1", "rIdImg2")}</w:p><w:p><w:r><w:t>Caption</w:t></w:r></w:p>`, {
      parts: { "word/media/image1.png": png(), "word/media/image2.png": png() },
      rels: [`<Relationship Id="rIdImg1" Type="${R}/image" Target="media/image1.png"/>`, `<Relationship Id="rIdImg2" Type="${R}/image" Target="media/image2.png"/>`],
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.images.map((i) => [i.id, i.contentType])).toEqual([["1", "image/png"], ["1~2", "image/png"]]);
    expect(getDocxImageBytes(doc, "1~2")).toEqual(png());
    const deleted = applyDocxOperations(doc, [{ type: "delete-image", imageId: "1~2" }]);
    const reopened = await openDocx(await exportDocx(deleted));
    expect(reopened.images).toHaveLength(1);
    expect((await parts(await exportDocx(deleted))).has("word/media/image2.png")).toBe(false);
    const linked = await build(`<w:p>${picture("1", "rIdImg1").replace('r:embed="rIdImg1"', 'r:link="rIdImg1"')}</w:p>`, { parts: { "word/media/image1.png": png() }, rels: [`<Relationship Id="rIdImg1" Type="${R}/image" Target="media/image1.png"/>`] });
    expect((await openDocx(linked)).canEdit).toBe(false);
  });
});

describe("real-world XML encodings", () => {
  it("opens a UTF-16LE customXml item and keeps it byte-identical through an edit", async () => {
    const item = encodeDocxXml('<?xml version="1.0" encoding="utf-16"?><invented xmlns="urn:invented:meta"><v>é</v></invented>', "utf-16le");
    const bytes = await build('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', {
      parts: { "customXml/item1.xml": item }, rels: [`<Relationship Id="rIdCx" Type="${R}/customXml" Target="../customXml/item1.xml"/>`],
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Body").id, text: "Edited" }]));
    await expectOnlyMainChanged(bytes, output);
  });

  it.each(["utf-16le", "utf-16be", "utf-8-bom"] as const)("re-encodes an edited %s main part in its original encoding", async (encoding) => {
    const bytes = await build('<w:p><w:r><w:t>Body</w:t></w:r></w:p>', {
      mainBytes: (xml) => encodeDocxXml(encoding === "utf-8-bom" ? xml : xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'), encoding),
    });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: runOf(doc, "Body").id, text: "Zoë" }]));
    const main = (await parts(output)).get("word/document.xml")!;
    expect(decodeDocxXml(main).encoding).toBe(encoding);
    expect((await openDocx(output)).text).toBe("Zoë");
  });

  it("rejects XML whose declaration contradicts its bytes", async () => {
    expect(() => decodeDocxXml(encoder.encode('<?xml version="1.0" encoding="UTF-16"?><p/>'))).toThrow(/does not match/);
    expect(() => decodeDocxXml(encodeDocxXml('<?xml version="1.0" encoding="UTF-8"?><p/>', "utf-16le"))).toThrow(/does not match/);
    await expect(build('<w:p/>', { parts: { "customXml/item1.xml": encoder.encode('<?xml version="1.0" encoding="UTF-16"?><x/>') }, rels: [`<Relationship Id="rIdCx" Type="${R}/customXml" Target="../customXml/item1.xml"/>`] }).then(openDocx)).rejects.toThrow(/does not match/);
  });
});
