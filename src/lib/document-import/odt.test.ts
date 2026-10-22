import { describe, expect, it } from "vitest";
import { writeZip } from "../office/zip";
import { extractOdtText } from "./odt";
import { DocumentImportError, resolveDocumentImportLimits } from "./types";

const encoder = new TextEncoder();
const MIME = "application/vnd.oasis.opendocument.text";
const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0", TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0", MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
/** Synthetic package from OASIS ODF1.3 Parts2/3, our stored ZIP writer only. */
export function makeOdtFixture(body = "<text:p>Hello</text:p>", options: { mime?: string; office?: string; textNamespace?: string; version?: string; manifestExtra?: string; manifest?: string; content?: string; extra?: { name: string; data: Uint8Array }[] } = {}) {
  const manifest = options.manifest ?? `<manifest:manifest xmlns:manifest="${MANIFEST}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>${options.manifestExtra ?? ""}</manifest:manifest>`;
  const content = options.content ?? `<office:document-content xmlns:office="${options.office ?? OFFICE}" xmlns:text="${options.textNamespace ?? TEXT}" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="${options.version ?? "1.3"}"><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  return writeZip([{ name: "mimetype", data: encoder.encode(options.mime ?? MIME) }, { name: "META-INF/manifest.xml", data: encoder.encode(manifest) }, { name: "content.xml", data: encoder.encode(content) }, ...options.extra ?? []]);
}
const extract = (bytes: Uint8Array) => extractOdtText(bytes, resolveDocumentImportLimits());

describe("original bounded OpenDocument main-body text conversion", () => {
  it("keeps mixed XML text order, headings, entities, tabs, breaks and explicit spaces", async () => {
    const result = await extract(makeOdtFixture('<text:h>Title</text:h><text:p>Before <text:span>bold</text:span> after &amp;<text:s text:c="3"/>gap<text:tab/>tab<text:line-break/>line</text:p>'));
    expect(result.text).toBe("Title\nBefore bold after &   gap\ttab\nline"); expect(result.warnings.join(" ")).toContain("new plain-text copy");
  });
  it("excludes tracked deleted text, comments, notes, scripts, foreign/hidden content and links", async () => {
    const result = await extract(makeOdtFixture('<text:tracked-changes><text:changed-region><text:deletion><text:p>deleted secret</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p>Keep<office:annotation><text:p>private comment</text:p></office:annotation><text:note><text:p>note secret</text:p></text:note><text:hidden-text>hidden</text:hidden-text><text:script>script</text:script><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://invalid.example/private"> link label</text:a><foreign xmlns="urn:foreign"><text:p>foreign secret</text:p></foreign></text:p>'));
    expect(result.text).toBe("Keep link label"); expect(result.warnings.join(" ")).toContain("excluded");
  });
  it("handles CDATA and comments between mixed-order spans", async () => {
    expect((await extract(makeOdtFixture('<text:p>A<![CDATA[ <B> ]]><text:span>C</text:span><!-- ignored -->D</text:p>'))).text).toBe("A <B> CD");
  });
  it("excludes explicitly hidden/conditional sections and hidden variable fields", async () => {
    const result = await extract(makeOdtFixture('<text:section text:display="none"><text:p>hidden section</text:p></text:section><text:section text:display="condition"><text:p>conditional section</text:p></text:section><text:section text:condition="true()"><text:p>unevaluated section</text:p></text:section><text:section text:display="true"><text:p>Shown<text:variable-set text:display="none">hidden field</text:variable-set> tail</text:p></text:section>'));
    expect(result.text).toBe("Shown tail");
  });
  it("rejects wrong mimetype/root namespace, missing content contract and unsupported versions", async () => {
    for (const source of [makeOdtFixture(undefined, { mime: "application/zip" }), makeOdtFixture(undefined, { office: "urn:wrong" }), makeOdtFixture(undefined, { version: "1.4" }), makeOdtFixture(undefined, { manifest: `<manifest xmlns="urn:wrong"/>` }), makeOdtFixture(undefined, { content: `<office:document-content xmlns:office="${OFFICE}" office:version="1.3"/>` })]) await expect(extract(source)).rejects.toBeInstanceOf(DocumentImportError);
    const reordered = writeZip([{ name: "content.xml", data: encoder.encode("x") }, { name: "mimetype", data: encoder.encode(MIME) }]); await expect(extract(reordered)).rejects.toBeInstanceOf(DocumentImportError);
  });
  it("rejects encrypted manifest data, DTD/entity expansion, corrupt ZIP bytes and unsafe parts", async () => {
    const encrypted = makeOdtFixture(undefined, { manifestExtra: '<manifest:file-entry manifest:full-path="secret"><manifest:encryption-data/></manifest:file-entry>' });
    await expect(extract(encrypted)).rejects.toMatchObject({ code: "encrypted" });
    await expect(extract(makeOdtFixture(undefined, { content: '<!DOCTYPE x [<!ENTITY external SYSTEM "https://invalid.example/entity">]><x>&external;</x>' }))).rejects.toMatchObject({ code: "malformed" });
    const corrupt = makeOdtFixture(); corrupt[40] ^= 255; await expect(extract(corrupt)).rejects.toBeInstanceOf(DocumentImportError);
    expect(() => makeOdtFixture(undefined, { extra: [{ name: "../escape", data: encoder.encode("x") }] })).toThrow();
  });
  it("bounds archive/XML structure, expansion, repeated spaces and text", async () => {
    const source = makeOdtFixture('<text:p>12345<text:s text:c="9999999999"/></text:p>'); await expect(extract(source)).rejects.toMatchObject({ code: "limit-exceeded" });
    const simple = makeOdtFixture();
    for (const overrides of [{ maxArchiveEntries: 2 }, { maxExpandedBytes: 10 }, { maxDepth: 2 }, { maxNodes: 2 }, { maxTextCodeUnits: 3 }]) await expect(extractOdtText(simple, resolveDocumentImportLimits(overrides))).rejects.toMatchObject({ code: "limit-exceeded" });
  });
});
