import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const load = createRequire(import.meta.url);
const { createDocumentMenuController, validMenuState, MARKDOWN_MENU_IDS, ZOOM_MENU_IDS } = load("./document-menu.js");
const commands: { id: string; group: string; label: string }[] = load("./document-menu-commands.json");
type Item = { id?: string; label?: string; type?: string; enabled?: boolean; accelerator?: string; click?: () => void; submenu?: Item[] };

function fixture() {
  const legacy = vi.fn(), sendCommand = vi.fn(), historyAllowed = vi.fn(() => false);
  let destroyed = false, webContentsDestroyed = false, present = true;
  const window = { isDestroyed: () => destroyed, webContents: { isDestroyed: () => webContentsDestroyed } };
  const items = new Map<string, Item>();
  const menu = { getMenuItemById: (id: string) => items.get(id) };
  const controller = createDocumentMenuController({ getWindow: () => present ? window : null, getMenu: () => menu, sendCommand, canUseLegacy: (id: string) => id !== "revert-to-snapshot" || historyAllowed() });
  const template: Item[] = [
    { label: "File", submenu: [...MARKDOWN_MENU_IDS.map((id: string) => ({ id, click: legacy })), { id: "revert-to-snapshot", label: "History…", click: legacy }, { type: "separator" }, { label: "Close" }] },
    { label: "Edit", submenu: [{ label: "Find", click: legacy }] },
    { label: "View", submenu: [...ZOOM_MENU_IDS.map((id: string) => ({ id, click: legacy })), { id: "markdown-zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0", click: legacy }] },
    { label: "Window", submenu: [] },
  ];
  controller.install(template);
  const index = (entries: Item[]) => { for (const item of entries) { if (item.id) items.set(item.id, item); if (item.submenu) index(item.submenu); } };
  index(template);
  controller.reset();
  return { controller, template, items, sendCommand, legacy, historyAllowed, destroy: () => { destroyed = true; }, destroyWebContents: () => { webContentsDestroyed = true; }, removeWindow: () => { present = false; } };
}

describe("native document menu capability boundary", () => {
  it("keeps the shared catalog unique and within the expected native menu groups", () => {
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
    for (const command of commands) {
      expect(["File", "Format", "Insert", "Layout", "Review", "View"]).toContain(command.group);
      expect(command.id).toMatch(/^[a-z][a-z0-9-]{1,63}$/); expect(command.label.length).toBeGreaterThan(0);
    }
  });

  it.each([null, [], {}, { renderer: "unknown", enabledCommands: [] }, { renderer: "word", enabledCommands: ["unknown-command"] }, { renderer: "word", enabledCommands: ["format-bold", "format-bold"] }, { renderer: "word", enabledCommands: [1] }, { renderer: "none", enabledCommands: ["format-bold"] }, { renderer: "word", enabledCommands: [], extra: true }, { renderer: "word", enabledCommands: new Array(1) }, { renderer: "word", enabledCommands: new Array(commands.length + 1).fill("format-bold") }])("rejects invalid or excessive capabilities (%j)", (state) => {
    expect(validMenuState(state)).toBe(false);
  });

  it("starts disabled, enables only reported IDs, and rechecks state at click time", () => {
    const f = fixture(), bold = f.items.get("format-bold")!, italic = f.items.get("format-italic")!;
    expect(bold.enabled).toBe(false); bold.click!(); expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.controller.update({ renderer: "word", enabledCommands: ["format-bold"] })).toEqual({ ok: true });
    expect(bold.enabled).toBe(true); expect(italic.enabled).toBe(false);
    bold.click!(); expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith("format-bold");
    f.controller.update({ renderer: "text", enabledCommands: ["document-details"] });
    bold.click!(); expect(f.sendCommand).toHaveBeenCalledOnce(); expect(bold.enabled).toBe(false);
    f.items.get("document-details")!.click!(); expect(f.sendCommand).toHaveBeenLastCalledWith("document-details");
  });

  it("allows shared Format capabilities in Markdown without enabling Word-only commands", () => {
    const f = fixture();
    f.controller.update({ renderer: "markdown", enabledCommands: ["format-bold", "format-font"] });
    expect(f.items.get("format-font")!.enabled).toBe(true); expect(f.items.get("layout-letter")!.enabled).toBe(false);
    expect(f.items.get("markdown-view-rich")!.enabled).toBe(true); expect(f.items.get("document-history")!.enabled).toBe(false);
    f.historyAllowed.mockReturnValue(true); f.controller.update({ renderer: "markdown", enabledCommands: [] });
    expect(f.items.get("document-history")!.enabled).toBe(true);
  });

  it("disables legacy Markdown-only paths in Word and guards stale legacy callbacks", () => {
    const f = fixture(), rich = f.items.get("markdown-view-rich")!;
    f.controller.update({ renderer: "markdown", enabledCommands: [] }); rich.click!(); expect(f.legacy).toHaveBeenCalledOnce();
    f.controller.update({ renderer: "word", enabledCommands: ["format-bold"] });
    for (const id of MARKDOWN_MENU_IDS) expect(f.items.get(id)!.enabled).toBe(false);
    rich.click!(); expect(f.legacy).toHaveBeenCalledOnce();
  });

  it("fails closed on bad trusted capability updates and resets stale enablement", () => {
    const f = fixture(); f.controller.update({ renderer: "word", enabledCommands: ["insert-picture"] });
    expect(f.controller.update({ renderer: "word", enabledCommands: ["not-in-catalog"] }).ok).toBe(false);
    expect(f.items.get("insert-picture")!.enabled).toBe(false);
    f.controller.update({ renderer: "word", enabledCommands: ["insert-picture"] }); f.controller.reset();
    f.items.get("insert-picture")!.click!(); expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it.each(["destroy", "destroyWebContents", "removeWindow"] as const)("never sends to an unavailable owning window (%s)", (action) => {
    const f = fixture(); f.controller.update({ renderer: "word", enabledCommands: ["insert-table"] });
    f[action](); f.items.get("insert-table")!.click!(); expect(f.sendCommand).not.toHaveBeenCalled();
  });

  it("adds native menus without replacing File/Edit/View or duplicating Actual Size", () => {
    const f = fixture();
    expect(f.template.map((item) => item.label)).toEqual(["File", "Edit", "Format", "Insert", "Layout", "Review", "View", "Window"]);
    expect(f.template[0].submenu!.at(-1)!.label).toBe("Close");
    expect(f.template.find((item) => item.label === "View")!.submenu!.filter((item) => item.label === "Actual Size")).toHaveLength(1);
    expect(f.items.get("view-zoom-reset")!.accelerator).toBe("CmdOrCtrl+0");
    f.controller.update({ renderer: "markdown", enabledCommands: [] }); f.items.get("view-zoom-reset")!.click!(); expect(f.legacy).toHaveBeenCalledOnce();
    f.controller.update({ renderer: "word", enabledCommands: ["view-zoom-reset"] }); f.items.get("view-zoom-reset")!.click!(); expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith("view-zoom-reset");
  });

  it("reuses File History for classic snapshots and current Word document history", () => {
    const f = fixture(), history = f.items.get("document-history")!;
    expect(f.template[0].submenu!.filter((item) => item.label === "History…")).toHaveLength(1);
    expect(f.items.has("revert-to-snapshot")).toBe(false);
    f.controller.update({ renderer: "markdown", enabledCommands: [] }); history.click!(); expect(f.legacy).not.toHaveBeenCalled();
    f.controller.update({ renderer: "markdown", enabledCommands: ["document-history"] }); history.click!(); expect(f.sendCommand).not.toHaveBeenCalled();
    f.controller.update({ renderer: "markdown", enabledCommands: [] });
    f.historyAllowed.mockReturnValue(true); f.controller.refresh(); history.click!(); expect(f.legacy).toHaveBeenCalledOnce();
    f.controller.update({ renderer: "word", enabledCommands: ["document-history"] }); history.click!(); expect(f.sendCommand).toHaveBeenCalledExactlyOnceWith("document-history");
    f.controller.update({ renderer: "word", enabledCommands: [] }); history.click!(); expect(history.enabled).toBe(false); expect(f.sendCommand).toHaveBeenCalledOnce();
  });

  it("keeps native Zoom In/Out available only for Markdown or zoom-capable Word", () => {
    const f = fixture();
    f.controller.update({ renderer: "word", enabledCommands: ["view-zoom-reset"] });
    for (const id of ZOOM_MENU_IDS) { expect(f.items.get(id)!.enabled).toBe(true); f.items.get(id)!.click!(); }
    expect(f.legacy).toHaveBeenCalledTimes(2);
    f.controller.update({ renderer: "word", enabledCommands: [] });
    for (const id of ZOOM_MENU_IDS) { expect(f.items.get(id)!.enabled).toBe(false); f.items.get(id)!.click!(); }
    expect(f.legacy).toHaveBeenCalledTimes(2);
    f.controller.update({ renderer: "markdown", enabledCommands: [] });
    expect(f.items.get(ZOOM_MENU_IDS[0])!.enabled).toBe(true);
    f.controller.update({ renderer: "none", enabledCommands: [] });
    expect(f.items.get(ZOOM_MENU_IDS[0])!.enabled).toBe(false);
  });

  it("exposes distinct native creation commands without duplicate accelerators", () => {
    const f = fixture();
    f.controller.update({ renderer: "markdown", enabledCommands: ["new-markdown", "new-word", "new-text"] });
    for (const id of ["new-markdown", "new-word", "new-text"]) {
      const item = f.items.get(id)!; expect(item.enabled).toBe(true); expect(item.accelerator).toBeUndefined(); item.click!();
    }
    expect(f.sendCommand.mock.calls.map((call) => call[0])).toEqual(["new-markdown", "new-word", "new-text"]);
  });
});

describe("native menu IPC wiring", () => {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  it("accepts capability updates only from the current app main frame", async () => {
    const mainFrame = { url: "app://markie/index.html" }, sender = { mainFrame }, controller = { update: vi.fn(() => ({ ok: true })) };
    const window = { isDestroyed: () => false, webContents: sender };
    const guardStart = source.indexOf("function currentCloseSender(");
    const guardEnd = source.indexOf('ipcMain.on("app-close-ready"', guardStart);
    const currentCloseSender = runInNewContext(`(${source.slice(guardStart, guardEnd).trim()})`, { mainWindow: window, isAppUrl: (url: string) => url.startsWith("app://markie/") });
    let handler: (event: unknown, state: unknown) => unknown = () => undefined;
    const start = source.indexOf('handle("document-menu-state"');
    runInNewContext(source.slice(start, source.indexOf("registerDocumentFileIpc(", start)), { currentCloseSender, documentMenu: controller, handle: (_channel: string, fn: typeof handler) => { handler = fn; } });
    const state = { renderer: "word", enabledCommands: ["format-bold"] };
    for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender, senderFrame: { url: "app://markie/index.html" } }, { sender, senderFrame: null }]) expect(await handler(event, state)).toMatchObject({ ok: false });
    mainFrame.url = "https://untrusted.invalid"; expect(await handler({ sender, senderFrame: mainFrame }, state)).toMatchObject({ ok: false });
    expect(controller.update).not.toHaveBeenCalled(); mainFrame.url = "app://markie/index.html";
    expect(await handler({ sender, senderFrame: mainFrame }, state)).toMatchObject({ ok: true }); expect(controller.update).toHaveBeenCalledExactlyOnceWith(state);
  });

  it("resets capabilities on full navigation, renderer loss and window teardown", () => {
    const start = source.indexOf("const nativeDocumentOwner"), end = source.indexOf('mainWindow.once("ready-to-show"', start);
    const lifecycle = source.slice(start, end);
    expect(lifecycle).toMatch(/once\("destroyed"[^\n]+documentMenu\.reset\(\)/);
    expect(lifecycle).toMatch(/on\("render-process-gone"[^\n]+documentMenu\.reset\(\)/);
    expect(lifecycle).toMatch(/if \(isMainFrame && !isInPlace\)[^\n]+documentMenu\.reset\(\)/);
    expect(source.slice(source.indexOf('mainWindow.on("closed"'), source.indexOf('if (isDev) {', source.indexOf('mainWindow.on("closed"')))).toContain("documentMenu.reset()");
    expect(source).toContain('mainWindow.webContents.send("document-command", command)');
  });
});
