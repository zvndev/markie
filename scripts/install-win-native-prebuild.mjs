import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetPlatform = "win32";
const targetArch = "x64";

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function electronVersion() {
  const electronPkg = readJson("node_modules/electron/package.json");
  return electronPkg.version;
}

function prebuildInstallBin() {
  const bin = process.platform === "win32" ? "prebuild-install.cmd" : "prebuild-install";
  return path.join(rootDir, "node_modules", ".bin", bin);
}

function isPeBinary(filePath) {
  const header = readFileSync(filePath).subarray(0, 2);
  return header[0] === 0x4d && header[1] === 0x5a;
}

export function installWindowsBetterSqlitePrebuild({
  appDir = path.join(rootDir, "dist", "win-unpacked"),
  version = electronVersion(),
} = {}) {
  const sourcePackage = path.join(rootDir, "node_modules", "better-sqlite3");
  const destination = path.join(
    appDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );

  if (!existsSync(appDir)) throw new Error(`Windows package output is missing: ${appDir}`);
  if (!existsSync(sourcePackage)) throw new Error(`better-sqlite3 is missing: ${sourcePackage}`);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "markie-win-native-"));
  const tempPackage = path.join(tempDir, "better-sqlite3");
  try {
    cpSync(sourcePackage, tempPackage, { recursive: true });
    rmSync(path.join(tempPackage, "build"), { recursive: true, force: true });

    const result = spawnSync(
      prebuildInstallBin(),
      ["--runtime", "electron", "--target", version, "--platform", targetPlatform, "--arch", targetArch],
      {
        cwd: tempPackage,
        stdio: "inherit",
        shell: process.platform === "win32",
      }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`prebuild-install failed with exit code ${result.status}`);

    const downloaded = path.join(tempPackage, "build", "Release", "better_sqlite3.node");
    if (!existsSync(downloaded)) throw new Error(`downloaded prebuild is missing: ${downloaded}`);
    if (!isPeBinary(downloaded)) throw new Error("downloaded better-sqlite3 prebuild is not a Windows PE binary");

    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(downloaded, destination);
    if (!isPeBinary(destination)) throw new Error("installed better-sqlite3 prebuild is not a Windows PE binary");

    console.log(`[win-native] installed Electron ${version} ${targetPlatform}-${targetArch} better-sqlite3 prebuild`);
    console.log(`[win-native] ${path.relative(rootDir, destination)}`);
    return destination;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    installWindowsBetterSqlitePrebuild();
  } catch (error) {
    console.error(`[win-native] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
