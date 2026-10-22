import { useState } from "react";
import { deflateSync } from "node:zlib";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWordImage } from "./word-images";
import { WordDocumentEditor } from "./word-document-editor";
import { applyDocxOperations, createDocx, exportDocx, getDocxImageBytes, openDocx, type DocxDocument } from "@/lib/office/docx";
import { zipCrc32 } from "@/lib/office/zip";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function png() {
  const chunk = (name: string, data: Uint8Array) => {
    const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(name), 4); bytes.set(data, 8);
    view.setUint32(data.length + 8, zipCrc32(bytes.subarray(4, data.length + 8))); return bytes;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 1); header[8] = 8; header[9] = 6;
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", header), ...chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 255]))), ...chunk("IEND", new Uint8Array())]);
}
function bitmapFile() { const bytes = png(); return { name: "pixel.png", size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }; }
describe("local Word pictures", () => {
  it("decodes pixels with the platform before returning bounded owned image bytes", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1, height: 1, close }));
    const image = await decodeWordImage(bitmapFile());
    expect(image).toMatchObject({ contentType: "image/png", widthPoints: .75, heightPoints: .75, altText: "pixel.png" });
    expect(Array.from(image.bytes)).toEqual(Array.from(png())); expect(close).toHaveBeenCalledOnce();
  });
  it("rejects SVG, oversized input and decoder failure without inserting anything", async () => {
    await expect(decodeWordImage({ name: "bad.svg", size: 6, arrayBuffer: async () => new TextEncoder().encode("<svg/>").buffer })).rejects.toThrow(/PNG and JPEG/);
    const read = vi.fn();
    await expect(decodeWordImage({ name: "large.png", size: 9 * 1024 * 1024, arrayBuffer: read })).rejects.toThrow(/8 MB/);
    expect(read).not.toHaveBeenCalled();
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("Invalid image data")));
    await expect(decodeWordImage(bitmapFile())).rejects.toThrow("Invalid image data");
  });
  it("inserts, displays, exports and explicitly deletes actual media parts", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1, height: 1, close: vi.fn() }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:local-picture") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    let latest = await createDocx("Picture below");
    function Host() {
      const [document, setDocument] = useState<DocxDocument>(latest);
      return <WordDocumentEditor document={document} onChange={(next) => { latest = next; setDocument(next); }} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Insert image" }));
    fireEvent.change(screen.getByLabelText("Insert local picture"), { target: { files: [bitmapFile()] } });
    expect(await screen.findByRole("img", { name: "pixel.png" })).toHaveAttribute("src", "blob:local-picture");
    const reopened = await openDocx(await exportDocx(latest));
    expect(reopened.images).toHaveLength(1);
    expect(Array.from(getDocxImageBytes(reopened, reopened.images[0].id))).toEqual(Array.from(png()));
    fireEvent.click(screen.getByRole("button", { name: "Select picture: pixel.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));
    await waitFor(() => expect(screen.queryByRole("img")).not.toBeInTheDocument());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-picture");
    expect((await openDocx(await exportDocx(latest))).images).toHaveLength(0);
  });
  it("shows semantic page breaks in image-only paragraphs and removes them from export", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:local-picture") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    let latest = applyDocxOperations(await createDocx(""), [{ type: "insert-image", bytes: png(), contentType: "image/png", widthPoints: 12, heightPoints: 12, altText: "Small picture" }]);
    latest = applyDocxOperations(latest, [{ type: "insert-page-break", paragraphId: latest.images[0].paragraphId, offset: 0 }]);
    latest = await openDocx(await exportDocx(latest));
    function Host() {
      const [document, setDocument] = useState<DocxDocument>(latest);
      return <WordDocumentEditor document={document} onChange={(next) => { latest = next; setDocument(next); }} />;
    }
    render(<Host />);
    expect(screen.getByRole("img", { name: "Small picture" })).toBeInTheDocument();
    const marker = screen.getByRole("separator", { name: "Page break" });
    const paragraph = marker.closest<HTMLElement>("[data-paragraph-id]")!;
    expect(paragraph).toHaveTextContent("");
    marker.remove(); fireEvent.input(paragraph);
    expect(screen.queryByRole("separator", { name: "Page break" })).not.toBeInTheDocument();
    const reopened = await openDocx(await exportDocx(latest));
    expect(reopened.pageBreaks).toHaveLength(0); expect(reopened.images).toHaveLength(1);
  });
});
