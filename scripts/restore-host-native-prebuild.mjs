import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function electronVersion(root = rootDir) {
  return readJson(root, "node_modules/electron/package.json").version;
}

function prebuildInstallBin(root = rootDir) {
  const bin = process.platform === "win32" ? "prebuild-install.cmd" : "prebuild-install";
  return path.join(root, "node_modules", ".bin", bin);
}

function binaryKind(pathname) {
  const header = readFileSync(pathname, { flag: "r" }).subarray(0, 4);
  if (header[0] === 0x4d && header[1] === 0x5a) return "pe";
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return "elf";
  const hex = header.toString("hex");
  if (["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "cafebabf"].includes(hex)) return "macho";
  return "unknown";
}

function expectedBinaryKind(platform = process.platform) {
  if (platform === "darwin") return "macho";
  if (platform === "win32") return "pe";
  if (platform === "linux") return "elf";
  return null;
}

export function hostPrebuildArgs({
  version = electronVersion(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return ["--runtime", "electron", "--target", version, "--platform", platform, "--arch", arch];
}

export function restoreHostElectronNativePrebuild({
  root = rootDir,
  version = electronVersion(root),
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
  stdio = "inherit",
} = {}) {
  const packageDir = path.join(root, "node_modules", "better-sqlite3");
  const binary = path.join(packageDir, "build", "Release", "better_sqlite3.node");
  if (!existsSync(packageDir)) throw new Error(`better-sqlite3 is missing: ${packageDir}`);
  rmSync(path.join(packageDir, "build"), { recursive: true, force: true });

  const result = spawn(prebuildInstallBin(root), hostPrebuildArgs({ version, platform, arch }), {
    cwd: packageDir,
    stdio,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`prebuild-install failed with exit code ${result.status}`);
  if (!existsSync(binary)) throw new Error(`restored native module is missing: ${binary}`);

  const expected = expectedBinaryKind(platform);
  if (expected && binaryKind(binary) !== expected) {
    throw new Error(`restored better-sqlite3 native module is ${binaryKind(binary)}, expected ${expected}`);
  }

  console.log(`[host-native] restored Electron ${version} ${platform}-${arch} better-sqlite3 prebuild`);
  console.log(`[host-native] ${path.relative(root, binary)}`);
  return binary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    restoreHostElectronNativePrebuild();
  } catch (error) {
    console.error(`[host-native] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
