import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createDocumentFileService, DOCUMENT_EXTENSIONS } from "./document-files.cjs";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const dropFolders: string[] = [];
afterEach(() => { for (const folder of dropFolders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
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

describe("explicit native document drops through existing channels", () => {
  function dropBridge(extension = "docx") {
    const folder = mkdtempSync(path.join(os.tmpdir(), "markie-drop-main-")); dropFolders.push(folder);
    const target = path.join(folder, `source.${extension}`); writeFileSync(target, new Uint8Array([80, 75, 3, 4, 0, 255]));
    const files = createDocumentFileService({ dialog: {} });
    const frame = { url: "app://markie/index.html" }, contents = { id: 17, mainFrame: frame, send: vi.fn() };
    const event = { sender: contents, senderFrame: frame, returnValue: undefined as boolean | undefined };
    const readFilePayload = vi.fn(() => ({ content: "legacy", path: target })), grantFile = vi.fn(() => ({ ok: true }));
    let open: (event: unknown, target: string) => Promise<unknown> = async () => undefined;
    let grant: (event: unknown, target: string) => void = () => undefined;
    const snippets = [
      source.slice(source.indexOf("function currentCloseSender("), source.indexOf('ipcMain.on("app-close-ready"')),
      source.slice(source.indexOf("function queueNativeDocumentOpen("), source.indexOf("// Deliver a markie:// deep link")),
      source.slice(source.indexOf('handle("open-file-path",'), source.indexOf("// Synchronous so preload", source.indexOf('handle("open-file-path",'))),
      source.slice(source.indexOf('ipcMain.on("grant-file-path",'), source.indexOf("// A file dragged onto a document", source.indexOf('ipcMain.on("grant-file-path",'))),
    ];
    runInNewContext(snippets.join("\n"), {
      mainWindow: { webContents: contents, isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn() },
      isAppUrl: (url: string) => url.startsWith("app://markie/"),
      documentFiles: files, OPENABLE: /\.(md|markdown|mdx|txt|text|log|csv)$/i,
      rendererReady: true, pendingNativeDocumentError: null, nativeDocumentQueued: false,
      handle: (_name: string, callback: typeof open) => { open = callback; },
      ipcMain: { on: (_name: string, callback: typeof grant) => { grant = callback; } },
      fileGrants: { grantFile }, readFilePayload, isAdvertisedPath: () => false,
    });
    return { target, files, event, frame, contents, readFilePayload, grantFile, open, grant };
  }

  it.each(["docx", "doc", "json", "yaml", "yml", "xml", "rtf", "html", "htm", "odt"])("opens explicitly dropped .%s through null + opaque native notification only", async (extension) => {
    const f = dropBridge(extension);
    expect(await f.open(f.event, f.target)).toBeNull(); expect(f.contents.send).not.toHaveBeenCalled();
    f.grant(f.event, f.target); expect(f.event.returnValue).toBe(true);
    expect(await f.open(f.event, f.target)).toBeNull(); expect(f.contents.send).toHaveBeenCalledExactlyOnceWith("document-file-opened");
    expect(f.readFilePayload).not.toHaveBeenCalled(); expect(f.grantFile).not.toHaveBeenCalled();
    const opened = await f.files.takeInitial(17); expect(opened).toMatchObject({ ok: true, value: { name: `source.${extension}` } });
    expect(JSON.stringify(opened)).not.toContain(path.dirname(f.target));
  });

  it("rejects foreign senders, subframes and non-app URLs without native grants or notifications", async () => {
    const f = dropBridge();
    for (const event of [
      { ...f.event, sender: { ...f.contents, id: 18 } },
      { ...f.event, senderFrame: { ...f.frame } },
    ]) {
      f.grant(event, f.target); expect(event.returnValue).toBe(false);
      expect(await f.open(event, f.target)).toBeNull();
    }
    f.frame.url = "https://untrusted.example/";
    f.grant(f.event, f.target); expect(f.event.returnValue).toBe(false); expect(await f.open(f.event, f.target)).toBeNull();
    expect(f.contents.send).not.toHaveBeenCalled(); expect(f.readFilePayload).not.toHaveBeenCalled();
    expect(await f.files.takeInitial(17)).toEqual({ ok: true, value: null });
  });

  it.each(["md", "markdown", "mdx", "txt", "text", "log", "csv"])("preserves .%s classic drop grants and text payloads", async (extension) => {
    const f = dropBridge(extension); f.grant(f.event, f.target); expect(f.event.returnValue).toBe(true);
    expect(f.grantFile).toHaveBeenCalledExactlyOnceWith(f.target);
    expect(await f.open(f.event, f.target)).toEqual({ content: "legacy", path: f.target });
    expect(f.readFilePayload).toHaveBeenCalledExactlyOnceWith(f.target, { grant: false });
    expect(f.contents.send).not.toHaveBeenCalled(); expect(await f.files.takeInitial(17)).toEqual({ ok: true, value: null });
  });

  it("rejects unsupported drops and revokes native drop authority on owner cleanup", async () => {
    const unsupported = dropBridge("pdf"); unsupported.grant(unsupported.event, unsupported.target);
    expect(unsupported.event.returnValue).toBe(false); expect(await unsupported.open(unsupported.event, unsupported.target)).toBeNull();
    expect(unsupported.contents.send).not.toHaveBeenCalled(); expect(unsupported.readFilePayload).not.toHaveBeenCalled();
    const f = dropBridge(); f.grant(f.event, f.target); f.files.releaseOwner(17);
    expect(await f.open(f.event, f.target)).toBeNull(); expect(f.contents.send).not.toHaveBeenCalled();
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
