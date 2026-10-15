import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DOCUMENT_EXTENSIONS } from "./document-files.cjs";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
describe("native document main-process integration", () => {
  it("routes extra-format OS opens without replacing classic launch dispatch", () => {
    expect(source).toContain('require("./document-files.cjs")');
    expect(source).toContain("findOpenableLaunchFile(process.argv.slice(1))");
    expect(source).toContain("findNativeDocumentLaunchFile(process.argv.slice(1))");
    const second = source.slice(source.indexOf('app.on("second-instance"'), source.indexOf("app.whenReady().then", source.indexOf('app.on("second-instance"')));
    expect(second).toContain("findOpenableLaunchFile(argv)"); expect(second).toContain("findNativeDocumentLaunchFile(argv)");
    const mac = source.slice(source.indexOf('app.on("open-file"'));
    expect(mac).toContain("!OPENABLE.test(filePath)"); expect(mac).toContain("queueNativeDocumentOpen(filePath)"); expect(mac).toContain('mainWindow.webContents.send("file-opened", payload)');
  });
  it("checks exact window/main frame/application URL before issuing an IPC owner", () => {
    const gate = source.slice(source.indexOf("ownerForEvent:"), source.indexOf("// Export handlers", source.indexOf("ownerForEvent:")));
    expect(gate).toContain("event.sender !== mainWindow.webContents"); expect(gate).toContain("event.senderFrame !== mainWindow.webContents.mainFrame"); expect(gate).toContain("!isAppUrl(event.senderFrame.url)");
    expect(source).toContain('mainWindow.webContents.send("document-file-opened")');
  });
  it("revokes leases on renderer destruction, replacement and navigation", () => {
    const window = source.slice(source.indexOf("const nativeDocumentOwner"), source.indexOf('mainWindow.once("ready-to-show"'));
    expect(window).toContain('once("destroyed"'); expect(window).toContain('on("render-process-gone"'); expect(window).toContain('on("did-start-navigation"'); expect(window).toContain("documentFiles.releaseOwner(nativeDocumentOwner)");
  });
  it("protects integrated document recovery regardless of the shell query string", () => {
    const close = source.slice(source.indexOf("const closeFlusher = createCloseFlusher("), source.indexOf('mainWindow.on("close"'));
    expect(close).toContain("forceOnTimeout: () => false");
    expect(close).not.toContain("documentsWorkspaceActive()");
  });
});

describe("original Markie native Open dialog", () => {
  function openDialog(selected: string | null, queued = true) {
    let open: (event: unknown, args?: { near?: string }) => Promise<unknown> = async () => undefined;
    const showOpenDialog = vi.fn(async (_window: unknown, _options: unknown) => selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] });
    const readFilePayload = vi.fn(() => ({ name: "classic.md", content: "Markdown", path: selected }));
    const queueNativeDocumentOpen = vi.fn(() => queued);
    const start = source.indexOf('handle("open-file",');
    const end = source.indexOf("// IPC: Export PDF", start);
    runInNewContext(source.slice(start, end), {
      handle: (_channel: string, callback: typeof open) => { open = callback; },
      dialog: { showOpenDialog }, dialogStartDir: (near?: string) => near ? "/synthetic" : null,
      mainWindow: {}, DOCUMENT_EXTENSIONS, OPENABLE: /\.(md|markdown|mdx|txt|text|log|csv)$/i,
      readFilePayload, queueNativeDocumentOpen,
    });
    return { open, showOpenDialog, readFilePayload, queueNativeDocumentOpen };
  }

  it("offers all supported formats in the normal File > Open picker", async () => {
    const f = openDialog(null);
    await f.open({}, { near: "/synthetic/note.md" });
    const options = f.showOpenDialog.mock.calls[0][1] as unknown as { defaultPath: string; filters: { name: string; extensions: string[] }[] };
    expect(options.defaultPath).toBe("/synthetic");
    expect(options.filters[0]).toEqual({ name: "Documents", extensions: DOCUMENT_EXTENSIONS });
    expect(f.readFilePayload).not.toHaveBeenCalled(); expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled();
  });

  it.each(["doc", "docx", "json", "yaml", "yml", "xml", "rtf", "html", "htm", "odt"])("routes .%s from the original picker through opaque byte grants", async (extension) => {
    const target = `/synthetic/source.${extension}`, f = openDialog(target);
    expect(await f.open({})).toBeNull();
    expect(f.queueNativeDocumentOpen).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.readFilePayload).not.toHaveBeenCalled();
  });

  it.each(["md", "markdown", "mdx", "txt", "text", "log", "csv"])("keeps the existing .%s text-file path unchanged", async (extension) => {
    const target = `/synthetic/source.${extension}`, f = openDialog(target);
    expect(await f.open({})).toMatchObject({ content: "Markdown", path: target });
    expect(f.readFilePayload).toHaveBeenCalledExactlyOnceWith(target, { grant: true });
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled();
  });
});
