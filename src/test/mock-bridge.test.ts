import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { channelForMethod, emit, listenerCount, makeBridge } from "./mock-bridge";

const electronDts = readFileSync(
  fileURLToPath(new URL("../lib/electron.ts", import.meta.url)),
  "utf8"
);
const preloadSrc = readFileSync(
  fileURLToPath(new URL("../../electron/preload.js", import.meta.url)),
  "utf8"
);

/**
 * Re-derive the ElectronAPI members from the source text so this test fails
 * the moment the interface grows a member the mock doesn't carry.
 */
function electronApiMembers(): string[] {
  const start = electronDts.indexOf("export interface ElectronAPI {");
  expect(start, "ElectronAPI interface not found in src/lib/electron.ts").toBeGreaterThan(-1);
  const body = electronDts.slice(start, electronDts.indexOf("\n}\n", start));
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    // Members sit at exactly two spaces of indent; nested object literals are
    // indented further and closing braces don't start with an identifier.
    const m = /^ {2}([A-Za-z_$][\w$]*)\??\s*[(:]/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

function preloadKeys(): string[] {
  const start = preloadSrc.indexOf('contextBridge.exposeInMainWorld("electronAPI", {');
  expect(start, "exposeInMainWorld not found in electron/preload.js").toBeGreaterThan(-1);
  const body = preloadSrc.slice(start);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^ {2}([A-Za-z_$][\w$]*):/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

describe("ElectronAPI mock bridge", () => {
  it("derives a non-trivial member list from the interface", () => {
    expect(electronApiMembers().length).toBeGreaterThan(50);
  });

  it("covers every ElectronAPI member", () => {
    const bridge = makeBridge() as unknown as Record<string, unknown>;
    const missing = electronApiMembers().filter((name) => bridge[name] === undefined);
    expect(missing, `mock-bridge.ts is missing ElectronAPI members: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not expose members the interface has dropped", () => {
    const members = new Set(electronApiMembers());
    const extra = Object.keys(makeBridge()).filter((k) => !members.has(k));
    expect(extra, `mock-bridge.ts exposes members ElectronAPI no longer declares: ${extra.join(", ")}`).toEqual([]);
  });

  it("matches the preload surface exactly", () => {
    const bridge = new Set(Object.keys(makeBridge()));
    const missing = preloadKeys().filter((k) => !bridge.has(k));
    expect(missing, `preload exposes keys the mock lacks: ${missing.join(", ")}`).toEqual([]);
  });

  it("maps onX method names to their preload IPC channels", () => {
    expect(channelForMethod("onMenuSaveAs")).toBe("menu-save-as");
    expect(channelForMethod("onMdIndexUpdated")).toBe("mdindex-updated");
    // every derived channel must be a channel preload actually subscribes to
    const subscribed = new Set(
      [...preloadSrc.matchAll(/subscribe\("([a-z0-9-]+)"/g)].map((m) => m[1])
    );
    const onMethods = Object.keys(makeBridge()).filter((k) => k.startsWith("on"));
    const unknown = onMethods
      .map((m) => [m, channelForMethod(m)] as const)
      .filter(([, ch]) => !subscribed.has(ch))
      .map(([m, ch]) => `${m} -> ${ch}`);
    expect(unknown, `mock channels with no preload subscription: ${unknown.join(", ")}`).toEqual([]);
  });

  it("delivers emitted pushes to subscribers and stops after unsubscribe", () => {
    const bridge = makeBridge();
    const cb = vi.fn();
    const off = bridge.onMenuSave(cb);
    expect(listenerCount("menu-save")).toBe(1);
    expect(listenerCount("onMenuSave")).toBe(1);

    emit("menu-save");
    expect(cb).toHaveBeenCalledTimes(1);

    off?.();
    expect(listenerCount("menu-save")).toBe(0);
    emit("menu-save");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("passes payload arguments through emit", () => {
    const bridge = makeBridge();
    const cb = vi.fn();
    bridge.onUpdateReady(cb);
    emit("update-ready", { version: "1.2.3" });
    expect(cb).toHaveBeenCalledWith({ version: "1.2.3" });
  });

  it("applies overrides over the defaults", async () => {
    const bridge = makeBridge({ platform: "win32", updateStatus: async () => "downloaded" });
    expect(bridge.platform).toBe("win32");
    await expect(bridge.updateStatus()).resolves.toBe("downloaded");
    // untouched members keep their defaults
    await expect(bridge.termAvailable()).resolves.toBe(false);
  });
});
