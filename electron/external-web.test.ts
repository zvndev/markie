import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { externalWebTarget } from "./external-web.cjs";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
describe("device-browser web targets", () => {
  it("normalizes ordinary web links without stripping content queries or fragments", () => {
    expect(externalWebTarget("HTTPS://EXAMPLE.COM/path?q=words#section")).toBe("https://example.com/path?q=words#section");
    expect(externalWebTarget("https://example.com/auth?code=explicit-browser-action")).toContain("?code=");
  });
  it.each([null, {}, 2, "", "javascript:alert(1)", "file:///private/test", "data:text/html,test", "app://markie/index.html", "markie://test", "https://user:password@example.com", "https://example.com\n.evil.test", "https://example.com/\u007f", "https://example.com/" + "a".repeat(8192)])("refuses an unsafe target %j", (value) => {
    expect(externalWebTarget(value)).toBeNull();
  });
});

describe("web interaction IPC ownership", () => {
  function fixture(trusted = true, preview = false, privateLocked = false) {
    const callbacks = new Map<string, (...args: unknown[]) => Promise<unknown> | unknown>();
    const get = vi.fn(async () => ({ title: "Preview" }));
    const openExternal = vi.fn(async () => {});
    const showMessageBox = vi.fn();
    const logCrash = vi.fn();
    const start = source.indexOf("const linkPreviews = createLinkPreviews(");
    const end = source.indexOf("// ── Browse:", start);
    runInNewContext(source.slice(start, end), {
      privateReleaseConfig: privateLocked ? {} : null, privateRelease: { authorized: () => !privateLocked }, PRIVATE_AUTH_ORIGIN: "https://api.markiedocs.com", URL,
      createLinkPreviews: () => ({ get }),
      process: { env: {} },
      handle: (channel: string, callback: (...args: unknown[]) => unknown) => callbacks.set(channel, callback),
      currentCloseSender: () => trusted,
      externalWebTarget,
      isDesktopPreview: preview,
      isStableDesktopAuthUrl: (target: string) => new URL(target).pathname === "/auth/google-start",
      dialog: { showMessageBox }, mainWindow: {}, shell: { openExternal }, logCrash,
    });
    return { callbacks, get, openExternal, showMessageBox, logCrash };
  }
  it("allows only the fixed existing auth handoff while the private build is locked", async () => {
    const f = fixture(true, false, true);
    await f.callbacks.get("open-external")!({}, "https://example.com/auth/google-start");
    await f.callbacks.get("open-external")!({}, "https://api.markiedocs.com/docs");
    expect(f.openExternal).not.toHaveBeenCalled();
    await f.callbacks.get("open-external")!({}, "https://api.markiedocs.com/auth/google-start");
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith("https://api.markiedocs.com/auth/google-start");
  });
  it("does not fetch metadata or open the browser for a foreign frame", async () => {
    const f = fixture(false);
    expect(await f.callbacks.get("link-preview")!({}, "https://example.com")).toBeNull();
    await f.callbacks.get("open-external")!({}, "https://example.com");
    expect(f.get).not.toHaveBeenCalled(); expect(f.openExternal).not.toHaveBeenCalled();
  });
  it("uses the existing device-browser handoff for a trusted ordinary web link", async () => {
    const f = fixture();
    await f.callbacks.get("open-external")!({}, "HTTPS://EXAMPLE.COM/path");
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
    await f.callbacks.get("open-external")!({}, "javascript:alert(1)");
    await f.callbacks.get("open-external")!({}, "https://user:secret@example.com");
    expect(f.openExternal).toHaveBeenCalledOnce();
  });
  it("keeps the preview OAuth callback restriction after target normalization", async () => {
    const f = fixture(true, true);
    await f.callbacks.get("open-external")!({}, "HTTPS://EXAMPLE.COM/auth/google-start?code=explicit");
    expect(f.showMessageBox).toHaveBeenCalledOnce(); expect(f.openExternal).not.toHaveBeenCalled();
    await f.callbacks.get("open-external")!({}, "https://example.com/docs");
    expect(f.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  });
  it.each(["async", "sync"])("never logs the %s browser failure URL or secret identity-link fragment", async (mode) => {
    const f = fixture(), target = "https://example.com/account/link-google#intent=fixture-secret-fragment";
    if (mode === "async") f.openExternal.mockRejectedValue(new Error(`Cannot launch ${target}`));
    else f.openExternal.mockImplementation(() => { throw new Error(`Cannot launch ${target}`); });
    await f.callbacks.get("open-external")!({}, target); await Promise.resolve();
    expect(f.logCrash).toHaveBeenCalledExactlyOnceWith("open-external-failed", "Could not open the external browser.");
    expect(JSON.stringify(f.logCrash.mock.calls)).not.toContain("fixture-secret-fragment");
  });
});

describe("native navigation failure redaction", () => {
  it.each(["async", "sync"])("redacts %s browser failure details from window-open and will-navigate handlers", async (mode) => {
    let windowOpen!: (args: { url: string }) => { action: string };
    const listeners = new Map<string, (...args: unknown[]) => void>(), logCrash = vi.fn();
    const target = "https://example.com/account/link-google#intent=fixture-secret-fragment";
    const mainWindow = { webContents: { setWindowOpenHandler: (handler: typeof windowOpen) => { windowOpen = handler; }, on: (event: string, callback: (...args: unknown[]) => void) => listeners.set(event, callback) } };
    const start = source.indexOf("  mainWindow.webContents.setWindowOpenHandler(");
    const end = source.indexOf("  // Closing the window", start);
    const openExternal = mode === "async" ? async () => { throw new Error(target); } : () => { throw new Error(target); };
    runInNewContext(source.slice(start, end), { mainWindow, externalWebTarget, shell: { openExternal }, isAppUrl: () => false, logCrash });
    expect(windowOpen({ url: target })).toEqual({ action: "deny" });
    listeners.get("will-navigate")!({ preventDefault: vi.fn() }, target); await Promise.resolve();
    expect(logCrash).toHaveBeenCalledTimes(2);
    for (const call of logCrash.mock.calls) expect(call).toEqual(["open-external-failed", "Could not open the external browser."]);
  });
});

describe("native media Escape forwarding", () => {
  function fixture() {
    const send = vi.fn(), callbacks = new Map<string, (event: unknown, input: unknown) => void>();
    const contents = { send, isDestroyed: vi.fn(() => false), getURL: vi.fn(() => "app://markie/index.html"), on: (name: string, callback: (event: unknown, input: unknown) => void) => callbacks.set(name, callback) };
    const mainWindow = { webContents: contents };
    const start = source.indexOf("  const mediaContents = mainWindow.webContents;");
    const end = source.indexOf('  mainWindow.once("ready-to-show"', start);
    runInNewContext(source.slice(start, end), { mainWindow, isAppUrl: (url: string) => url.startsWith("app://markie/") });
    return { contents, mainWindow, send, input: callbacks.get("before-input-event")! };
  }
  it("forwards only a non-composing Escape down event without suppressing native input", () => {
    const f = fixture(), event = { preventDefault: vi.fn() };
    for (const input of [{ type: "keyUp", key: "Escape" }, { type: "keyDown", key: "Enter" }, { type: "keyDown", key: "Escape", isComposing: true }]) f.input(event, input);
    expect(f.send).not.toHaveBeenCalled();
    f.input(event, { type: "keyDown", key: "Escape" });
    expect(f.send).toHaveBeenCalledExactlyOnceWith("document-command", "dismiss-media-viewer");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("targets its captured live application contents, not a replaced global window", () => {
    const f = fixture(), other = { ...f.contents, send: vi.fn() };
    f.mainWindow.webContents = other;
    f.input({}, { type: "keyDown", key: "Escape" });
    expect(f.send).toHaveBeenCalledOnce(); expect(other.send).not.toHaveBeenCalled();
    f.contents.isDestroyed.mockReturnValue(true);
    f.input({}, { type: "keyDown", key: "Escape" });
    f.contents.isDestroyed.mockReturnValue(false); f.contents.getURL.mockReturnValue("https://example.com/");
    f.input({}, { type: "keyDown", key: "Escape" }); expect(f.send).toHaveBeenCalledOnce();
  });
});
