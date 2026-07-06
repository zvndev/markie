import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRODUCT_NAME = "Markie";

const PLATFORM_ALIASES = new Map([
  ["darwin", "mac"],
  ["mac", "mac"],
  ["macos", "mac"],
  ["win32", "windows"],
  ["win", "windows"],
  ["windows", "windows"],
  ["linux", "linux"],
]);

const ARCH_ALIASES = new Map([
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
  ["x64", "x64"],
  ["x86_64", "x64"],
  ["amd64", "x64"],
]);

function normalizePlatform(value) {
  const normalized = PLATFORM_ALIASES.get(String(value || "").toLowerCase());
  if (!normalized) throw new Error(`unsupported package platform: ${value}`);
  return normalized;
}

function normalizeArch(value) {
  const normalized = ARCH_ALIASES.get(String(value || "").toLowerCase());
  if (!normalized) throw new Error(`unsupported package arch: ${value}`);
  return normalized;
}

function macOutputDir(arch) {
  return arch === "arm64" ? "mac-arm64" : "mac";
}

function executableMode(pathname) {
  try {
    return (statSync(pathname).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readProductName(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
    return pkg.build?.productName || DEFAULT_PRODUCT_NAME;
  } catch {
    return DEFAULT_PRODUCT_NAME;
  }
}

function nativeModuleFiles(resourcesDir, platform, arch) {
  const files = [
    path.join(resourcesDir, "app.asar.unpacked", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  ];
  if (platform === "windows") {
    const ptyDir = path.join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", `win32-${arch}`);
    files.push(
      path.join(ptyDir, "pty.node"),
      path.join(ptyDir, "conpty.node"),
      path.join(ptyDir, "conpty_console_list.node")
    );
  } else {
    files.push(path.join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "pty.node"));
  }
  return files;
}

function binaryChecksFor(files, kind) {
  return files.map((file) => ({ file, kind }));
}

function binaryKind(pathname) {
  const header = readFileSync(pathname, { flag: "r" }).subarray(0, 4);
  if (header.length < 2) return "unknown";
  if (header[0] === 0x4d && header[1] === 0x5a) return "pe";
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return "elf";
  const hex = header.toString("hex");
  if (["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "cafebabf"].includes(hex)) return "macho";
  return "unknown";
}

export function detectRosettaAvailable() {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false;
  const result = spawnSync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], {
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

export function packageProfile({
  platform = process.platform,
  arch = process.arch,
  distDir = "dist",
  productName = DEFAULT_PRODUCT_NAME,
} = {}) {
  const targetPlatform = normalizePlatform(platform);
  const targetArch = normalizeArch(arch);

  if (targetPlatform === "mac") {
    const appDir = path.join(distDir, macOutputDir(targetArch), `${productName}.app`);
    const resourcesDir = path.join(appDir, "Contents", "Resources");
    const executable = path.join(appDir, "Contents", "MacOS", productName);
    const nativeFiles = nativeModuleFiles(resourcesDir, targetPlatform, targetArch);
    return {
      id: `mac-${targetArch}`,
      platform: targetPlatform,
      arch: targetArch,
      appDir,
      executableCandidates: [executable],
      requiredFiles: [
        path.join(appDir, "Contents", "Info.plist"),
        path.join(resourcesDir, "app.asar"),
        path.join(resourcesDir, "mcp", "markie-mcp.mjs"),
        path.join(resourcesDir, "mcp", "lib.mjs"),
        path.join(resourcesDir, "mcp", "scan.mjs"),
        path.join(resourcesDir, "mcp", "package.json"),
        ...nativeFiles,
      ],
      binaryChecks: binaryChecksFor([executable, ...nativeFiles], "macho"),
    };
  }

  if (targetArch !== "x64") {
    throw new Error(`${targetPlatform} package smoke currently supports x64 artifacts only`);
  }

  if (targetPlatform === "windows") {
    const appDir = path.join(distDir, "win-unpacked");
    const resourcesDir = path.join(appDir, "resources");
    const executable = path.join(appDir, `${productName}.exe`);
    const nativeFiles = nativeModuleFiles(resourcesDir, targetPlatform, targetArch);
    return {
      id: "windows-x64",
      platform: targetPlatform,
      arch: targetArch,
      appDir,
      executableCandidates: [executable],
      requiredFiles: [
        path.join(resourcesDir, "app.asar"),
        path.join(resourcesDir, "mcp", "markie-mcp.mjs"),
        path.join(resourcesDir, "mcp", "lib.mjs"),
        path.join(resourcesDir, "mcp", "scan.mjs"),
        path.join(resourcesDir, "mcp", "package.json"),
        ...nativeFiles,
      ],
      binaryChecks: binaryChecksFor([executable, ...nativeFiles], "pe"),
    };
  }

  const appDir = path.join(distDir, "linux-unpacked");
  const resourcesDir = path.join(appDir, "resources");
  const executableCandidates = [path.join(appDir, "markie"), path.join(appDir, productName)];
  const nativeFiles = nativeModuleFiles(resourcesDir, targetPlatform, targetArch);
  return {
    id: "linux-x64",
    platform: targetPlatform,
    arch: targetArch,
    appDir,
    executableCandidates,
    requiredFiles: [
      path.join(resourcesDir, "app.asar"),
      path.join(resourcesDir, "mcp", "markie-mcp.mjs"),
      path.join(resourcesDir, "mcp", "lib.mjs"),
      path.join(resourcesDir, "mcp", "scan.mjs"),
      path.join(resourcesDir, "mcp", "package.json"),
      ...nativeFiles,
    ],
    binaryChecks: binaryChecksFor([...executableCandidates, ...nativeFiles], "elf"),
  };
}

export function hostSmokeMode(
  profile,
  host = { platform: process.platform, arch: process.arch, rosettaAvailable: detectRosettaAvailable() }
) {
  const hostPlatform = normalizePlatform(host.platform);
  const hostArch = normalizeArch(host.arch);
  if (profile.platform !== hostPlatform) {
    return {
      mode: "structure-only",
      reason: `host is ${hostPlatform}/${hostArch}; OS-level launch must run on ${profile.platform}/${profile.arch}`,
    };
  }
  if (profile.arch !== hostArch) {
    if (profile.platform === "mac" && profile.arch === "x64" && hostArch === "arm64" && host.rosettaAvailable) {
      return {
        mode: "host-compatible",
        reason: "Apple Silicon host can run Intel macOS artifacts through Rosetta",
      };
    }
    return {
      mode: "structure-only",
      reason: `host arch is ${hostArch}; OS-level launch should run on ${profile.platform}/${profile.arch}`,
    };
  }
  return {
    mode: "host-native",
    reason: `host matches ${profile.platform}/${profile.arch}`,
  };
}

export function verifyPackageLayout(rootDir, options = {}) {
  const productName = options.productName || readProductName(rootDir);
  const profile = packageProfile({ ...options, productName });
  const absoluteAppDir = path.join(rootDir, profile.appDir);
  const missing = [];

  if (!existsSync(absoluteAppDir) || !statSync(absoluteAppDir).isDirectory()) {
    missing.push(profile.appDir);
  }

  const executable = profile.executableCandidates.find((candidate) => existsSync(path.join(rootDir, candidate)));
  if (!executable) {
    missing.push(profile.executableCandidates.join(" or "));
  } else if (profile.platform !== "windows" && !executableMode(path.join(rootDir, executable))) {
    missing.push(`${executable} (not executable)`);
  }

  for (const file of profile.requiredFiles) {
    if (!existsSync(path.join(rootDir, file))) missing.push(file);
  }

  const binaryFailures = [];
  for (const check of profile.binaryChecks ?? []) {
    const absolutePath = path.join(rootDir, check.file);
    if (!existsSync(absolutePath)) continue;
    const actual = binaryKind(absolutePath);
    if (actual !== check.kind) {
      binaryFailures.push(`${check.file} (${actual}, expected ${check.kind})`);
    }
  }

  return {
    ok: missing.length === 0 && binaryFailures.length === 0,
    profile,
    missing,
    binaryFailures,
    executable,
    host: hostSmokeMode(profile),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--platform") parsed.platform = argv[++i];
    else if (arg === "--arch") parsed.arch = argv[++i];
    else if (arg === "--dist") parsed.distDir = argv[++i];
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function usage() {
  return [
    "Usage: node scripts/package-smoke.mjs [--platform mac|windows|linux] [--arch arm64|x64] [--dist dist]",
    "",
    "Examples:",
    "  node scripts/package-smoke.mjs",
    "  node scripts/package-smoke.mjs --platform mac --arch arm64",
    "  node scripts/package-smoke.mjs --platform windows --arch x64",
    "  node scripts/package-smoke.mjs --platform linux --arch x64",
  ].join("\n");
}

export function runPackageSmokeCli(argv = process.argv.slice(2), rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const result = verifyPackageLayout(rootDir, options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[package:smoke] checking ${result.profile.id}: ${result.profile.appDir}`);
    if (result.ok) {
      console.log(`[package:smoke] package layout ok; executable: ${result.executable}`);
      console.log(`[package:smoke] host mode: ${result.host.mode} (${result.host.reason})`);
    } else {
      console.error(`[package:smoke] missing package files for ${result.profile.id}:`);
      for (const item of result.missing) console.error(`  - ${item}`);
      for (const item of result.binaryFailures) console.error(`  - ${item}`);
    }
  }

  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    runPackageSmokeCli();
  } catch (error) {
    console.error(`[package:smoke] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
