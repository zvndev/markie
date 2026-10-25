import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const { SAFE_DOC_EXTENSION } = require("./doc-names.js");
// The classic text set the Finder handler and the grants use. .wd is not in it.
const OPENABLE = /\.(md|markdown|mdx|txt|text|log|csv)$/i;

function slice(from: string, to: string) {
  const start = source.indexOf(from);
  expect(start, `${from} is in main.js`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end, `${to} follows ${from}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function openBridge({ nativeQueues = true, payload = null as unknown, rendererReady = true, workspace = false } = {}) {
  const send = vi.fn();
  const win = { webContents: { send }, isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn() };
  const queueNativeDocumentOpen = vi.fn(() => nativeQueues);
  // Mirrors file-grants: a path outside OPENABLE is refused outright.
  const readFilePayload = vi.fn((p: string) => (OPENABLE.test(p) ? payload : null));
  const ctx: Record<string, unknown> = {
    privateRelease: { authorized: () => true }, preflightMode: false,
    documentsWorkspaceActive: () => workspace, queueNativeDocumentOpen, readFilePayload,
    OPENABLE, rendererReady, mainWindow: win, pendingFilePath: null, app: { isReady: () => true }, createWindow: vi.fn(),
  };
  runInNewContext(`${slice("function openLocalFile(", "// markie://open?token=")}\nthis.openLocalFile = openLocalFile;`, ctx);
  return { open: ctx.openLocalFile as (p: string) => boolean, queueNativeDocumentOpen, readFilePayload, send, ctx };
}

describe("openLocalFile for a document that lands from Cloud", () => {
  it("queues a .wd through the native document path instead of the classic reader", () => {
    const f = openBridge();
    expect(f.open("/Users/me/Downloads/Plan.wd")).toBe(true);
    expect(f.queueNativeDocumentOpen).toHaveBeenCalledExactlyOnceWith("/Users/me/Downloads/Plan.wd");
    expect(f.readFilePayload).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does the same before the renderer is ready, rather than parking a path it would refuse", () => {
    const f = openBridge({ rendererReady: false });
    expect(f.open("/Users/me/Downloads/Plan.wd")).toBe(true);
    expect(f.ctx.pendingFilePath).toBeNull();
  });

  it("still reads a classic .md as a text payload", () => {
    const payload = { name: "n.md", content: "# n", path: "/Users/me/Downloads/n.md" };
    const f = openBridge({ payload });
    expect(f.open("/Users/me/Downloads/n.md")).toBe(true);
    expect(f.queueNativeDocumentOpen).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledExactlyOnceWith("file-opened", payload);
  });

  it("says so when nothing could be opened, instead of reporting success", () => {
    const f = openBridge({ nativeQueues: false });
    expect(f.open("/Users/me/Downloads/Plan.wd")).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    const unreadable = openBridge({ payload: null });
    expect(unreadable.open("/Users/me/Downloads/gone.md")).toBe(false);
  });
});

describe("doc-open-shared", () => {
  function run(opened: boolean, pullResult: Record<string, unknown> = { ok: true }) {
    let call: (event: unknown, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;
    const openLocalFile = vi.fn(() => opened);
    const grantFile = vi.fn();
    runInNewContext(slice('handle("doc-open-shared"', "// IPC: open a file the document links to"), {
      handle: (_c: string, fn: typeof call) => { call = fn; },
      downloadsUniquePath: (n: string) => `/Users/me/Downloads/${n}`,
      sync: { pull: vi.fn(async () => pullResult) }, trustedServerArg: (s: unknown) => s,
      fileGrants: { grantFile }, openLocalFile,
    });
    return { call, openLocalFile };
  }

  it("answers ok with the path when the document opens", async () => {
    const f = run(true);
    expect(await f.call({}, { cloudId: "c1", suggestedName: "Plan.wd" })).toEqual({ ok: true, path: "/Users/me/Downloads/Plan.wd" });
  });

  it("never answers ok when the document did not open", async () => {
    const f = run(false);
    const res = (await f.call({}, { cloudId: "c1", suggestedName: "Plan.wd" })) as { ok?: boolean; error?: string; path?: string };
    expect(res.ok).toBeUndefined();
    expect(res.error).toMatch(/could not open/);
    expect(res.path).toBe("/Users/me/Downloads/Plan.wd");
  });

  it("passes a failed download straight through", async () => {
    const f = run(true, { error: "gone" });
    expect(await f.call({}, { cloudId: "c1" })).toEqual({ error: "gone" });
    expect(f.openLocalFile).not.toHaveBeenCalled();
  });
});

describe("Download… of a cloud document", () => {
  function run(filePath: string | null) {
    let call: (event: unknown, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;
    const showSaveDialog = vi.fn(async (_w: unknown, _o: unknown) => (filePath ? { canceled: false, filePath } : { canceled: true }));
    const pull = vi.fn(async (_id: string, p: string) => ({ ok: true, path: p }));
    runInNewContext(slice("function pullSaveFilters(", "// Open a shared cloud doc"), {
      handle: (_c: string, fn: typeof call) => { call = fn; },
      dialog: { showSaveDialog }, mainWindow: {}, SAFE_DOC_EXTENSION, OPENABLE,
      sync: { pull }, trustedServerArg: (s: unknown) => s, fileGrants: { grantFile: vi.fn() }, refreshDiskMemory: vi.fn(),
    });
    return { call, showSaveDialog, pull };
  }

  it("saves a cloud-only .wd instead of refusing the type", async () => {
    const f = run("/Users/me/Documents/Plan.wd");
    expect(await f.call({}, { cloudId: "c1", suggestedName: "Plan.wd" })).toEqual({ ok: true, path: "/Users/me/Documents/Plan.wd" });
    expect(f.pull).toHaveBeenCalled();
  });

  it("offers Darkmown in the save dialog", async () => {
    const f = run(null);
    await f.call({}, { cloudId: "c1", suggestedName: "Plan.wd" });
    const options = f.showSaveDialog.mock.calls[0][1] as { filters: { name: string; extensions: string[] }[] };
    expect(options.filters).toContainEqual({ name: "Darkmown", extensions: ["wd"] });
  });

  it("still refuses a type that is not a document", async () => {
    const f = run("/Users/me/Documents/run.command");
    expect(await f.call({}, { cloudId: "c1", suggestedName: "x" })).toEqual({ error: "Unsupported file type" });
    expect(f.pull).not.toHaveBeenCalled();
  });
});

describe("doc-sync-on from the app", () => {
  it("never forwards an agent origin, even if the renderer sends one", async () => {
    let call: (event: unknown, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;
    const syncOn = vi.fn(async () => ({ ok: true }));
    runInNewContext(slice('handle("doc-sync-on"', 'handle("doc-sync-off"'), {
      handle: (_c: string, fn: typeof call) => { call = fn; },
      sync: { syncOn }, trustedServerArg: (s: unknown) => s,
    });
    await call({}, { path: "/Users/me/a.wd", name: "a.wd", content: "x", areaId: "area", server: undefined, origin: { kind: "agent", agent: "Mallory" } });
    expect(syncOn).toHaveBeenCalledTimes(1);
    const args = syncOn.mock.calls[0] as unknown[];
    expect(args.slice(0, 4)).toEqual(["/Users/me/a.wd", "a.wd", "x", "area"]);
    // The sixth argument is the origin. Only the agent bridge may set it.
    expect(args.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(args)).not.toContain("Mallory");
  });
});

describe("the Download save dialog for a cloud document", () => {
  const ctx: Record<string, unknown> = {};
  runInNewContext(`${slice("function pullSaveFilters(", 'handle("doc-pull"')}\nthis.pullSaveFilters = pullSaveFilters;`, ctx);
  const filters = ctx.pullSaveFilters as (name?: string) => { name: string }[];

  it("lists the filter matching the suggested name first, so macOS keeps Plan.wd as Plan.wd", () => {
    expect(filters("Plan.wd")[0].name).toBe("Darkmown");
    expect(filters("notes.TXT")[0].name).toBe("Text");
    expect(filters("Plan.md")[0].name).toBe("Markdown");
  });

  it("keeps every filter and the default order when the name says nothing", () => {
    expect(filters(undefined).map((f) => f.name)).toEqual(["Markdown", "Darkmown", "Text"]);
    expect(filters("Plan.wd").map((f) => f.name).sort()).toEqual(["Darkmown", "Markdown", "Text"]);
  });
});
