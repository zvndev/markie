import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createPrivateReleaseGate, privateReleaseConfig, initializePrivateReleaseIdentity, FRESH_MS, isPrivatePreflightProfile, writePrivatePreflightReady } from "./private-release.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const metadata = { markiePrivateRelease: { channel: "super-nightly", apiOrigin: "https://private.example", gitCommit: "0123456789abcdef" } };
const proof = { authorized: true, channel: "super-nightly", userId: "synthetic-authorized-user" };
function fixture() {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markie-private-gate-"))); directories.push(userData);
  let time = 100;
  const fetch = vi.fn(async () => Response.json(proof));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "keychain", encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`), decryptString: (value: Buffer) => Buffer.from(value.toString().slice(10), "base64").toString() };
  const onLock = vi.fn(), config = privateReleaseConfig(metadata);
  const gate = createPrivateReleaseGate({ config, userData, safeStorage, fetch, now: () => time, onLock });
  return { gate, fetch, safeStorage, userData, onLock, expire: () => { time += FRESH_MS; } };
}
describe("owner-only private release native gate", () => {
  it("leaves marker-free and false-marker builds unrestricted", () => {
    expect(privateReleaseConfig({})).toBeNull(); expect(privateReleaseConfig({ markiePrivateRelease: false })).toBeNull();
    const gate = createPrivateReleaseGate({ config: null, userData: "/unused", safeStorage: null });
    expect(gate.authorized()).toBe(true); expect(gate.allows("save-file")).toBe(true);
  });
  it("fails closed for malformed private manifests and untrusted origins", async () => {
    for (const apiOrigin of ["http://private.example", "https://private.example/path", "https://user:pass@private.example", "https://private.example?feed=stable"]) {
      const config = privateReleaseConfig({ markiePrivateRelease: { ...metadata.markiePrivateRelease, apiOrigin } });
      expect(config?.apiOrigin).toBeNull();
      const fixtureValue = fixture();
      const gate = createPrivateReleaseGate({ ...fixtureValue, config });
      expect((await gate.authorize("synthetic-token")).authorized).toBe(false);
    }
  });
  it("denies file, mutation, terminal, MCP and beta IPC before online proof", () => {
    const { gate } = fixture();
    for (const channel of ["open-file", "document-files:write", "registry-list", "term-create", "mcp-info", "update-channel-set", "private-release-session"]) expect(gate.allows(channel)).toBe(false);
    expect(gate.allows("private-release-authorize")).toBe(true); expect(gate.allows("private-release-status")).toBe(true);
  });
  it("verifies through one HTTPS gateway without redirects and persists only encrypted credentials", async () => {
    const { gate, fetch, userData } = fixture();
    expect((await gate.authorize("synthetic-token")).authorized).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://private.example/private-releases/access", expect.objectContaining({ redirect: "error", cache: "no-store", headers: { Authorization: "Bearer synthetic-token" } }));
    expect(fs.readFileSync(path.join(userData, "private-release-credential")).toString()).not.toContain("synthetic-token");
    expect(fs.statSync(path.join(userData, "private-release-credential")).mode & 0o777).toBe(0o600);
    expect(gate.status()).not.toHaveProperty("token");
    expect(gate.updaterSettings()).toEqual({ provider: "generic", url: "https://private.example/private-releases/super-nightly/", channel: "super-nightly", requestHeaders: { Authorization: "Bearer synthetic-token" }, useMultipleRangeRequest: false });
  });
  it("does not treat stored credentials as authorization on a new launch", async () => {
    const first = fixture(); await first.gate.authorize("synthetic-token");
    const fetch = vi.fn(async () => { throw new Error("offline synthetic-token"); });
    const next = createPrivateReleaseGate({ config: privateReleaseConfig(metadata), userData: first.userData, safeStorage: first.safeStorage, fetch });
    expect(next.authorized()).toBe(false); expect((await next.authorize()).authorized).toBe(false); expect(next.rendererCredential()).toBeNull();
  });
  it("revokes access immediately on denied refresh and expires its online proof", async () => {
    const { gate, fetch, onLock, expire } = fixture(); await gate.authorize("synthetic-token");
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await gate.authorize(undefined, { enroll: false })).authorized).toBe(false); expect(onLock).toHaveBeenCalledOnce(); expect(() => gate.updaterSettings()).toThrow();
    await gate.authorize("synthetic-token"); expire(); expect(gate.authorized()).toBe(false); expect(gate.allows("save-file")).toBe(false);
  });
  it.each(["denied", "offline"])("fully cleans up an expired live session after %s refresh", async (failure) => {
    const { gate, fetch, onLock, expire } = fixture(); await gate.authorize("synthetic-token"); expire();
    if (failure === "denied") fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    else fetch.mockRejectedValueOnce(new Error("offline"));
    expect(gate.authorized()).toBe(false); expect(onLock).not.toHaveBeenCalled();
    expect((await gate.authorize(undefined, { enroll: false })).authorized).toBe(false);
    expect(onLock).toHaveBeenCalledOnce(); expect(gate.rendererCredential()).toBeNull(); expect(gate.allows("document-files:write")).toBe(false);
    expect(() => gate.updaterSettings()).toThrow("authorization");
  });
  it("forgets expired enrollment via bootstrap logout and never silently re-enrolls when online returns", async () => {
    const { gate, fetch, expire, userData } = fixture(); await gate.authorize("synthetic-token"); expire();
    expect(gate.allows("sync-config")).toBe(false); expect(gate.allows("private-release-lock")).toBe(true);
    gate.lock({ forget: true }); expect(fs.existsSync(path.join(userData, "private-release-credential"))).toBe(false);
    fetch.mockClear(); expect((await gate.authorize(undefined, { enroll: false })).authorized).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unavailable or plaintext safeStorage and does not accept loose entitlement responses", async () => {
    const { gate, fetch, safeStorage } = fixture(); safeStorage.getSelectedStorageBackend = () => "basic_text";
    expect((await gate.authorize("synthetic-token")).authorized).toBe(false); expect(fetch).not.toHaveBeenCalled();
    safeStorage.getSelectedStorageBackend = () => "keychain";
    fetch.mockResolvedValueOnce(Response.json({ ...proof, authorized: "true" }));
    expect((await gate.authorize("synthetic-token")).authorized).toBe(false);
  });
  it("does not let an in-flight authorization resurrect a locked session", async () => {
    const { gate, fetch } = fixture(); let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = gate.authorize("synthetic-token"); gate.lock({ forget: true }); finish(Response.json(proof));
    expect((await pending).authorized).toBe(false);
  });
  it("isolates private profiles without touching stable files", () => {
    const { userData: directory } = fixture(), stable = path.join(directory, "Markie"); fs.mkdirSync(stable); fs.writeFileSync(path.join(stable, "keep"), "stable");
    const values: Record<string, string> = { appData: directory, home: path.dirname(directory), userData: stable };
    const app = { getPath: (name: string) => values[name], setPath: (name: string, value: string) => { values[name] = value; } };
    initializePrivateReleaseIdentity({ app, metadata });
    expect(values.userData).toBe(path.join(directory, "Markie Super-nightly")); expect(fs.readFileSync(path.join(stable, "keep"), "utf8")).toBe("stable");
  });
});

describe("private runtime integration wiring", () => {
  const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
  it("denies protected main IPC before its handler can read or mutate", async () => {
    const { gate } = fixture(), registered = new Map<string, (...args: unknown[]) => unknown>();
    const handler = vi.fn(() => ({ ok: true }));
    const context = { baseHandle: (channel: string, fn: (...args: unknown[]) => unknown) => registered.set(channel, fn), privateRelease: gate, privateReleaseConfig: {}, currentCloseSender: () => true, handler };
    vm.runInNewContext(`${source.slice(source.indexOf("const handle = (channel, fn, options)"), source.indexOf('handle("private-release-status"'))}\nhandle("document-files:write", handler);`, context);
    expect(await registered.get("document-files:write")!({})).toMatchObject({ ok: false, code: "private-release-locked" }); expect(handler).not.toHaveBeenCalled();
    await gate.authorize("synthetic-token"); expect(await registered.get("document-files:write")!({})).toEqual({ ok: true }); expect(handler).toHaveBeenCalledOnce();
  });
  it("configures only the private generic provider without stable/beta fallback", async () => {
    const { gate } = fixture(); await gate.authorize("synthetic-token");
    const autoUpdater = { setFeedURL: vi.fn(), requestHeaders: {}, channel: "", allowDowngrade: true, allowPrerelease: false, disableDifferentialDownload: false };
    const publicFallback = vi.fn(() => { throw new Error("Public update fallback is forbidden"); });
    const script = source.slice(source.indexOf("function applyUpdateChannel()"), source.indexOf('// IPC: renderer asks for the latest known update status'));
    vm.runInNewContext(`${script}\napplyUpdateChannel();`, { isDesktopPreview: false, privateReleaseConfig: {}, privateRelease: gate, autoUpdater, readBetaOptIn: publicFallback });
    expect(publicFallback).not.toHaveBeenCalled(); expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(gate.updaterSettings());
    expect(autoUpdater.channel).toBe("super-nightly"); expect(autoUpdater.allowDowngrade).toBe(false); expect(autoUpdater.disableDifferentialDownload).toBe(true);
  });
  it("places private identity and authority before native source and updater consumers", () => {
    const identity = source.indexOf("initializePrivateReleaseIdentity({ app");
    for (const consumer of ['require("electron-updater")', 'require("./registry")', "crashReporter.start("]) expect(identity).toBeLessThan(source.indexOf(consumer));
    expect(source).toContain('const isDev = !privateReleaseConfig && !isDesktopPreview');
    expect(source).toContain('if (!privateRelease.authorized()) return new Response(');
    expect(source).toContain('autoUpdater.autoInstallOnAppQuit = !privateReleaseConfig');
    expect(source).toContain('autoUpdater.netSession.webRequest.onBeforeRequest');
    expect(source).toContain('Private builds cannot switch to stable or beta updates.');
    expect(source).toContain('autoUpdater.logger = privateReleaseConfig ? null');
  });
  // One server only: servers.json would widen the trusted origins, the CSP
  // and markie://doc routing, and a share link naming any other host is
  // ignored rather than asked about.
  it("keeps a private build off every server but its own", () => {
    expect(source).toContain('file: privateReleaseConfig ? null : path.join(app.getPath("userData"), "servers.json")');
    expect(source).toContain("trustedOnly: !!privateReleaseConfig");
    const store = source.indexOf("const serverStore = createServerStore(");
    expect(store).toBeGreaterThan(-1);
    expect(store).toBeLessThan(source.indexOf("setTrustedOrigins(() => serverStore.origins())"));
  });
  it.each([false, true])("shows native preflight windows without activating them (preflight %s)", (preflightMode) => {
    let ready!: () => void;
    const mainWindow = { once: (_name: string, callback: () => void) => { ready = callback; }, show: vi.fn(), showInactive: vi.fn() };
    const start = source.indexOf('  mainWindow.once("ready-to-show"'), end = source.indexOf("  // Browse: re-scan", start);
    vm.runInNewContext(source.slice(start, end), { mainWindow, process: { env: {} }, preflightMode }); ready();
    expect(mainWindow.show).toHaveBeenCalledTimes(preflightMode ? 0 : 1); expect(mainWindow.showInactive).toHaveBeenCalledTimes(preflightMode ? 1 : 0);
  });
});

describe("locked private packaging preflight", () => {
  function preflightFixture() {
    const { userData: root } = fixture();
    const temporaryDirectory = path.join(root, "tmp"), appData = path.join(root, "appData"), home = path.join(root, "home");
    const stable = path.join(appData, "Markie");
    for (const directory of [temporaryDirectory, stable, home]) fs.mkdirSync(directory, { recursive: true });
    const profile = fs.mkdtempSync(path.join(temporaryDirectory, "markie-preflight-"));
    const paths: Record<string, string> = { appData, home, userData: stable };
    const app = { getPath: (name: string) => paths[name], setPath: (name: string, value: string) => { paths[name] = value; } };
    return { root, temporaryDirectory, appData, stable, profile, paths, app };
  }
  it("preserves only the real isolated preflight profile and leaves owner/stable profiles untouched", () => {
    const f = preflightFixture(); fs.writeFileSync(path.join(f.stable, "keep"), "stable");
    const config = initializePrivateReleaseIdentity({ app: f.app, metadata, argv: [`--user-data-dir=${f.profile}`], env: { MARKIE_PREFLIGHT: "1" }, temporaryDirectory: f.temporaryDirectory });
    expect(f.paths.userData).toBe(f.profile); expect(f.paths.sessionData).toBe(path.join(f.profile, "session"));
    expect(fs.existsSync(path.join(f.appData, "Markie Super-nightly"))).toBe(false); expect(fs.readFileSync(path.join(f.stable, "keep"), "utf8")).toBe("stable");
    expect(fs.existsSync(path.join(f.profile, "preflight-ready"))).toBe(false);
    const gate = createPrivateReleaseGate({ config, userData: f.profile, safeStorage: null }); expect(gate.authorized()).toBe(false); expect(gate.allows("get-initial-file")).toBe(false);
  });
  it("rejects missing, arbitrary, nested and symlinked overrides without falling back to the owner profile", () => {
    const f = preflightFixture(), nested = path.join(f.profile, "markie-preflight-ABC123"), alias = path.join(f.temporaryDirectory, "markie-preflight-DEF456");
    fs.mkdirSync(nested); fs.symlinkSync(f.stable, alias, "dir");
    for (const candidate of [null, f.stable, nested, alias]) {
      expect(() => initializePrivateReleaseIdentity({ app: f.app, metadata, argv: candidate ? [`--user-data-dir=${candidate}`] : [], env: { MARKIE_PREFLIGHT: "1" }, temporaryDirectory: f.temporaryDirectory })).toThrow("isolated");
    }
    expect(f.paths.userData).toBe(f.stable); expect(fs.existsSync(path.join(f.appData, "Markie Super-nightly"))).toBe(false);
  });
  it("ignores user-data overrides for an ordinary private launch", () => {
    const f = preflightFixture(); initializePrivateReleaseIdentity({ app: f.app, metadata, argv: [`--user-data-dir=${f.profile}`], env: {}, temporaryDirectory: f.temporaryDirectory });
    expect(f.paths.userData).toBe(path.join(f.appData, "Markie Super-nightly")); expect(fs.readdirSync(f.profile)).toEqual([]);
  });
  it("writes readiness only from the trusted rendered private status handshake, without unlocking", async () => {
    const f = preflightFixture(), config = privateReleaseConfig(metadata), gate = createPrivateReleaseGate({ config, userData: f.profile, safeStorage: null });
    const handlers = new Map<string, () => unknown>();
    const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const status = source.slice(source.indexOf('handle("private-release-status"'), source.indexOf('handle("private-release-session"'));
    vm.runInNewContext(status, { handle: (channel: string, fn: () => unknown) => handlers.set(channel, fn), writePrivatePreflightReady: (options: object) => writePrivatePreflightReady({ ...options, temporaryDirectory: f.temporaryDirectory } as Parameters<typeof writePrivatePreflightReady>[0]), privateReleaseConfig: config, preflightMode: true, app: { getPath: () => f.profile }, privateRelease: gate });
    expect(fs.existsSync(path.join(f.profile, "preflight-ready"))).toBe(false);
    expect(await handlers.get("private-release-status")!()).toMatchObject({ required: true, authorized: false });
    expect(fs.readFileSync(path.join(f.profile, "preflight-ready"), "utf8")).toBe("1"); expect(gate.allows("document-files:read")).toBe(false);
    expect(writePrivatePreflightReady({ config, preflight: false, userData: f.profile, temporaryDirectory: f.temporaryDirectory })).toBe(false);
    expect(writePrivatePreflightReady({ config: null, preflight: true, userData: f.profile, temporaryDirectory: f.temporaryDirectory })).toBe(false);
    expect(writePrivatePreflightReady({ config, preflight: true, userData: f.stable, temporaryDirectory: f.temporaryDirectory })).toBe(false);
    expect(isPrivatePreflightProfile(f.profile, { temporaryDirectory: f.temporaryDirectory })).toBe(true);
  });
  it("never follows an existing readiness symlink or rewrites a hardlinked/oversized leaf", () => {
    const f = preflightFixture(), target = path.join(f.root, "outside-marker"), marker = path.join(f.profile, "preflight-ready");
    const options = { config: privateReleaseConfig(metadata), preflight: true, userData: f.profile, temporaryDirectory: f.temporaryDirectory };
    fs.writeFileSync(target, "outside-original"); fs.symlinkSync(target, marker);
    expect(writePrivatePreflightReady(options)).toBe(false); expect(fs.readFileSync(target, "utf8")).toBe("outside-original"); fs.unlinkSync(marker);
    fs.writeFileSync(target, "1"); fs.linkSync(target, marker);
    expect(writePrivatePreflightReady(options)).toBe(false); expect(fs.readFileSync(target, "utf8")).toBe("1"); fs.unlinkSync(marker);
    fs.writeFileSync(marker, "11"); expect(writePrivatePreflightReady(options)).toBe(false); expect(fs.readFileSync(marker, "utf8")).toBe("11"); fs.unlinkSync(marker);
    fs.writeFileSync(marker, "0"); expect(writePrivatePreflightReady(options)).toBe(false); expect(fs.readFileSync(marker, "utf8")).toBe("0"); fs.unlinkSync(marker);
    expect(writePrivatePreflightReady(options)).toBe(true);
    const before = fs.statSync(marker); expect(writePrivatePreflightReady(options)).toBe(true); const after = fs.statSync(marker);
    expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs); expect(fs.readFileSync(marker, "utf8")).toBe("1");
  });
});
