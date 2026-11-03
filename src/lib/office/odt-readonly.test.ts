import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOdtOperations, exportOdt, openOdt, openOdtForDisplay } from "./odt";
import { ODT_FIXTURE_CONTENT, odtFixture } from "./odt.fixture";
import { exportRichDocument, openRichDocument } from "./rich-document";
import type { NativeRichDocument } from "./rich-text-types";
import { readZip, writeZip } from "./zip";

// Real producer output from src/lib/office/fixtures/report-source.html:
//   textutil -convert odt report-source.html             (macOS 26 TextEdit, ODF 1.0)
//   soffice --headless --infilter="HTML (StarWriter)" --convert-to odt:writer8 report-source.html
//                                                      (LibreOffice 26.8, ODF 1.4)
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const encoder = new TextEncoder();
const paragraphText = (document: NativeRichDocument, id: string) => document.paragraphs.find(p => p.id === id)?.text;
const topLevel = (document: NativeRichDocument) => document.blocks.map(block => block.kind === "paragraph" ? paragraphText(document, block.paragraphId) : "[table]");
const cells = (document: NativeRichDocument) => document.tables[0].rows.map(row => row.cells.map(cell => cell.paragraphs.map(p => p.text).join("\n")));
const byText = (document: NativeRichDocument, text: string) => document.paragraphs.find(p => p.text === text);

/** Swap one XML part of a real package, keeping the rest of its bytes. */
async function withPart(bytes: Uint8Array, name: string, replace: (xml: string) => string): Promise<Uint8Array> {
  const entries = await readZip(bytes);
  return writeZip(entries.map(entry => entry.name === name ? { name, data: encoder.encode(replace(new TextDecoder().decode(entry.data))) } : entry));
}

describe("read-only display of OpenDocument text beyond the editable subset", () => {
  it("opens a real TextEdit ODT, whose manifest names an external DTD, with headings, emphasis, lists and a table", async () => {
    const bytes = fixture("textedit-report.odt");
    expect(new TextDecoder().decode((await readZip(bytes)).find(e => e.name === "META-INF/manifest.xml")!.data)).toContain("<!DOCTYPE manifest:manifest PUBLIC");
    const document = await openRichDocument("odt", bytes) as NativeRichDocument;
    expect(document.format).toBe("odt");
    expect(document.canEdit).toBe(false);
    expect(topLevel(document)).toEqual(["Quarterly Report", "This is bold and italic text.", "Items", "Step one", "Step two", "First item", "Second item", "[table]", "After the table."]);
    expect(cells(document)).toEqual([["Name", "Qty"], ["Apples", "3"], ["Pears", "5"]]);
    expect(byText(document, "Quarterly Report")?.runs[0].style).toMatchObject({ bold: true, fontSizePoints: 24, fontFamily: "Times" });
    const body = byText(document, "This is bold and italic text.")!;
    expect(body.runs.find(r => r.text === "bold")?.style.bold).toBe(true);
    expect(body.runs.find(r => r.text === "italic")?.style.italic).toBe(true);
    expect(byText(document, "Step one")).toMatchObject({ listKind: "numbered", listLevel: 0, listNumber: 1 });
    expect(byText(document, "Step two")).toMatchObject({ listKind: "numbered", listNumber: 2 });
    expect(byText(document, "First item")).toMatchObject({ listKind: "bullet", listLevel: 0 });
    expect(byText(document, "Name")?.alignment).toBe("center");
    expect(document.pageLayout).toMatchObject({ widthPoints: 612, heightPoints: 792, marginTopPoints: 36, marginLeftPoints: 72 });
    expect(document.diagnostics[0]).toMatchObject({ code: "odt-read-only", severity: "warning" });
    expect(await exportRichDocument(document)).toEqual(bytes);
    expect(() => applyOdtOperations(document, [{ type: "replace-paragraph", paragraphId: document.paragraphs[0].id, text: "x" }])).toThrow("read-only");
  });

  it("opens a real LibreOffice ODF 1.4 document with heading styles, lists and a table", async () => {
    const bytes = fixture("libreoffice-report.odt");
    const document = await openRichDocument("odt", bytes) as NativeRichDocument;
    expect(document.canEdit).toBe(false);
    expect(topLevel(document)).toEqual(["Quarterly Report", "This is bold and italic text.", "Items", "Step one", "Step two", "First item", "Second item", "[table]", "After the table."]);
    expect(cells(document)).toEqual([["Name", "Qty"], ["Apples", "3"], ["Pears", "5"]]);
    expect(byText(document, "Quarterly Report")?.runs[0].style.bold).toBe(true);
    expect(byText(document, "Quarterly Report")!.runs[0].style.fontSizePoints!).toBeGreaterThan(12);
    expect(byText(document, "This is bold and italic text.")!.runs.find(r => r.text === "bold")?.style.bold).toBe(true);
    expect(byText(document, "Step two")).toMatchObject({ listKind: "numbered", listNumber: 2 });
    expect(byText(document, "Second item")).toMatchObject({ listKind: "bullet" });
    expect(await exportRichDocument(document)).toEqual(bytes);
  });

  it("keeps a document the bounded codec can edit editable", async () => {
    const document = await openOdtForDisplay(odtFixture());
    expect(document.canEdit).toBe(true);
    expect(document.diagnostics.map(d => d.code)).toEqual(["odt-bounded-rich-text"]);
  });

  it("leaves out hidden, deleted, annotation, note and drawing content, and flattens nested tables", async () => {
    const T = 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';
    const content = ODT_FIXTURE_CONTENT.replace('office:version="1.3"', `${T} office:version="1.4"`).replace("<office:text>", '<office:text><text:tracked-changes><text:changed-region><text:deletion><text:p>deleted secret</text:p></text:deletion></text:changed-region></text:tracked-changes><text:section text:display="none"><text:p>hidden section</text:p></text:section><text:p>Keep<office:annotation><text:p>private comment</text:p></office:annotation><text:note><text:note-body><text:p>note text</text:p></text:note-body></text:note><draw:frame><draw:text-box><text:p>frame text</text:p></draw:text-box></draw:frame> <text:a>link</text:a></text:p><table:table><table:table-row><table:table-cell><text:p>Outer</text:p><table:table><table:table-row><table:table-cell><text:p>Inner</text:p></table:table-cell></table:table-row></table:table></table:table-cell><table:covered-table-cell/><table:table-cell/></table:table-row></table:table>');
    const document = await openOdtForDisplay(odtFixture({ content }));
    expect(document.canEdit).toBe(false);
    expect(document.text).not.toMatch(/secret|hidden|private|note text|frame text/);
    expect(document.paragraphs[0].text).toBe("Keep link");
    expect(cells(document)).toEqual([["Outer\nInner", ""]]);
    expect(document.diagnostics.map(d => d.code)).toEqual(["odt-read-only", "odt-omitted"]);
  });

  it("still refuses hostile XML anywhere in the package instead of falling back", async () => {
    const lol = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>';
    const xxe = '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>';
    const textedit = fixture("textedit-report.odt");
    for (const bytes of [
      await withPart(textedit, "META-INF/manifest.xml", xml => xml.replace(/<!DOCTYPE[^>]*>/, lol)),
      await withPart(textedit, "META-INF/manifest.xml", xml => xml.replace(/<!DOCTYPE[^>]*>/, xxe).replace('manifest:full-path="/"', 'manifest:full-path="&xxe;"')),
      await withPart(textedit, "META-INF/manifest.xml", xml => xml.replace('"Manifest.dtd">', '"Manifest.dtd" [<!ATTLIST manifest:manifest a CDATA "x">]>')),
      await withPart(textedit, "content.xml", xml => xml.replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>${xxe}`).replace("Quarterly Report", "&xxe;")),
      await withPart(textedit, "content.xml", xml => xml.replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>${lol}`).replace("Quarterly Report", "&lol2;")),
      await withPart(textedit, "styles.xml", xml => xml.replace('<?xml version="1.0" encoding="UTF-8"?>', `<?xml version="1.0" encoding="UTF-8"?>${xxe}`)),
    ]) {
      await expect(openRichDocument("odt", bytes)).rejects.toThrow(/DTD|declarations|entit/i);
    }
  });

  it("still refuses encrypted, signed, scripted and non-text packages", async () => {
    const manifest = (extra: string) => `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${extra}</manifest:manifest>`;
    const v14 = ODT_FIXTURE_CONTENT.replace('office:version="1.3"', 'office:version="1.4"');
    await expect(openOdtForDisplay(odtFixture({ content: v14, extra: [], manifest: manifest('<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry>') }))).rejects.toThrow("Encrypted");
    await expect(openOdtForDisplay(odtFixture({ content: v14, extra: [{ name: "Basic/Standard/Module1.xml", data: new Uint8Array([1]) }] }))).rejects.toThrow("executable");
    await expect(openOdtForDisplay(odtFixture({ content: v14, extra: [{ name: "META-INF/documentsignatures.xml", data: new Uint8Array() }] }))).rejects.toThrow("Signed");
    await expect(openOdtForDisplay(odtFixture({ content: v14, manifest: manifest("").replace("opendocument.text", "opendocument.spreadsheet") }))).rejects.toThrow("media types");
  });

  it("keeps the strict editable codec strict", async () => {
    await expect(openOdt(fixture("textedit-report.odt"))).rejects.toThrow("1.2/1.3");
    const document = await openOdtForDisplay(fixture("textedit-report.odt"));
    expect(await exportOdt(document)).toEqual(fixture("textedit-report.odt"));
  });
});
