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
  "build/icon.ico",
  "build/icons/256x256.png",
  "build/icons/512x512.png",
  "public/icon.icns",
  "scripts/local-electron-builder.mjs",
  "scripts/restore-host-native-prebuild.mjs",
  "scripts/install-win-native-prebuild.mjs",
  "scripts/package-smoke.mjs",
  "scripts/windows-launch-smoke.mjs",
  ".github/workflows/windows-launch-smoke.yml",
  "electron/main.js",
  "electron/preload.js",
  "mcp/markie-mcp.mjs",
  "mcp/lib.mjs",
  "mcp/package.json",
  "server/package.json",
  "server/download-manifest.json",
];

const LOCAL_CHECKS = [
  { label: "renderer/electron tests", command: "npm", args: ["test"], script: "test" },
  { label: "MCP tests", command: "node", args: ["--test", "mcp/lib.test.mjs"] },
  { label: "server tests", command: "npm", args: ["test"], cwd: "server", packagePath: "server/package.json", script: "test" },
  { label: "lint", command: "npm", args: ["run", "lint"], script: "lint" },
  { label: "static build", command: "npm", args: ["run", "build"], script: "build" },
];

const REQUIRED_PACK_SCRIPTS = [
  "electron:pack:mac:arm64",
  "electron:pack:mac:x64",
  "electron:pack:win",
  "electron:pack:linux",
];

const REQUIRED_BUILD_SCRIPTS = [
  "electron:build:mac",
  "electron:build:win",
  "electron:build:linux",
];

const REQUIRED_SMOKE_SCRIPTS = [
  ["electron:smoke:mac:arm64", "--platform mac", "--arch arm64"],
  ["electron:smoke:mac:x64", "--platform mac", "--arch x64"],
  ["electron:smoke:win", "--platform windows", "--arch x64"],
  ["electron:smoke:linux", "--platform linux", "--arch x64"],
];

const REQUIRED_HOST_SMOKE_SCRIPTS = [
  ["electron:smoke:win:launch", "scripts/windows-launch-smoke.mjs"],
];

const REQUIRED_WINDOWS_WORKFLOW_SNIPPETS = [
  "workflow_dispatch:",
  "push:",
  "branches:",
  "- main",
  "pull_request:",
  "windows-latest",
  "npm ci",
  "npm run electron:pack:win",
  "npm run electron:smoke:win",
  "npm run electron:smoke:win:launch",
  "actions/upload-artifact@v4",
  ".autoloop/runs/windows-launch-smoke-*/launch-smoke.json",
];

const REQUIRED_WINDOWS_WORKFLOW_PATHS = [
  ".github/workflows/windows-launch-smoke.yml",
  "build/**",
  "electron/**",
  "mcp/**",
  "out/**",
  "public/**",
  "scripts/**",
  "src/**",
  "package.json",
  "package-lock.json",
];

const REQUIRED_ELECTRON_MAIN_SNIPPETS = [
  'let updateState = "idle"',
  "let manualUpdateCheck = false",
  "async function requestUpdateCheck",
  'requestUpdateCheck({ manual = false } = {})',
  'return { ok: false, reason: "dev" }',
  "autoUpdater.checkForUpdates()",
  'buttons: ["Restart & Update", "Later"]',
  "autoUpdater.quitAndInstall()",
  'ipcMain.handle("check-for-updates", () => requestUpdateCheck({ manual: true }))',
  'label: "Check for Updates…"',
  "...(isDev ? [{ type: \"separator\" }, { role: \"toggleDevTools\" }] : [])",
];

const REQUIRED_RELEASE_DOC_SNIPPETS = [
  "Per-platform local artifact contract",
  "npm run electron:pack:mac:arm64",
  "npm run electron:pack:mac:x64",
  "npm run electron:pack:win",
  "npm run electron:pack:linux",
  "npm run electron:build:mac",
  "npm run electron:build:win",
  "npm run electron:build:linux",
  "Markie-<version>-arm64.dmg",
  "Markie-<version>-x64.exe",
  "Markie-<version>-x64.AppImage",
  "npm run electron:smoke:win:launch",
  "npm run release:preflight",
  "--publish never",
  "does **not** mean an artifact is\nsigned, notarized, published, uploaded, deployed, or approved",
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
  assert(!/Apple Silicon/i.test(pkg.description), "package.json description must not claim Apple-Silicon-only support");
  assert(Boolean(pkg.author), "package.json author is required");
  assert(Boolean(pkg.license), "package.json license is required");
  assert(Boolean(pkg.homepage), "package.json homepage is required");
  assert(Boolean(pkg.repository?.url), "package.json repository.url is required");
  assert(pkg.main === "electron/main.js", "package.json main must point at Electron main");
  assert(pkg.build?.appId === "com.zvn.markie", "electron-builder appId must be com.zvn.markie");
  assert(pkg.build?.productName === "Markie", "electron-builder productName must be Markie");
  assert(pkg.build?.afterPack === "build/preflight.cjs", "electron-builder afterPack must keep the app smoke gate");
  assert(pkg.build?.mac?.notarize === true, "release config must keep notarization enabled");
  assert(pkg.build?.win?.icon === "build/icon.ico", "Windows build config must use the generated .ico icon");
  assert(pkg.build?.linux?.icon === "build/icons", "Linux build config must use the generated PNG icon set");
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

function listTargetEntries(platformConfig) {
  const target = platformConfig?.target;
  if (!target) return [];
  const targets = Array.isArray(target) ? target : [target];
  return targets
    .map((entry) => {
      if (typeof entry === "string") {
        return { target: entry, arch: [] };
      }
      const arch = Array.isArray(entry.arch)
        ? entry.arch
        : entry.arch
          ? [entry.arch]
          : [];
      return { target: entry.target, arch };
    })
    .filter((entry) => entry.target);
}

function hasTarget(platformConfig, target, arch) {
  return listTargetEntries(platformConfig).some(
    (entry) => entry.target === target && entry.arch.includes(arch)
  );
}

export function validatePackagingMatrix(rootDir) {
  const pkg = readJson(rootDir, "package.json");
  const scripts = pkg.scripts ?? {};

  for (const name of REQUIRED_PACK_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing local packaging script: ${name}`);
    assert(script.includes("scripts/local-electron-builder.mjs"), `${name} must use unsigned local electron-builder wrapper`);
    assert(script.includes("--dir"), `${name} must be a local unpacked packaging script`);
    assert(script.includes("--publish never"), `${name} must disable publishing`);
    if (name === "electron:pack:win") {
      assert(script.includes("scripts/install-win-native-prebuild.mjs"), `${name} must install the Windows native prebuild`);
    }
  }
  for (const name of REQUIRED_BUILD_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing local build script: ${name}`);
    assert(script.includes("scripts/local-electron-builder.mjs"), `${name} must use unsigned local electron-builder wrapper`);
    assert(script.includes("--publish never"), `${name} must disable publishing`);
  }
  for (const [name, platformFlag, archFlag] of REQUIRED_SMOKE_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing package smoke script: ${name}`);
    assert(script.includes("scripts/package-smoke.mjs"), `${name} must use the package smoke checker`);
    assert(script.includes(platformFlag), `${name} must target ${platformFlag}`);
    assert(script.includes(archFlag), `${name} must target ${archFlag}`);
  }
  for (const [name, scriptPath] of REQUIRED_HOST_SMOKE_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing host launch smoke script: ${name}`);
    assert(script.includes(scriptPath), `${name} must use ${scriptPath}`);
  }

  assert(hasTarget(pkg.build?.mac, "dmg", "arm64"), "macOS matrix must include arm64 dmg");
  assert(hasTarget(pkg.build?.mac, "zip", "arm64"), "macOS matrix must include arm64 zip");
  assert(hasTarget(pkg.build?.mac, "dmg", "x64"), "macOS matrix must include Intel x64 dmg");
  assert(hasTarget(pkg.build?.mac, "zip", "x64"), "macOS matrix must include Intel x64 zip");
  assert(hasTarget(pkg.build?.win, "nsis", "x64"), "Windows matrix must include x64 nsis");
  assert(hasTarget(pkg.build?.win, "zip", "x64"), "Windows matrix must include x64 zip");
  assert(hasTarget(pkg.build?.linux, "AppImage", "x64"), "Linux matrix must include x64 AppImage");
  assert(hasTarget(pkg.build?.linux, "deb", "x64"), "Linux matrix must include x64 deb");

  return {
    mac: listTargetEntries(pkg.build.mac),
    win: listTargetEntries(pkg.build.win),
    linux: listTargetEntries(pkg.build.linux),
    scripts: [
      ...REQUIRED_PACK_SCRIPTS,
      ...REQUIRED_BUILD_SCRIPTS,
      ...REQUIRED_SMOKE_SCRIPTS.map(([name]) => name),
      ...REQUIRED_HOST_SMOKE_SCRIPTS.map(([name]) => name),
    ],
  };
}

export function validateRequiredFiles(rootDir, files = REQUIRED_FILES) {
  const missing = files.filter((file) => !existsSync(path.join(rootDir, file)));
  assert(missing.length === 0, `missing release prerequisite files: ${missing.join(", ")}`);
  return files;
}

export function validateWindowsLaunchWorkflow(
  rootDir,
  snippets = REQUIRED_WINDOWS_WORKFLOW_SNIPPETS,
  paths = REQUIRED_WINDOWS_WORKFLOW_PATHS
) {
  const workflow = readFileSync(
    path.join(rootDir, ".github/workflows/windows-launch-smoke.yml"),
    "utf8"
  );
  const missingSnippets = snippets.filter((snippet) => !workflow.includes(snippet));
  assert(
    missingSnippets.length === 0,
    `Windows launch workflow missing required snippets: ${missingSnippets.join(", ")}`
  );
  const missingPaths = paths.filter((snippet) => !workflow.includes(`- "${snippet}"`));
  assert(
    missingPaths.length === 0,
    `Windows launch workflow missing required path filters: ${missingPaths.join(", ")}`
  );
  assert(
    workflow.indexOf("push:") < workflow.indexOf("pull_request:"),
    "Windows launch workflow must keep a push trigger before pull_request for main-branch evidence"
  );
  return { snippets, paths };
}

export function validateElectronMainDesktopSupport(
  rootDir,
  snippets = REQUIRED_ELECTRON_MAIN_SNIPPETS
) {
  const main = readFileSync(path.join(rootDir, "electron/main.js"), "utf8");
  const missing = snippets.filter((snippet) => !main.includes(snippet));
  assert(
    missing.length === 0,
    `Electron main missing desktop-support snippets: ${missing.join(", ")}`
  );
  assert(
    main.indexOf("async function requestUpdateCheck") < main.indexOf("function setupAutoUpdate"),
    "manual update check helper must be defined before setupAutoUpdate"
  );
  assert(
    main.indexOf('ipcMain.handle("check-for-updates"') < main.indexOf("// IPC: user accepted the update"),
    "update check IPC must stay with the update IPC handlers"
  );
  return snippets;
}

export function validateReleaseDocs(
  rootDir,
  snippets = REQUIRED_RELEASE_DOC_SNIPPETS
) {
  const doc = readFileSync(path.join(rootDir, "docs/RELEASING.md"), "utf8");
  const missing = snippets.filter((snippet) => !doc.includes(snippet));
  assert(missing.length === 0, `release docs missing required snippets: ${missing.join(", ")}`);
  return snippets;
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
  const matrix = validatePackagingMatrix(resolvedRoot);
  const windowsWorkflow = validateWindowsLaunchWorkflow(resolvedRoot);
  const electronMain = validateElectronMainDesktopSupport(resolvedRoot);
  const docs = validateReleaseDocs(resolvedRoot);
  const inspected = assertLocalOnlyChecks(resolvedRoot);

  console.log(`[release:preflight] metadata ok: Markie ${metadata.version} (${metadata.appId})`);
  console.log(`[release:preflight] required files ok: ${files.length} files`);
  console.log(
    `[release:preflight] packaging matrix ok: mac=${matrix.mac.length} win=${matrix.win.length} linux=${matrix.linux.length}`
  );
  console.log(
    `[release:preflight] Windows launch workflow ok: ${windowsWorkflow.paths.length} watched paths`
  );
  console.log(`[release:preflight] Electron desktop support ok: ${electronMain.length} snippets`);
  console.log(`[release:preflight] release docs ok: ${docs.length} snippets`);
  console.log(`[release:preflight] local check plan ok: ${inspected.length} commands`);

  if (runLocalChecks) {
    for (const check of LOCAL_CHECKS) runCheck(resolvedRoot, check);
  }

  console.log("[release:preflight] passed; stop here before any credentialed release action");
  return { metadata, files, matrix, windowsWorkflow, electronMain, docs, inspected };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runReleasePreflight();
  } catch (error) {
    console.error(`[release:preflight] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
