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
    return {
      id: `mac-${targetArch}`,
      platform: targetPlatform,
      arch: targetArch,
      appDir,
      executableCandidates: [path.join(appDir, "Contents", "MacOS", productName)],
      requiredFiles: [
        path.join(appDir, "Contents", "Info.plist"),
        path.join(appDir, "Contents", "Resources", "app.asar"),
        path.join(appDir, "Contents", "Resources", "mcp", "markie-mcp.mjs"),
        path.join(appDir, "Contents", "Resources", "mcp", "lib.mjs"),
        path.join(appDir, "Contents", "Resources", "mcp", "scan.mjs"),
        path.join(appDir, "Contents", "Resources", "mcp", "package.json"),
      ],
    };
  }

  if (targetArch !== "x64") {
    throw new Error(`${targetPlatform} package smoke currently supports x64 artifacts only`);
  }

  if (targetPlatform === "windows") {
    const appDir = path.join(distDir, "win-unpacked");
    return {
      id: "windows-x64",
      platform: targetPlatform,
      arch: targetArch,
      appDir,
      executableCandidates: [path.join(appDir, `${productName}.exe`)],
      requiredFiles: [
        path.join(appDir, "resources", "app.asar"),
        path.join(appDir, "resources", "mcp", "markie-mcp.mjs"),
        path.join(appDir, "resources", "mcp", "lib.mjs"),
        path.join(appDir, "resources", "mcp", "scan.mjs"),
        path.join(appDir, "resources", "mcp", "package.json"),
      ],
    };
  }

  const appDir = path.join(distDir, "linux-unpacked");
  return {
    id: "linux-x64",
    platform: targetPlatform,
    arch: targetArch,
    appDir,
    executableCandidates: [path.join(appDir, "markie"), path.join(appDir, productName)],
    requiredFiles: [
      path.join(appDir, "resources", "app.asar"),
      path.join(appDir, "resources", "mcp", "markie-mcp.mjs"),
      path.join(appDir, "resources", "mcp", "lib.mjs"),
      path.join(appDir, "resources", "mcp", "scan.mjs"),
      path.join(appDir, "resources", "mcp", "package.json"),
    ],
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

  return {
    ok: missing.length === 0,
    profile,
    missing,
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
    }
  }

  if (!result.ok) process.exitCode = 1;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runPackageSmokeCli();
  } catch (error) {
    console.error(`[package:smoke] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
