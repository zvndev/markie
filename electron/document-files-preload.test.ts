import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
describe("native document preload IPC mapping", () => {
  it("exposes only lease methods, forwards close tickets, and cleans the OS-event subscription", async () => {
    const calls: unknown[][] = [], listeners = new Map<string, (...args: unknown[]) => void>(); let api: Record<string, unknown> = {};
    runInNewContext(readFileSync(new URL("./preload.js", import.meta.url), "utf8"), { process: { platform: "linux" }, require(name: string) {
      if (name !== "electron") throw new Error("unexpected preload dependency");
      return { contextBridge: { exposeInMainWorld(_name: string, exposed: Record<string, unknown>) { api = exposed; } }, webUtils: {}, ipcRenderer: { invoke(channel: string, args?: unknown) { calls.push([channel, args]); return Promise.resolve({ ok: true, value: null }); }, send(channel: string, args?: unknown) { calls.push([channel, args]); }, on(channel: string, callback: (...args: unknown[]) => void) { listeners.set(channel, callback); }, removeListener(channel: string) { listeners.delete(channel); } } };
    } });
    const files = api.documentFiles as { open(): Promise<unknown>; saveAs(args: unknown): Promise<unknown>; read(args: unknown): Promise<unknown>; write(args: unknown): Promise<unknown>; release(args: unknown): Promise<unknown>; takeInitial(): Promise<unknown> };
    await files.open(); await files.saveAs({ suggestedName: "copy.docx" }); await files.read({ leaseId: "opaque" }); await files.write({ leaseId: "opaque", baseRevision: null, bytes: new Uint8Array([1]) }); await files.release({ leaseId: "opaque" }); await files.takeInitial();
    expect(calls.map((call) => call[0])).toEqual(["document-files:open", "document-files:save-as", "document-files:read", "document-files:write", "document-files:release", "document-files:take-initial"]);
    let notified = 0; const cleanup = (api.onDocumentFileOpened as (callback: () => void) => () => void)(() => notified++); listeners.get("document-file-opened")!({}); expect(notified).toBe(1); cleanup(); expect(listeners.has("document-file-opened")).toBe(false);
    let ticket: number | undefined; (api.onAppWillClose as (callback: (requestId?: number) => void) => void)((requestId) => { ticket = requestId; }); listeners.get("app-will-close")!({}, 42); expect(ticket).toBe(42);
    (api.appCloseReady as (ticket: number) => void)(42); (api.appCloseCancel as (ticket: number) => void)(43); expect(calls.slice(-2)).toEqual([["app-close-ready", 42], ["app-close-cancel", 43]]);
    let command: string | undefined;
    const offCommand = (api.onDocumentCommand as (callback: (command: string) => void) => () => void)((value) => { command = value; });
    listeners.get("document-command")!({}, "format-bold"); expect(command).toBe("format-bold");
    offCommand(); expect(listeners.has("document-command")).toBe(false);
    const menuState = { renderer: "word", enabledCommands: ["format-bold"] };
    await (api.setDocumentMenuState as (state: typeof menuState) => Promise<unknown>)(menuState);
    expect(calls.at(-1)).toEqual(["document-menu-state", menuState]);
  });
});
