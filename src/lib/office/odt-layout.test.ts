import { describe, expect, it } from "vitest";
import { applyOdtOperations, createOdt, exportOdt, openOdt } from "./odt";
import { ODT_FIXTURE_CONTENT, ODT_FIXTURE_STYLES, odtFixture } from "./odt.fixture";
import { readZip, writeZip } from "./zip";

const decoder = new TextDecoder(), encoder = new TextEncoder();
const properties = '<style:page-layout-properties fo:page-width="21cm" fo:page-height="297mm" style:print-orientation="portrait" fo:margin="1in" fo:margin-left="36pt"/>';
const layout = `<style:page-layout style:name="Paper" style:page-usage="all">${properties}</style:page-layout>`;
const master = '<style:master-page style:name="Standard" style:display-name="Plain paper" style:page-layout-name="Paper"/>';
function pageStyles(automatic = layout, pages = master) {
  return ODT_FIXTURE_STYLES.replace('</office:document-styles>', `<office:automatic-styles>${automatic}</office:automatic-styles><office:master-styles>${pages}</office:master-styles></office:document-styles>`);
}
async function parts(bytes: Uint8Array) { return new Map((await readZip(bytes)).map(e => [e.name, e.data])); }

describe("original ODT single-master page geometry", () => {
  it("reads physical units, margin shorthand/overrides and the one referenced master", async () => {
    const doc = await openOdt(odtFixture({ styles: pageStyles() }));
    expect(doc.canEdit).toBe(true);
    expect(doc.pageLayout.widthPoints).toBeCloseTo(595.27559);
    expect(doc.pageLayout.heightPoints).toBeCloseTo(841.88976);
    expect(doc.pageLayout).toMatchObject({ orientation: "portrait", marginTopPoints: 72, marginRightPoints: 72, marginBottomPoints: 72, marginLeftPoints: 36 });
  });
  it("keeps unchanged ODT exact and body edits leave styles and other parts byte-identical", async () => {
    const bytes = odtFixture({ styles: pageStyles() }), original = await parts(bytes), doc = await openOdt(bytes);
    expect(await exportOdt(doc)).toEqual(bytes);
    const edited = applyOdtOperations(doc, [{ type: "replace-paragraph", paragraphId: doc.paragraphs[0].id, text: "Page geometry is retained" }]);
    const output = await exportOdt(edited), nextParts = await parts(output), next = await openOdt(output);
    expect(next.pageLayout).toEqual(doc.pageLayout);
    expect(next.text).toBe(edited.text);
    for (const [name, data] of original) if (name !== "content.xml") expect(nextParts.get(name)).toEqual(data);
  });
  it("changes only the exact page properties for layout-only edits and reopens the same format", async () => {
    const bytes = odtFixture({ styles: pageStyles() }), original = await parts(bytes), doc = await openOdt(bytes);
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { paper: "legal", orientation: "landscape", marginTopPoints: 24, marginRightPoints: 48 } }]);
    const output = await exportOdt(edited), nextParts = await parts(output), next = await openOdt(output);
    expect(next.format).toBe("odt"); expect(next.pageLayout).toEqual(edited.pageLayout);
    expect(next.pageLayout).toMatchObject({ widthPoints: 1008, heightPoints: 612, orientation: "landscape", marginTopPoints: 24, marginRightPoints: 48, marginLeftPoints: 36 });
    for (const [name, data] of original) if (name !== "styles.xml") expect(nextParts.get(name)).toEqual(data);
    const styles = decoder.decode(nextParts.get("styles.xml"));
    expect(styles.slice(0, styles.indexOf('<style:page-layout-properties'))).toBe(pageStyles().slice(0, pageStyles().indexOf(properties)));
    expect(styles.slice(styles.indexOf('/>', styles.indexOf('<style:page-layout-properties')) + 2)).toBe(pageStyles().slice(pageStyles().indexOf(properties) + properties.length));
    expect(await exportOdt(doc)).toEqual(bytes);
  });
  it("persists sequential geometry and body edits without source-lineage changes", async () => {
    const doc = await openOdt(odtFixture({ styles: pageStyles() }));
    const landscape = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { orientation: "landscape" } }]);
    const edited = applyOdtOperations(landscape, [{ type: "format-run", runId: doc.paragraphs[0].runs[0].id, style: { italic: true } }, { type: "set-page-layout", layout: { paper: "letter", orientation: "portrait", marginBottomPoints: 0 } }]);
    const next = await openOdt(await exportOdt(edited));
    expect(next.pageLayout).toEqual(edited.pageLayout);
    expect(next.paragraphs[0].runs[0].style.italic).toBe(true);
    expect(landscape.pageLayout.orientation).toBe("landscape"); expect(doc.pageLayout.orientation).toBe("portrait");
  });
  it.each(["Body", "Centered"])("rejects a mid-body paragraph selecting the same master through %s", async style => {
    const styles = pageStyles().replace('style:name="Body"', 'style:name="Body" style:master-page-name="Standard"');
    const content = ODT_FIXTURE_CONTENT.replace('text:style-name="Centered"', '').replace('<text:p>Unicode:', `<text:p text:style-name="${style}">Unicode:`);
    // ODF master-page-name forces a page break even when selecting the same
    // master. The current paragraph model cannot preserve that boundary.
    await expect(openOdt(odtFixture({ styles, content }))).rejects.toThrow("master-page");
  });
  it("rejects master-page references on first-paragraph and unused styles conservatively", async () => {
    const styles = pageStyles().replace('style:name="Body"', 'style:name="Body" style:master-page-name="Standard"');
    await expect(openOdt(odtFixture({ styles }))).rejects.toThrow("master-page");
    const content = ODT_FIXTURE_CONTENT.replace('text:style-name="Centered"', '');
    await expect(openOdt(odtFixture({ styles, content }))).rejects.toThrow("master-page");
  });
  it("creates geometry in styles.xml for new ODT, with manifest and no DOCX parts", async () => {
    const doc = await createOdt("New document"), original = await parts(await exportOdt(doc));
    expect(decoder.decode(original.get("styles.xml"))).toContain('style:master-page');
    expect(decoder.decode(original.get("META-INF/manifest.xml"))).toContain('manifest:full-path="styles.xml"');
    expect([...original.keys()].some(k => k.startsWith("word/"))).toBe(false);
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { paper: "a4", orientation: "landscape" } }]);
    expect((await openOdt(await exportOdt(edited))).pageLayout).toEqual(edited.pageLayout);
  });
  it.each(["no containers", "automatic", "master", "both"])("adds geometry to legacy styles with %s", async kind => {
    const extra = `${["automatic", "both"].includes(kind) ? '<office:automatic-styles/>' : ''}${["master", "both"].includes(kind) ? '<office:master-styles/>' : ''}`;
    const styles = ODT_FIXTURE_STYLES.replace('</office:document-styles>', extra + '</office:document-styles>');
    const bytes = odtFixture({ styles }), doc = await openOdt(bytes), original = await parts(bytes);
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { paper: "a4", marginTopPoints: 0 } }]);
    const output = await exportOdt(edited), restored = await openOdt(output), after = await parts(output);
    expect(restored.pageLayout).toEqual(edited.pageLayout);
    expect(after.get("content.xml")).toEqual(original.get("content.xml"));
  });
  it("adds declared geometry to a legacy minimal package without a styles.xml part", async () => {
    const bytes = await exportOdt(await createOdt("Minimal"));
    const entries = (await readZip(bytes)).filter(e => e.name !== "styles.xml").map(e => e.name === "META-INF/manifest.xml" ? { ...e, data: encoder.encode(decoder.decode(e.data).replace(/<manifest:file-entry manifest:full-path="styles.xml"[^]*?\/>/, '')) } : e);
    const doc = await openOdt(writeZip(entries));
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { paper: "legal", marginLeftPoints: 0 } }]);
    expect((await openOdt(await exportOdt(edited))).pageLayout).toEqual(edited.pageLayout);
  });
  it("handles arbitrary source namespace prefixes in layout/master definitions", async () => {
    const styles = pageStyles().replace(/(<\/?| )style:/g, "$1z:").replace('xmlns:style=', 'xmlns:z=');
    const doc = await openOdt(odtFixture({ styles }));
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { marginLeftPoints: 42 } }]);
    expect((await openOdt(await exportOdt(edited))).pageLayout).toEqual(edited.pageLayout);
  });
  it.each([
    ['multiple masters', layout, master + master.replace('Standard', 'Other')],
    ['multiple layouts', layout + layout.replace('Paper', 'Other'), master],
    ['missing master', layout, ''], ['missing layout', '', master],
    ['missing reference', layout, master.replace('page-layout-name="Paper"', 'page-layout-name="Missing"')],
    ['header', layout, master.replace('/>', '><style:header/></style:master-page>')],
    ['footer', layout, master.replace('/>', '><style:footer/></style:master-page>')],
    ['conditional next master', layout, master.replace('/>', ' style:next-style-name="Other"/>')],
    ['mirrored usage', layout.replace('page-usage="all"', 'page-usage="mirrored"'), master],
    ['columns', layout.replace('/>', '><style:columns/></style:page-layout-properties>'), master],
    ['background', layout.replace('fo:margin="1in"', 'fo:background-color="#ffffff" fo:margin="1in"'), master],
    ['percentage width', layout.replace('21cm', '100%'), master],
    ['unknown orientation', layout.replace('portrait', 'diagonal'), master],
    ['inconsistent orientation', layout.replace('portrait', 'landscape'), master],
    ['too-large paper', layout.replace('21cm', '3000pt'), master],
    ['no text area', layout.replace('fo:margin="1in"', 'fo:margin="10in"'), master],
    ['negative margins', layout.replace('36pt', '-1pt'), master],
  ])("rejects unrepresented %s rather than flattening it", async (_name, automatic, pages) => {
    await expect(openOdt(odtFixture({ styles: pageStyles(automatic, pages) }))).rejects.toThrow("page layout");
  });
  it("rejects a paragraph switching to another master, including unused styles", async () => {
    const styles = pageStyles().replace('style:name="Body"', 'style:name="Body" style:master-page-name="Other"');
    await expect(openOdt(odtFixture({ styles }))).rejects.toThrow("master-page switch");
  });
  it("rejects page-layout definitions in content.xml rather than guessing precedence", async () => {
    const content = ODT_FIXTURE_CONTENT.replace('<office:automatic-styles>', `<office:automatic-styles>${layout}`);
    await expect(openOdt(odtFixture({ content, styles: pageStyles() }))).rejects.toThrow("page layout");
  });
  it("leaves the immutable original exact when a mixed batch contains invalid geometry", async () => {
    const bytes = odtFixture({ styles: pageStyles() }), doc = await openOdt(bytes);
    expect(() => applyOdtOperations(doc, [{ type: "replace-paragraph", paragraphId: doc.paragraphs[0].id, text: "Must not persist" }, { type: "set-page-layout", layout: { marginTopPoints: Infinity } }])).toThrow();
    expect(await exportOdt(doc)).toEqual(bytes);
    expect(doc.modified).toBe(false);
  });
  it("keeps no-op geometry commands and a reverted layout byte neutral", async () => {
    const bytes = odtFixture({ styles: pageStyles() }), doc = await openOdt(bytes);
    const noop = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { marginLeftPoints: 36 } }]);
    expect(await exportOdt(noop)).toEqual(bytes);
    const reverted = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { marginLeftPoints: 42 } }, { type: "set-page-layout", layout: { marginLeftPoints: 36 } }]);
    expect(await exportOdt(reverted)).toEqual(bytes);
  });
  it("does not rebase text-family defaults or rewrite body styles during layout-only edits", async () => {
    const styles = pageStyles().replace('<office:styles>', '<office:styles><style:default-style style:family="text"><style:text-properties fo:font-style="italic"/></style:default-style>');
    const bytes = odtFixture({ styles }), doc = await openOdt(bytes), before = await parts(bytes);
    const edited = applyOdtOperations(doc, [{ type: "set-page-layout", layout: { paper: "legal" } }]);
    expect(edited.paragraphs).toEqual(doc.paragraphs);
    const after = await parts(await exportOdt(edited));
    expect(after.get("content.xml")).toEqual(before.get("content.xml"));
  });
});
