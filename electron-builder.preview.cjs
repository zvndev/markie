/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const base = require("./electron-builder.config.cjs");

const platform = process.env.MARKIE_PREVIEW_PLATFORM || process.platform;
const arch = process.env.MARKIE_PREVIEW_ARCH || process.arch;
if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch) || (platform === "win32" && arch !== "x64")) throw new Error("Unsupported desktop preview target.");
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: __dirname, encoding: "utf8", timeout: 5000 }).trim();
const gitDirty = execFileSync("git", ["status", "--porcelain"], { cwd: __dirname, encoding: "utf8", timeout: 5000 }).trim().length > 0;
const provenance = { schemaVersion: 1, gitCommit, gitDirty, builtAt: new Date().toISOString(), platform, arch };
const { publish: _publish, signtoolOptions: _signing, azureSignOptions: _azure, ...windows } = base.win;
void _publish; void _signing; void _azure;

module.exports = {
  ...base,
  appId: "com.zvn.markie.preview",
  productName: "Markie Preview",
  extraMetadata: { name: "markie-preview", markieDesktopPreview: true, markiePreviewProvenance: provenance },
  directories: { ...base.directories, output: process.env.MARKIE_PREVIEW_OUTPUT || path.join(__dirname, ".desktop-preview", "packages") },
  npmRebuild: false,
  forceCodeSigning: false,
  publish: null,
  protocols: [],
  fileAssociations: [],
  // Apple Silicon needs a sealed local bundle. '-' is ad-hoc only: no
  // Developer ID certificate, keychain identity or notarization is used.
  mac: { ...base.mac, identity: "-", notarize: false, publish: null, target: [{ target: "dir", arch: [arch] }] },
  dmg: { ...base.dmg, sign: false },
  win: { ...windows, signAndEditExecutable: false, publish: null, target: [{ target: "dir", arch: ["x64"] }] },
  async afterPack(context) {
    if (context.electronPlatformName !== platform) throw new Error("Preview platform and artifact provenance do not match.");
    if (platform === "win32") {
      const { installWindowsBetterSqlitePrebuild } = await import(pathToFileURL(path.join(__dirname, "scripts/install-win-native-prebuild.mjs")).href);
      installWindowsBetterSqlitePrebuild({ appDir: context.appOutDir });
      const { verifyWindowsPreview } = await import(pathToFileURL(path.join(__dirname, "scripts/verify-windows-preview.mjs")).href);
      const result = verifyWindowsPreview({ appDir: context.appOutDir, productName: "Markie Preview", expectedProvenance: provenance });
      if (!result.ok) throw new Error(result.failures.join("\n"));
    } else {
      const { installMacPreviewNative } = await import(pathToFileURL(path.join(__dirname, "scripts/install-macos-preview-native.mjs")).href);
      installMacPreviewNative({ appDir: path.join(context.appOutDir, "Markie Preview.app"), arch });
    }
  },
};
