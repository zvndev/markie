import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopStartUrl, initializeDesktopIdentity, isDesktopPreview, isStableDesktopAuthUrl, userDataOverride, validatedProfilePath } from "./desktop-preview.cjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markie-preview-test-"))); roots.push(root);
  const home = path.join(root, "home"), appData = path.join(home, "appData"), stableUserData = path.join(appData, "Markie");
  fs.mkdirSync(stableUserData, { recursive: true });
  const paths: Record<string, string> = { home, appData, userData: stableUserData };
  const app = { isPackaged: true, getPath: vi.fn((name: string) => paths[name]), setName: vi.fn(), setPath: vi.fn((name: string, target: string) => { paths[name] = target; }), setAppUserModelId: vi.fn() };
  return { root, home, appData, stableUserData, app, paths };
}
const metadata = { name: "markie-preview", markieDesktopPreview: true };

describe("trusted desktop preview runtime", () => {
  it("requires both packaged manifest fields, not loose truthiness or the product name", () => {
    expect(isDesktopPreview({ isPackaged: true, metadata })).toBe(true);
    for (const candidate of [{ name: "markie", markieDesktopPreview: true }, { name: "markie-preview" }, { name: "markie-preview", markieDesktopPreview: "true" }, { productName: "Markie Preview" }, null]) {
      expect(isDesktopPreview({ isPackaged: true, metadata: candidate })).toBe(false);
    }
    expect(isDesktopPreview({ isPackaged: false, metadata })).toBe(false);
  });

  it("opens the original bundled Markie shell even with inherited development environment", () => {
    expect(desktopStartUrl({ isPreview: true, isDev: true, devUrl: "https://untrusted.invalid" })).toBe("app://markie/index.html");
    expect(desktopStartUrl({ isPreview: true })).toBe(desktopStartUrl());
    expect(desktopStartUrl()).toBe("app://markie/index.html");
    expect(desktopStartUrl({ isDev: true, devUrl: "http://localhost:3000/?classic=1" })).toBe("http://localhost:3000/?classic=1");
  });

  it("leaves stable app identity and every path unchanged", () => {
    const { app } = fixture();
    expect(initializeDesktopIdentity({ app, metadata: { name: "markie" }, argv: [] })).toEqual({ isPreview: false, userData: null });
    expect(app.getPath).not.toHaveBeenCalled(); expect(app.setPath).not.toHaveBeenCalled(); expect(app.setName).not.toHaveBeenCalled();
  });

  it("isolates preview app data, sessions, logs and crash dumps before consumers", () => {
    const { app, appData, paths } = fixture();
    const result = initializeDesktopIdentity({ app, metadata, argv: [] });
    expect(result).toEqual({ isPreview: true, userData: path.join(appData, "Markie Preview") });
    expect(app.setName).toHaveBeenCalledWith("Markie Preview");
    expect(paths.sessionData).toBe(path.join(result.userData!, "session"));
    expect(paths.logs).toBe(path.join(result.userData!, "logs"));
    expect(paths.crashDumps).toBe(path.join(result.userData!, "crashes"));
    for (const target of Object.values(paths).slice(2)) expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("honors one validated explicit test profile for packaged and development runs", () => {
    const { app, root, paths } = fixture();
    app.isPackaged = false;
    const isolated = path.join(root, "isolated");
    expect(initializeDesktopIdentity({ app, metadata, argv: [`--user-data-dir=${isolated}`] })).toEqual({ isPreview: false, userData: isolated });
    expect(paths.userData).toBe(isolated); expect(paths.sessionData).toBe(path.join(isolated, "session"));
    expect(app.setName).not.toHaveBeenCalled();
  });

  it("rejects ambiguous, missing, relative and broad profile overrides", () => {
    const context = fixture();
    expect(userDataOverride(["--user-data-dir", "/tmp/unique"])).toBe("/tmp/unique");
    expect(userDataOverride([])).toBeNull();
    for (const argv of [["--user-data-dir"], ["--user-data-dir="], ["--user-data-dir=/one", "--user-data-dir=/two"]]) expect(() => userDataOverride(argv)).toThrow();
    for (const target of ["relative/profile", "/", context.home, context.appData, context.root, context.stableUserData, path.join(context.stableUserData, "session"), "\0/tmp/profile"]) {
      expect(() => validatedProfilePath(target, context)).toThrow();
    }
  });

  it("rejects a symlink into installed Markie, including nonexistent descendants", () => {
    const context = fixture(), alias = path.join(context.root, "alias");
    fs.symlinkSync(context.stableUserData, alias, "dir");
    expect(() => validatedProfilePath(path.join(alias, "new-profile"), context)).toThrow(/installed Markie/);
    expect(fs.readdirSync(context.stableUserData)).toEqual([]);
  });

  it("uses Windows drive-local paths and case-insensitive stable-profile protection", () => {
    const nativeFs = { realpathSync: (value: string) => value };
    const context = { fs: nativeFs, platform: "win32" as const, path: path.win32, home: "C:\\Users\\writer", appData: "C:\\Users\\writer\\AppData\\Roaming", stableUserData: "C:\\Users\\writer\\AppData\\Roaming\\Markie" };
    expect(validatedProfilePath("C:\\Temp\\Preview", context)).toBe("C:\\Temp\\Preview");
    for (const target of ["C:\\", "\\\\host\\share\\preview", "C:relative", "c:\\users\\writer\\appdata\\roaming\\MARKIE\\new"]) expect(() => validatedProfilePath(target, context)).toThrow();
  });

  it("identifies the exact existing Google handoff paths without blocking normal links", () => {
    for (const pathname of ["/auth/google-start?state=synthetic", "/auth/desktop-bridge", "/api/auth/desktop/callback"]) expect(isStableDesktopAuthUrl(`https://example.invalid${pathname}`)).toBe(true);
    for (const value of ["not-a-url", "https://example.invalid/docs", "https://example.invalid/auth/google-start-other"]) expect(isStableDesktopAuthUrl(value)).toBe(false);
  });
});

describe("main-process preview isolation wiring", () => {
  const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
  it("initializes trusted identity before updater, crash and registry consumers", () => {
    const init = source.indexOf("initializeDesktopIdentity({ app, metadata: require(\"../package.json\") })");
    expect(init).toBeGreaterThan(-1);
    for (const consumer of ['require("electron-updater")', 'require("./registry")', "crashReporter.start("]) expect(init).toBeLessThan(source.indexOf(consumer));
    expect(source).toContain('const isDev = !privateReleaseConfig && !isDesktopPreview && process.env.NODE_ENV === "development"');
    expect(source).toContain("desktopStartUrl({ isPreview: isDesktopPreview })");
  });

  it("blocks protocol takeover, callbacks, default-handler changes and every updater entry", () => {
    expect(source).toContain('if (!isDesktopPreview && process.env.MARKIE_E2E !== "1")');
    expect(source).toContain("const argDeepLink = isDesktopPreview ? null : findDeepLinkArg");
    const deepLink = source.slice(source.indexOf("function deliverDeepLink(link)"), source.indexOf("function showDeepLinkFailure"));
    expect(deepLink).toContain("if (isDesktopPreview) return;");
    for (const entry of ['handle("default-md-status"', 'handle("set-default-md"', 'handle("quit-and-install"']) {
      const start = source.indexOf(entry); expect(source.slice(start, start + 230)).toContain("if (isDesktopPreview)");
    }
    const updates = source.slice(source.indexOf("async function requestUpdateCheck"), source.indexOf("// IPC: make Markie"));
    expect(updates).toContain("isPreview: isDesktopPreview");
    expect(updates).toContain("if (isDesktopPreview || !shouldSetupAutoUpdate(");
    expect(updates).toContain('if (isDesktopPreview) return { optedIn: false, channel: null, allowDowngrade: false }');
    expect(source).toContain("isDesktopPreview && isStableDesktopAuthUrl(webTarget)");
  });
});
