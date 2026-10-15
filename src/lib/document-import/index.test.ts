// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { writeZip } from "../office/zip";
import { convertAdditionalDocument } from "./index";
const encode = (text: string) => new TextEncoder().encode(text);
function odt() {
  return writeZip([
    { name: "mimetype", data: encode("application/vnd.oasis.opendocument.text") },
    { name: "META-INF/manifest.xml", data: encode('<m:manifest xmlns:m="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><m:file-entry m:full-path="/" m:media-type="application/vnd.oasis.opendocument.text"/><m:file-entry m:full-path="content.xml" m:media-type="text/xml"/></m:manifest>') },
    { name: "content.xml", data: encode('<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" o:version="1.3"><o:body><o:text><t:p>Original text</t:p></o:text></o:body></o:document-content>') },
  ]);
}
describe("explicit new text-copy conversion dispatch", () => {
  it("never relabels or mutates HTML originals and returns editable UTF-8 copy bytes", async () => {
    const bytes = encode("<p>Original &amp; text</p>"), original = bytes.slice();
    const input = { name: "source.html", bytes, format: "html" as const }, converted = await convertAdditionalDocument(input);
    expect(converted).toMatchObject({ ok: true, kind: "converted-text-copy", sourceFormat: "html", name: "source converted.txt", text: "Original & text", canWriteOriginal: false });
    expect(bytes).toEqual(original); expect(input.name).toBe("source.html");
    if (converted.ok) { expect(converted.bytes).toEqual(encode(converted.text)); expect(converted.warnings.length).toBeGreaterThan(0); converted.bytes.fill(0); expect(bytes).toEqual(original); }
  });
  it("snapshots ODT input bytes, format and name before asynchronous conversion", async () => {
    const input = { name: "source.odt", bytes: odt(), format: "odt" as "odt" | "html" };
    const pending = convertAdditionalDocument(input); input.bytes.fill(0); input.name = "changed.html"; input.format = "html";
    expect(await pending).toMatchObject({ ok: true, sourceFormat: "odt", name: "source converted.txt", text: "Original text" });
  });
  it("removes unsafe document control characters only in the explicitly warned copy", async () => {
    const bytes = encode("<p>A&#1;B&#11;C</p>"), original = bytes.slice(), result = await convertAdditionalDocument({ name: "controls.html", bytes, format: "html" });
    expect(result).toMatchObject({ ok: true, text: "AB\nC" }); expect(bytes).toEqual(original);
    if (result.ok) expect(result.warnings.join(" ")).toContain("control characters");
  });
  it("returns typed failures for malformed/unsupported/platform cases without mutating sources", async () => {
    const bytes = encode("not a ZIP"), original = bytes.slice();
    expect(await convertAdditionalDocument({ name: "bad.odt", bytes, format: "odt" })).toMatchObject({ ok: false, error: { code: "malformed" } }); expect(bytes).toEqual(original);
    expect(await convertAdditionalDocument({ name: "bad.html", bytes: new Uint8Array([255]), format: "html" })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    vi.stubGlobal("document", undefined);
    try { expect(await convertAdditionalDocument({ name: "source.html", bytes: encode("<p>text</p>"), format: "html" })).toMatchObject({ ok: false, error: { code: "platform-unavailable" } }); }
    finally { vi.unstubAllGlobals(); }
  });
  it("enforces input/output/text/limit validation and never returns source-rich output names", async () => {
    const input = { name: "source.html", bytes: encode("<p>😀😀</p>"), format: "html" as const };
    for (const limits of [{ maxInputBytes: 2 }, { maxOutputBytes: 4 }, { maxTextCodeUnits: 2 }, { maxDepth: 0 }]) expect(await convertAdditionalDocument(input, limits)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    for (const name of ["source.html", "source.rtf", "source.odt", ".html"]) {
      const converted = await convertAdditionalDocument({ ...input, name }); expect(converted.ok).toBe(true); if (converted.ok) { expect(converted.name).toMatch(/ converted\.txt$/); expect(converted.name).not.toBe(name); }
    }
  });
});
