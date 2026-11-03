import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { createDocumentExporter, suggestedName, FORMATS, MAX_EXPORT_BYTES } = load("./export-document.js");

function exporter(filePath: string | null) {
  const showSaveDialog = vi.fn(async () => (filePath ? { canceled: false, filePath } : { canceled: true }));
  const writeFile = vi.fn();
  const run = createDocumentExporter({ dialog: { showSaveDialog }, getWindow: () => "window", writeFile });
  return { run, showSaveDialog, writeFile };
}

describe("export-document", () => {
  it("asks where through the save sheet with that format's filter, then writes the bytes", async () => {
    const { run, showSaveDialog, writeFile } = exporter("/Users/k/Plan");
    const data = new Uint8Array([80, 75, 3, 4]);
    expect(await run({ format: "docx", defaultName: "Plan.docx", data })).toEqual({ success: true, path: "/Users/k/Plan.docx" });
    expect(showSaveDialog).toHaveBeenCalledWith("window", { defaultPath: "Plan.docx", filters: [{ name: "Word Document", extensions: ["docx"] }] });
    expect(writeFile).toHaveBeenCalledOnce();
    const [target, written] = writeFile.mock.calls[0];
    expect(target).toBe("/Users/k/Plan.docx");
    expect([...written]).toEqual([80, 75, 3, 4]);
  });

  it("writes nothing when the sheet is cancelled", async () => {
    const { run, writeFile } = exporter(null);
    expect(await run({ format: "rtf", defaultName: "a.rtf", data: new Uint8Array([1]) })).toEqual({ success: false, canceled: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("keeps an extension the user typed in any case", async () => {
    const { run } = exporter("/tmp/Notes.ODT");
    expect((await run({ format: "odt", defaultName: "Notes.odt", data: new Uint8Array([1]) })).path).toBe("/tmp/Notes.ODT");
  });

  it("refuses formats, payloads and sizes it does not know, before any sheet opens", async () => {
    const { run, showSaveDialog } = exporter("/tmp/x");
    await expect(run({ format: "exe", defaultName: "x", data: new Uint8Array([1]) })).rejects.toThrow("cannot export");
    await expect(run({ format: "docx", defaultName: "x", data: "text" })).rejects.toThrow();
    await expect(run({ format: "docx", defaultName: "x", data: new Uint8Array(MAX_EXPORT_BYTES + 1) })).rejects.toThrow("too large");
    await expect(run(null)).rejects.toThrow();
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("suggests a name, never a path", () => {
    expect(suggestedName("../../etc/passwd", FORMATS.txt)).toBe("passwd.txt");
    expect(suggestedName("", FORMATS.md)).toBe("document.md");
    expect(suggestedName("Plan.md", FORMATS.md)).toBe("Plan.md");
  });

  it("knows the same formats the renderer offers", async () => {
    const { EXPORT_FORMATS } = await import("../src/lib/export-formats");
    expect(Object.keys(FORMATS).sort()).toEqual(EXPORT_FORMATS.map((f: { id: string }) => f.id).sort());
    for (const format of EXPORT_FORMATS) expect(FORMATS[format.id].extension).toBe(format.extension);
  });
});
