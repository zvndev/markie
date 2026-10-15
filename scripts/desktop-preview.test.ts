import { describe, expect, it } from "vitest";
import { previewBuildEnv, previewTarget } from "./desktop-preview.mjs";
import { thinMachOArch } from "./install-macos-preview-native.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
describe("desktop-first preview packaging", () => {
  it("separates identity, protocol, outputs, feeds, signing and notarization", () => {
    const config = require("../electron-builder.preview.cjs");
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
});
