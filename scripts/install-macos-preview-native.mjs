import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function thinMachOArch(bytes) {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) return null;
  return ({ 0x100000c: "arm64", 0x1000007: "x64" })[bytes.readUInt32LE(4)] ?? null;
}
function assertArch(file, arch) { if (thinMachOArch(readFileSync(file)) !== arch) throw new Error(`Native preview file is not Mach-O ${arch}: ${file}`); }

/** Installs only into the new app bundle, never the project's host modules. */
export function installMacPreviewNative({ appDir, arch, projectDir = project, spawn = spawnSync } = {}) {
  if (!["arm64", "x64"].includes(arch) || !path.isAbsolute(appDir ?? "") || !appDir.endsWith("Markie Preview.app") || !existsSync(path.join(appDir, "Contents/Resources/app.asar"))) throw new Error("A packaged Markie Preview macOS target is required.");
  const version = JSON.parse(readFileSync(path.join(projectDir, "node_modules/electron/package.json"), "utf8")).version;
  const sqlite = path.join(projectDir, "node_modules/better-sqlite3");
  const pkg = JSON.parse(readFileSync(path.join(sqlite, "package.json"), "utf8"));
  const unpacked = path.join(appDir, "Contents/Resources/app.asar.unpacked/node_modules");
  const temporary = mkdtempSync(path.join(tmpdir(), "markie-preview-native-"));
  try {
    copyFileSync(path.join(sqlite, "package.json"), path.join(temporary, "package.json"));
    const result = spawn(path.join(projectDir, "node_modules/.bin/prebuild-install"), ["--runtime", "electron", "--target", version, "--platform", "darwin", "--arch", arch], { cwd: temporary, stdio: "inherit", timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`macOS SQLite prebuild installation failed (${result.status}).`);
    const downloaded = path.join(temporary, "build/Release/better_sqlite3.node");
    assertArch(downloaded, arch);
    const destination = path.join(unpacked, "better-sqlite3/build/Release/better_sqlite3.node");
    mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(downloaded, destination);
    for (const filename of ["pty.node", "spawn-helper"]) {
      const source = path.join(projectDir, `node_modules/node-pty/prebuilds/darwin-${arch}`, filename);
      assertArch(source, arch);
      const target = path.join(unpacked, "node-pty/build/Release", filename);
      mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target);
      if (filename === "spawn-helper") chmodSync(target, 0o755);
    }
    writeFileSync(path.join(appDir, "Contents/Resources/macos-native-prebuild.json"), JSON.stringify({ schemaVersion: 1, electronVersion: version, moduleVersion: pkg.version, platform: "darwin", arch, sha256: createHash("sha256").update(readFileSync(destination)).digest("hex") }, null, 2));
    console.log(`[preview-native] verified Electron ${version} darwin-${arch} native modules in bundle`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
