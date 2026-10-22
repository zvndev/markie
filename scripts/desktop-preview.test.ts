import { describe, expect, it } from "vitest";
import { previewBuildEnv, previewTarget } from "./desktop-preview.mjs";
import { thinMachOArch, installMacPreviewNative } from "./install-macos-preview-native.mjs";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
describe("desktop-first preview packaging", () => {
  it("separates identity, protocol, outputs, feeds, signing and notarization", () => {
    // The preview targets macOS and Windows only, so a Linux CI host names one.
    const host = { platform: process.env.MARKIE_PREVIEW_PLATFORM, arch: process.env.MARKIE_PREVIEW_ARCH };
    if (!["darwin", "win32"].includes(process.platform)) { process.env.MARKIE_PREVIEW_PLATFORM = "darwin"; process.env.MARKIE_PREVIEW_ARCH = "arm64"; }
    let config;
    try { config = require("../electron-builder.preview.cjs"); } finally {
      if (host.platform === undefined) delete process.env.MARKIE_PREVIEW_PLATFORM; else process.env.MARKIE_PREVIEW_PLATFORM = host.platform;
      if (host.arch === undefined) delete process.env.MARKIE_PREVIEW_ARCH; else process.env.MARKIE_PREVIEW_ARCH = host.arch;
    }
    expect(config.appId).toBe("com.zvn.markie.preview"); expect(config.productName).toBe("Markie Preview");
    expect(config.extraMetadata.name).toBe("markie-preview"); expect(config.extraMetadata.markieDesktopPreview).toBe(true);
    expect(config.publish).toBeNull(); expect(config.win.publish).toBeNull(); expect(config.mac.publish).toBeNull();
    expect(config.protocols).toEqual([]); expect(config.fileAssociations).toEqual([]);
    expect(config.mac.identity).toBe("-"); expect(config.mac.notarize).toBe(false); expect(config.win.signAndEditExecutable).toBe(false);
    expect(config.npmRebuild).toBe(false); expect(config.directories.output).toContain(".desktop-preview");
    expect(config.extraMetadata.markiePreviewProvenance.gitCommit).toMatch(/^[a-f0-9]{40}$/);
  });
  it("cannot pass publishing/signing credentials to the preview builder", () => {
    const env = previewBuildEnv({ APPLE_API_KEY: "secret", AZURE_CLIENT_SECRET: "secret", WIN_CSC_LINK: "secret", CSC_LINK: "secret", GH_TOKEN: "secret", MARKIE_WINDOWS_SIGNING: "azure", PATH: "local", CSC_IDENTITY_AUTO_DISCOVERY: "true" });
    expect(env).toEqual({ PATH: "local", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });
  it("uses concrete native targets and refuses browser or unsupported artifact targets", () => {
    expect(previewTarget(undefined, { platform: "win32", arch: "x64" }).id).toBe("windows-x64");
    expect(previewTarget(undefined, { platform: "darwin", arch: "arm64" }).id).toBe("mac-arm64");
    expect(previewTarget(undefined, { platform: "darwin", arch: "x64" }).id).toBe("mac-x64");
    expect(previewTarget("mac-arm64")).toMatchObject({ platform: "darwin", arch: "arm64", executable: "Markie Preview.app" });
    expect(previewTarget("mac-x64")).toMatchObject({ platform: "darwin", arch: "x64" });
    expect(previewTarget("windows-x64")).toMatchObject({ platform: "win32", arch: "x64", executable: "Markie Preview.exe" });
    expect(() => previewTarget("web")).toThrow(); expect(() => previewTarget("windows-arm64")).toThrow();
  });
  it("checks the target architecture of thin Mach-O native modules", () => {
    const header = Buffer.alloc(8); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(0x100000c, 4);
    expect(thinMachOArch(header)).toBe("arm64"); header.writeUInt32LE(0x1000007, 4); expect(thinMachOArch(header)).toBe("x64");
    expect(thinMachOArch(Buffer.from("MZ"))).toBeNull(); header.writeUInt32LE(0, 4); expect(thinMachOArch(header)).toBeNull();
  });
  it("labels the native input digest as pre-sign instead of claiming signed bytes", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "markie-preview-receipt-test-"));
    try {
      const projectDir = path.join(temporary, "project"), appDir = path.join(temporary, "Markie Preview.app");
      const put = (file: string, data: string | Buffer) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
      const binding = Buffer.alloc(8); binding.writeUInt32LE(0xfeedfacf); binding.writeUInt32LE(0x100000c, 4);
      put(path.join(projectDir, "node_modules/electron/package.json"), JSON.stringify({ version: "41.0.2" }));
      put(path.join(projectDir, "node_modules/better-sqlite3/package.json"), JSON.stringify({ version: "12.10.0" }));
      for (const name of ["pty.node", "spawn-helper"]) put(path.join(projectDir, "node_modules/node-pty/prebuilds/darwin-arm64", name), binding);
      put(path.join(appDir, "Contents/Resources/app.asar"), "synthetic");
      const spawn = ((_command: string, _args: string[], options: { cwd: string }) => { put(path.join(options.cwd, "build/Release/better_sqlite3.node"), binding); return { status: 0 }; }) as unknown as typeof import("node:child_process").spawnSync;
      installMacPreviewNative({ appDir, arch: "arm64", projectDir, spawn });
      const receipt = JSON.parse(readFileSync(path.join(appDir, "Contents/Resources/macos-native-prebuild.json"), "utf8"));
      expect(receipt).toMatchObject({ hashPhase: "before-code-signing", preSignSha256: createHash("sha256").update(binding).digest("hex"), arch: "arm64" });
      expect(receipt).not.toHaveProperty("sha256");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
