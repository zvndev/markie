import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
});
