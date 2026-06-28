import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FORBIDDEN_ACTIONS = [
  /\belectron-builder\b/i,
  /\b--publish\b/i,
  /\bpublish\b/i,
  /\bnotari[sz]e?\b/i,
  /\bnotarytool\b/i,
  /\bcodesign\b/i,
  /\bxcrun\b/i,
  /\bdeploy\b/i,
  /\brailway\b/i,
  /\baws\b/i,
  /\bs3\b/i,
];

const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "docs/RELEASING.md",
  "build/preflight.cjs",
  "build/entitlements.mac.plist",
  "public/icon.icns",
  "electron/main.js",
  "electron/preload.js",
  "mcp/markie-mcp.mjs",
  "mcp/lib.mjs",
  "mcp/package.json",
  "server/package.json",
];

const LOCAL_CHECKS = [
  { label: "renderer/electron tests", command: "npm", args: ["test"], script: "test" },
  { label: "MCP tests", command: "node", args: ["--test", "mcp/lib.test.mjs"] },
  { label: "server tests", command: "npm", args: ["test"], cwd: "server", packagePath: "server/package.json", script: "test" },
  { label: "lint", command: "npm", args: ["run", "lint"], script: "lint" },
  { label: "static build", command: "npm", args: ["run", "build"], script: "build" },
];

const readJson = (rootDir, relativePath) =>
  JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const scriptValue = (rootDir, check) => {
  if (!check.script) return `${check.command} ${check.args.join(" ")}`;
  const packagePath = check.packagePath || "package.json";
  const pkg = readJson(rootDir, packagePath);
  return pkg.scripts?.[check.script] || "";
};

export function commandLine(check) {
  return [check.command, ...check.args].join(" ");
}

export function assertLocalOnlyChecks(rootDir, checks = LOCAL_CHECKS) {
  const inspected = [];
  for (const check of checks) {
    const line = `${commandLine(check)} ${scriptValue(rootDir, check)}`.trim();
    inspected.push(line);
    const forbidden = FORBIDDEN_ACTIONS.find((pattern) => pattern.test(line));
    assert(
      !forbidden,
      `release preflight check "${check.label}" includes a forbidden release/deploy action: ${line}`
    );
  }
  return inspected;
}

export function validateReleaseMetadata(rootDir) {
  const pkg = readJson(rootDir, "package.json");
  const lock = readJson(rootDir, "package-lock.json");
  const mcp = readJson(rootDir, "mcp/package.json");
  const server = readJson(rootDir, "server/package.json");

  assert(pkg.name === "markie", "package.json name must be markie");
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), "package.json version must be semver-like");
  assert(lock.version === pkg.version, "package-lock.json version must match package.json");
  assert(lock.packages?.[""]?.version === pkg.version, "package-lock root package version must match package.json");
  assert(pkg.private === true, "root package must stay private; Markie is not npm-published");
  assert(Boolean(pkg.description), "package.json description is required");
  assert(Boolean(pkg.author), "package.json author is required");
  assert(Boolean(pkg.license), "package.json license is required");
  assert(Boolean(pkg.homepage), "package.json homepage is required");
  assert(Boolean(pkg.repository?.url), "package.json repository.url is required");
  assert(pkg.main === "electron/main.js", "package.json main must point at Electron main");
  assert(pkg.build?.appId === "com.zvn.markie", "electron-builder appId must be com.zvn.markie");
  assert(pkg.build?.productName === "Markie", "electron-builder productName must be Markie");
  assert(pkg.build?.afterPack === "build/preflight.cjs", "electron-builder afterPack must keep the app smoke gate");
  assert(pkg.build?.mac?.notarize === true, "release config must keep notarization enabled");
  assert(Array.isArray(pkg.build?.publish) && pkg.build.publish.length > 0, "release config must define a publish target");
  assert(mcp.version === pkg.version, "mcp/package.json version must match package.json");
  assert(mcp.private === true, "MCP package must stay private in this repo");
  assert(server.private === true, "server package must stay private");
  assert(Boolean(pkg.scripts?.["electron:release"]?.includes("--publish always")), "electron:release must remain the explicit publishing command");
  assert(Boolean(pkg.scripts?.["release:preflight"]), "release:preflight script must be documented in package.json");

  return {
    version: pkg.version,
    appId: pkg.build.appId,
    productName: pkg.build.productName,
  };
}

export function validateRequiredFiles(rootDir, files = REQUIRED_FILES) {
  const missing = files.filter((file) => !existsSync(path.join(rootDir, file)));
  assert(missing.length === 0, `missing release prerequisite files: ${missing.join(", ")}`);
  return files;
}

function runCheck(rootDir, check) {
  const cwd = path.join(rootDir, check.cwd || ".");
  console.log(`[release:preflight] ${check.label}: ${commandLine(check)}`);
  const result = spawnSync(check.command, check.args, {
    cwd,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  assert(result.status === 0, `${check.label} failed with exit code ${result.status ?? "unknown"}`);
}

export function runReleasePreflight({ rootDir, runLocalChecks = true } = {}) {
  const resolvedRoot = rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log("[release:preflight] local-only release preflight");
  console.log("[release:preflight] no signing, notarization, upload, publish, deploy, or credential checks will run");

  const metadata = validateReleaseMetadata(resolvedRoot);
  const files = validateRequiredFiles(resolvedRoot);
  const inspected = assertLocalOnlyChecks(resolvedRoot);

  console.log(`[release:preflight] metadata ok: Markie ${metadata.version} (${metadata.appId})`);
  console.log(`[release:preflight] required files ok: ${files.length} files`);
  console.log(`[release:preflight] local check plan ok: ${inspected.length} commands`);

  if (runLocalChecks) {
    for (const check of LOCAL_CHECKS) runCheck(resolvedRoot, check);
  }

  console.log("[release:preflight] passed; stop here before any credentialed release action");
  return { metadata, files, inspected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runReleasePreflight();
  } catch (error) {
    console.error(`[release:preflight] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
