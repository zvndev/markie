import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, openDocx, replaceDocxText } from "./docx";
import { readZip, writeZip } from "./zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const VML = "urn:schemas-microsoft-com:vml";
const OFFICE = "urn:schemas-microsoft-com:office:office";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";

const NUMBERING = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="3"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num></w:numbering>`;
const SEPARATOR_FOOTNOTES = `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>`;
const SEPARATOR_ENDNOTES = `<w:endnotes xmlns:w="${W}"><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote></w:endnotes>`;
const REAL_FOOTNOTES = `<w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>A real note</w:t></w:r></w:p></w:footnote></w:footnotes>`;
const HR_PICT = `<w:pict w14:anchorId="1234ABCD"><v:rect o:hr="t" o:hralign="center" o:hrstd="t" style="width:100%"/></w:pict>`;

interface FixtureOptions { numbering?: boolean; notes?: "separator" | "real" }

async function fixture(bodyMarkup: string, options: FixtureOptions = {}): Promise<Uint8Array> {
  const entries = await readZip(await exportDocx(await createDocx("Seed")));
  const document = entries.find((e) => e.name === "word/document.xml")!;
  document.data = encoder.encode(`<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:v="${VML}" xmlns:o="${OFFICE}" xmlns:w14="${W14}"><w:body>${bodyMarkup}</w:body></w:document>`);
  const rels: string[] = [];
  if (options.numbering) {
    entries.push({ name: "word/numbering.xml", data: encoder.encode(NUMBERING) });
    rels.push(`<Relationship Id="rId7" Type="${R}/numbering" Target="numbering.xml"/>`);
  }
  if (options.notes) {
    entries.push({ name: "word/footnotes.xml", data: encoder.encode(options.notes === "real" ? REAL_FOOTNOTES : SEPARATOR_FOOTNOTES) });
    entries.push({ name: "word/endnotes.xml", data: encoder.encode(SEPARATOR_ENDNOTES) });
    rels.push(`<Relationship Id="rId8" Type="${R}/footnotes" Target="footnotes.xml"/>`);
    rels.push(`<Relationship Id="rId9" Type="${R}/endnotes" Target="endnotes.xml"/>`);
  }
  if (rels.length) entries.push({ name: "word/_rels/document.xml.rels", data: encoder.encode(`<Relationships xmlns="${REL}">${rels.join("")}</Relationships>`) });
  return writeZip(entries);
}

async function partText(bytes: Uint8Array, name: string): Promise<string> {
  const parts = await readZip(bytes);
  return decoder.decode(parts.find((p) => p.name === name)!.data);
}

describe("generator-shaped DOCX subset (bookmarks, note separators, VML rules, multi-level lists)", () => {
  it("treats paired bookmarks and noProof as inert and preserves them across run edits", async () => {
    const bytes = await fixture('<w:p><w:bookmarkStart w:id="1" w:name="heading"/><w:r><w:rPr><w:noProof/></w:rPr><w:t>Hello</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:r><w:t>World</w:t></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    const edited = replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "Changed" }]);
    const output = await exportDocx(edited);
    const xml = await partText(output, "word/document.xml");
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="heading"/>');
    expect(xml).toContain("<w:noProof/>");
    expect((await openDocx(output)).text).toBe("Changed\nWorld");
  });

  it("accepts separator-only footnote/endnote parts and preserves them byte-for-byte", async () => {
    const bytes = await fixture('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', { notes: "separator" });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    const output = await exportDocx(replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "Edited" }]));
    expect(await partText(output, "word/footnotes.xml")).toBe(SEPARATOR_FOOTNOTES);
    expect(await partText(output, "word/endnotes.xml")).toBe(SEPARATOR_ENDNOTES);
  });

  it("keeps real footnote content read-only and byte-identical", async () => {
    const bytes = await fixture('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>', { notes: "real" });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("preserves a VML horizontal rule as an opaque run while editing other paragraphs", async () => {
    const bytes = await fixture(`<w:p><w:r><w:t>Before</w:t></w:r></w:p><w:p><w:r><w:rPr><w:noProof/></w:rPr>${HR_PICT}</w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p>`);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.paragraphs[1].text).toBe("");
    const edited = replaceDocxText(doc, [{ runId: doc.paragraphs[0].runs[0].id, text: "Changed" }]);
    const xml = await partText(await exportDocx(edited), "word/document.xml");
    expect(xml).toContain(HR_PICT);
    expect((await openDocx(await exportDocx(edited))).canEdit).toBe(true);
  });

  it("keeps non-rule VML pictures read-only", async () => {
    const bytes = await fixture('<w:p><w:r><w:pict><v:rect style="width:100pt;height:50pt"/></w:pict></w:r></w:p>');
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "unsupported-markup")).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("supports multi-level numbering with per-level counters that restart under a new parent", async () => {
    const item = (level: number, text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const bytes = await fixture(item(0, "A") + item(1, "A1") + item(1, "A2") + item(0, "B") + item(1, "B1"), { numbering: true });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(doc.paragraphs.map((p) => [p.listKind, p.listLevel, p.listNumber])).toEqual([
      ["numbered", 0, 1], ["numbered", 1, 1], ["numbered", 1, 2], ["numbered", 0, 2], ["numbered", 1, 1],
    ]);
    const edited = replaceDocxText(doc, [{ runId: doc.paragraphs[1].runs[0].id, text: "A-one" }]);
    const reopened = await openDocx(await exportDocx(edited));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.text).toBe("A\nA-one\nA2\nB\nB1");
  });

  it("fails closed when a paragraph references a numbering level that does not exist", async () => {
    const item = (level: number, text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const bytes = await fixture(item(0, "A") + item(2, "Too deep"), { numbering: true });
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(false);
    expect(doc.diagnostics.some((d) => d.code === "unsupported-numbering")).toBe(true);
    expect(await exportDocx(doc)).toEqual(bytes);
  });

  it("opens a combined generator-shaped document as editable", async () => {
    const item = (level: number, text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const bytes = await fixture(
      '<w:p><w:bookmarkStart w:id="1" w:name="title"/><w:r><w:t>Title</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>'
      + `<w:p><w:r>${HR_PICT}</w:r></w:p>` + item(0, "One") + item(1, "Sub"),
      { numbering: true, notes: "separator" },
    );
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    const cleared = applyDocxOperations(doc, [{ type: "set-list", paragraphId: doc.paragraphs[2].id, kind: null }]);
    expect((await openDocx(await exportDocx(cleared))).paragraphs[2].listKind).toBeUndefined();
  });
});
