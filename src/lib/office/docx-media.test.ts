import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { applyDocxOperations, createDocx, exportDocx, getDocxImageBytes, openDocx } from "./docx";
import { inspectDocxBitmap } from "./docx-media";
import { readZip, writeZip, zipCrc32 } from "./zip";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function png(width = 1, height = 1): Uint8Array {
  const chunk = (name: string, data: Uint8Array) => {
    const output = new Uint8Array(data.length + 12);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length);
    output.set(encoder.encode(name), 4);
    output.set(data, 8);
    view.setUint32(8 + data.length, zipCrc32(output.subarray(4, 8 + data.length)));
    return output;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  // Original 1x1 red RGBA fixture (one zero filter byte + four sample bytes).
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 255]))), ...chunk("IEND", new Uint8Array())]);
}

describe("original bounded DOCX inline raster media", () => {
  it("inserts real local DrawingML/OPC image parts and reopens exact owned image bytes", async () => {
    const original = await createDocx("Before\nAfter");
    const bytes = png();
    const doc = applyDocxOperations(original, [{ type: "insert-image", afterParagraphId: "p0", bytes, contentType: "image/png", widthPoints: 120, heightPoints: 80, altText: 'Red <&> "pixel"' }]);
    bytes.fill(0);
    expect(doc.blocks).toHaveLength(3);
    expect(doc.images[0]).toMatchObject({ widthPoints: 120, heightPoints: 80, altText: 'Red <&> "pixel"', contentType: "image/png" });
    expect(getDocxImageBytes(doc, doc.images[0].id)).toEqual(png());
    const copy = getDocxImageBytes(doc, doc.images[0].id); copy.fill(0);
    expect(getDocxImageBytes(doc, doc.images[0].id)).toEqual(png());
    const reopened = await openDocx(await exportDocx(doc));
    expect(reopened.canEdit).toBe(true);
    expect(reopened.images).toHaveLength(1);
    expect(getDocxImageBytes(reopened, reopened.images[0].id)).toEqual(png());
    expect(original.images).toHaveLength(0);
  });

  it("deletes image payloads/relationships/overrides and prevents hidden deleted-image data", async () => {
    const doc = applyDocxOperations(await createDocx("A"), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    const paragraphId = doc.images[0].paragraphId;
    expect(() => applyDocxOperations(doc, [{ type: "replace-paragraph", paragraphId, text: "Removed?" }])).toThrow(/explicitly/);
    expect(() => applyDocxOperations(doc, [{ type: "delete-paragraph", paragraphId }])).toThrow(/explicitly/);
    const deleted = applyDocxOperations(doc, [{ type: "delete-image", imageId: doc.images[0].id }]);
    const bytes = await exportDocx(deleted);
    const parts = await readZip(bytes);
    expect(parts.some((p) => p.name.includes("/media/"))).toBe(false);
    expect(decoder.decode(parts.find((p) => p.name === "[Content_Types].xml")!.data)).not.toContain("image/png");
    expect(decoder.decode(parts.find((p) => p.name === "word/_rels/document.xml.rels")!.data)).not.toContain("/image\"");
    expect((await openDocx(bytes)).images).toHaveLength(0);
    expect(getDocxImageBytes(doc, doc.images[0].id)).toEqual(png()); // Undo snapshot still owns original.
    const insertedAgain = applyDocxOperations(deleted, [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    expect(insertedAgain.images[0].id).not.toBe(doc.images[0].id);
    expect((await openDocx(await exportDocx(insertedAgain))).images).toHaveLength(1);
  });

  it("retains media exactness while formatting unrelated text/page properties", async () => {
    const doc = applyDocxOperations(await createDocx("A"), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }, { type: "format-run", runId: "p0:r0", style: { bold: true } }, { type: "set-page-layout", layout: { orientation: "landscape" } }]);
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.paragraphs[0].runs[0].style.bold).toBe(true);
    expect(getDocxImageBytes(saved, saved.images[0].id)).toEqual(png());
  });

  it("deletes only the selected drawing when its run also contains ordinary text", async () => {
    const original = applyDocxOperations(await createDocx("A"), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    const parts = await readZip(await exportDocx(original));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encoder.encode(decoder.decode(main.data).replace("<w:drawing>", "<w:t>KEEP TEXT</w:t><w:drawing>"));
    const doc = await openDocx(writeZip(parts));
    expect(doc.canEdit).toBe(true);
    expect(doc.text).toContain("KEEP TEXT");
    const deleted = applyDocxOperations(doc, [{ type: "delete-image", imageId: doc.images[0].id }]);
    const saved = await openDocx(await exportDocx(deleted));
    expect(saved.text).toContain("KEEP TEXT");
    expect(saved.images).toHaveLength(0);
  });

  it("rejects forged/oversized/truncated raster structure and corrupt CRC", () => {
    expect(inspectDocxBitmap(png(), "image/png")).toEqual({ width: 1, height: 1 });
    const corrupt = png(); corrupt[20] ^= 1;
    for (const bytes of [new Uint8Array(16), png().slice(0, -2), corrupt, png(20000, 20000)]) expect(() => inspectDocxBitmap(bytes, "image/png")).toThrow();
    expect(() => inspectDocxBitmap(png(), "image/jpeg")).toThrow(/JPEG/);
    expect(() => inspectDocxBitmap(new Uint8Array(9 * 1024 * 1024), "image/png")).toThrow(/byte/);
  });

  it("fails closed for unsupported effects/linked images and preserves original bytes", async () => {
    const doc = applyDocxOperations(await createDocx("A"), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    const parts = await readZip(await exportDocx(doc));
    const main = parts.find((p) => p.name === "word/document.xml")!;
    main.data = encoder.encode(decoder.decode(main.data).replace('prst="rect"', 'prst="ellipse"'));
    const bytes = writeZip(parts);
    const readonly = await openDocx(bytes);
    expect(readonly.canEdit).toBe(false);
    expect(readonly.diagnostics.some((d) => d.code === "unsupported-image")).toBe(true);
    expect(await exportDocx(readonly)).toEqual(bytes);
  });

  it("refuses deletion when an unused main-part alias still owns the same image bytes", async () => {
    const original = applyDocxOperations(await createDocx("A"), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    const parts = await readZip(await exportDocx(original));
    const rels = parts.find((p) => p.name === "word/_rels/document.xml.rels")!;
    rels.data = encoder.encode(decoder.decode(rels.data).replace("</Relationships>", '<Relationship Id="unusedImageAlias" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/markie-image1.png"/></Relationships>'));
    const bytes = writeZip(parts);
    const doc = await openDocx(bytes);
    expect(doc.canEdit).toBe(true);
    expect(() => applyDocxOperations(doc, [{ type: "delete-image", imageId: doc.images[0].id }])).toThrow(/another package owner/);
    expect(await exportDocx(doc)).toEqual(bytes);
    expect(getDocxImageBytes(doc, doc.images[0].id)).toEqual(png());
  });

  it("declares main relationship parts for image insertion into override-only OPC manifests", async () => {
    const parts = await readZip(await exportDocx(await createDocx("Original")));
    const manifest = parts.find((p) => p.name === "[Content_Types].xml")!;
    manifest.data = encoder.encode(decoder.decode(manifest.data).replace(/<Default Extension="rels"[^>]*\/>/, '<Override PartName="/_rels/.rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'));
    const bytes = writeZip(parts);
    const original = await openDocx(bytes);
    const doc = applyDocxOperations(original, [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 72, heightPoints: 72 }]);
    const saved = await openDocx(await exportDocx(doc));
    expect(saved.canEdit).toBe(true); expect(saved.images).toHaveLength(1);
    expect(await exportDocx(original)).toEqual(bytes);
  });
});
