import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertWindowsX64Image } from "./lib/windows-pe.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetPlatform = "win32";
const targetArch = "x64";

function readJson(projectDir, relativePath) {
  return JSON.parse(readFileSync(path.join(projectDir, relativePath), "utf8"));
}

function electronVersion(projectDir) {
  const electronPkg = readJson(projectDir, "node_modules/electron/package.json");
  return electronPkg.version;
}

function prebuildInstallBin(projectDir) {
  const bin = process.platform === "win32" ? "prebuild-install.cmd" : "prebuild-install";
  return path.join(projectDir, "node_modules", ".bin", bin);
}

/**
 * @param {{projectDir?: string, appDir?: string, version?: string,
 * runPrebuild?: (command: string, args: string[], options: {cwd: string, stdio: "inherit", shell: boolean}) => {status: number | null, error?: Error}}} [options]
 */
export function installWindowsBetterSqlitePrebuild({
  projectDir = rootDir,
  appDir = path.join(projectDir, "dist", "win-unpacked"),
  version = electronVersion(projectDir),
  runPrebuild = spawnSync,
} = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error("invalid Electron target version");
  const sourcePackage = path.join(projectDir, "node_modules", "better-sqlite3");
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

    const result = runPrebuild(
      prebuildInstallBin(projectDir),
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
    assertWindowsX64Image(downloaded);

    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(downloaded, destination);
    assertWindowsX64Image(destination);

    // The PE machine proves the OS/CPU, not the Electron ABI. Keep the exact
    // prebuild-install target and installed hash beside the artifact so a
    // structural preview verifier can audit both without executing it.
    const receipt = {
      schemaVersion: 1,
      module: "better-sqlite3",
      moduleVersion: readJson(projectDir, "node_modules/better-sqlite3/package.json").version,
      electronVersion: version,
      platform: targetPlatform,
      arch: targetArch,
      sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
    };
    writeFileSync(path.join(appDir, "resources", "windows-native-prebuild.json"), `${JSON.stringify(receipt, null, 2)}\n`);

    console.log(`[win-native] installed Electron ${version} ${targetPlatform}-${targetArch} better-sqlite3 prebuild`);
    console.log(`[win-native] ${path.relative(projectDir, destination)}`);
    return destination;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    installWindowsBetterSqlitePrebuild();
  } catch (error) {
    console.error(`[win-native] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
