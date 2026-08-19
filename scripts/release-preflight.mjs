import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

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
  "electron-builder.config.cjs",
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
  "scripts/desktop-launch-smoke.mjs",
  "scripts/windows-launch-smoke.mjs",
  "scripts/release.mjs",
  ".github/workflows/windows-launch-smoke.yml",
  "electron/csp.js",
  "electron/main.js",
  "electron/update-policy.js",
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
  ["electron:smoke:mac:launch", "scripts/desktop-launch-smoke.mjs", ["--platform mac", "--arch arm64"]],
  ["electron:smoke:win:launch", "scripts/windows-launch-smoke.mjs", []],
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
  ".autoloop/runs/windows-launch-smoke-*/screenshot.png",
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
  'const { buildAppCsp } = require("./csp");',
  'const { desktopUpdatePolicy, shouldSetupAutoUpdate } = require("./update-policy");',
  'let updateState = "idle"',
  "let manualUpdateCheck = false",
  "async function requestUpdateCheck",
  'requestUpdateCheck({ manual = false } = {})',
  "desktopUpdatePolicy({",
  "return { ok: false, reason: policy.reason };",
  "shouldSetupAutoUpdate({ isDev, isPackaged: app.isPackaged, platform: process.platform })",
  "autoUpdater.checkForUpdates()",
  'buttons: ["Restart & Update", "Later"]',
  "autoUpdater.quitAndInstall()",
  'ipcMain.handle("check-for-updates", () => requestUpdateCheck({ manual: true }))',
  'label: "Check for Updates…"',
  'const csp = buildAppCsp(path.join(__dirname, "../out"));',
  "...(isDev ? [{ type: \"separator\" }, { role: \"toggleDevTools\" }] : [])",
];

// electron-builder copies every *production* dependency into the app bundle,
// and it works that out from package.json, not from the `files` glob. So this
// list is the app's real payload budget: only modules the Electron main process
// require()s at runtime belong in `dependencies`. Everything the renderer
// imports is already inlined into out/ by `next build`, so listing it here
// ships a second raw copy of it. That mistake is what made the macOS DMG 209MB
// for a 6.5MB renderer.
const MAIN_PROCESS_RUNTIME_DEPENDENCIES = ["better-sqlite3", "electron-updater", "node-pty"];

// Packaged .app layouts electron-builder writes for macOS, checked when they
// happen to be present. Preflight never packages anything itself.
const PACKAGED_APP_DIRS = ["dist/mac-arm64/Markie.app", "dist/mac/Markie.app"];

// The arm64 .app measures 286 MiB once only the main-process runtime ships, and
// 270 MiB of that is the Electron framework itself. 330 MiB leaves room for an
// Electron upgrade while still catching a renderer package sneaking back into
// `dependencies`: that regression cost 305 MiB on its own.
const PACKAGED_APP_BUDGET_BYTES = 330 * 1024 * 1024;

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
  "npm run electron:smoke:mac:launch",
  "npm run electron:smoke:win:launch",
  "screenshot.png",
  "npm run release:preflight",
  'npm run release:version -- "$MARKIE_RELEASE_VERSION"',
  "npm run release:prepare:mac",
  "regenerates DMG blockmaps and updater hashes after stapling",
  'npm run release:publish:mac -- --confirm-public-release="$MARKIE_RELEASE_VERSION"',
  'npm run release:verify:public -- --version="$MARKIE_RELEASE_VERSION" --deep',
  'npm run release:rollback:mac -- --confirm-rollback="$MARKIE_RELEASE_VERSION"',
  "https://markie.zvndev.com/download/latest.json",
  "uploads `latest-mac.yml` last",
  "Check for Updates",
  "Windows and Linux update checks are disabled",
  "--publish never",
  "does **not** mean an artifact is signed, notarized, published",
];

const readJson = (rootDir, relativePath) =>
  JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));

const readBuilderConfig = (rootDir) => {
  const configPath = path.join(rootDir, "electron-builder.config.cjs");
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);

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
  const builder = readBuilderConfig(rootDir);

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
  assert(builder.appId === "com.zvn.markie", "electron-builder appId must be com.zvn.markie");
  assert(builder.productName === "Markie", "electron-builder productName must be Markie");
  assert(builder.afterPack === "build/preflight.cjs", "electron-builder afterPack must keep the app smoke gate");
  assert(builder.mac?.notarize === true, "release config must keep notarization enabled");
  assert(builder.dmg?.sign === true, "release config must sign DMG containers before notarization");
  assert(builder.win?.icon === "build/icon.ico", "Windows build config must use the generated .ico icon");
  assert(builder.linux?.icon === "build/icons", "Linux build config must use the generated PNG icon set");
  assert(Array.isArray(builder.publish) && builder.publish.length > 0, "release config must define a publish target");
  assert(mcp.version === pkg.version, "mcp/package.json version must match package.json");
  const plugin = readJson(rootDir, "mcp/.claude-plugin/plugin.json");
  assert(plugin.version === pkg.version, "mcp/.claude-plugin/plugin.json version must match package.json");
  const mcpSource = readFileSync(path.join(rootDir, "mcp/markie-mcp.mjs"), "utf8");
  assert(
    !/serverInfo:\s*\{[^}]*version:\s*"/.test(mcpSource),
    "mcp/markie-mcp.mjs must read its version from package.json, not hardcode it"
  );
  assert(mcp.private === true, "MCP package must stay private in this repo");
  assert(server.private === true, "server package must stay private");
  assert(pkg.scripts?.["electron:release"] === "node scripts/release.mjs publish mac", "electron:release must use the guarded release runner");
  assert(Boolean(pkg.scripts?.["release:preflight"]), "release:preflight script must be documented in package.json");
  assert(Boolean(pkg.scripts?.["release:prepare:mac"]), "release:prepare:mac script is required");
  assert(Boolean(pkg.scripts?.["release:publish:mac"]), "release:publish:mac script is required");

  return {
    version: pkg.version,
    appId: builder.appId,
    productName: builder.productName,
  };
}

export function validateReleaseManifest(rootDir) {
  const manifest = readJson(rootDir, "server/download-manifest.json");
  const builder = readBuilderConfig(rootDir);
  const publicSource = readFileSync(path.join(rootDir, "server/src/public.ts"), "utf8");
  const dockerfile = readFileSync(path.join(rootDir, "server/Dockerfile"), "utf8");
  const mac = manifest.platforms?.find(
    (platform) => platform.id === "mac-arm64" && platform.status === "public"
  );
  const publish = builder.publish?.[0];

  assert(manifest.schemaVersion === 2, "release manifest schemaVersion must be 2");
  assert(manifest.channel === "stable", "release manifest channel must be stable");
  assert(manifest.siteUrl === "https://markie.zvndev.com", "release manifest must own the canonical site URL");
  assert(manifest.latestManifestRoute === "/download/latest.json", "release manifest must own the latest JSON route");
  assert(manifest.storage?.provider === "s3", "release storage provider must be s3");
  assert(Boolean(manifest.storage?.bucket), "release storage bucket is required");
  assert(Boolean(manifest.storage?.endpoint), "release storage endpoint is required");
  assert(Boolean(manifest.storage?.region), "release storage region is required");
  assert(Boolean(manifest.storage?.publicBaseUrl), "release public storage base is required");
  assert(mac?.feed?.path === "mac/latest-mac.yml", "public macOS feed path must remain canonical");
  // The beta channel is opt-in from inside the app and must stay unlisted. The
  // website and the share emails render from `platforms`, so a beta entry
  // appearing there is the exact failure this guards: a build we intend to be
  // able to withdraw becoming something the public was told to download.
  assert(
    !manifest.platforms?.some((platform) => String(platform.id).includes("beta")),
    "beta builds must never appear as a platform entry"
  );
  assert(
    manifest.betaChannel?.feed?.path === "mac/beta-mac.yml",
    "beta feed path must remain canonical"
  );
  assert(
    manifest.betaChannel?.feed?.path !== mac?.feed?.path,
    "beta and stable must not share a feed file"
  );
  assert(publish?.provider === manifest.storage.provider, "builder provider must come from the release manifest");
  assert(publish?.bucket === manifest.storage.bucket, "builder bucket must come from the release manifest");
  assert(publish?.endpoint === manifest.storage.endpoint, "builder endpoint must come from the release manifest");
  assert(publish?.region === manifest.storage.region, "builder region must come from the release manifest");
  assert(publish?.path === "mac", "builder publish path must match the macOS feed directory");
  assert(publicSource.includes("downloadManifest.latestManifestRoute"), "server must expose the manifest-backed latest JSON route");
  assert(publicSource.includes('publicShare.get("/download/latest"'), "server must expose the stable latest human route");
  assert(dockerfile.includes("COPY download-manifest.json ./download-manifest.json"), "server image must include the release manifest");

  return {
    channel: manifest.channel,
    siteUrl: manifest.siteUrl,
    latestManifestRoute: manifest.latestManifestRoute,
    feedPath: mac.feed.path,
    bucket: manifest.storage.bucket,
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
  const builder = readBuilderConfig(rootDir);
  const scripts = pkg.scripts ?? {};

  for (const name of REQUIRED_PACK_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing local packaging script: ${name}`);
    assert(script.includes("scripts/local-electron-builder.mjs"), `${name} must use unsigned local electron-builder wrapper`);
    assert(script.includes("--config electron-builder.config.cjs"), `${name} must use the canonical builder config`);
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
    assert(script.includes("--config electron-builder.config.cjs"), `${name} must use the canonical builder config`);
    assert(script.includes("--publish never"), `${name} must disable publishing`);
  }
  for (const [name, platformFlag, archFlag] of REQUIRED_SMOKE_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing package smoke script: ${name}`);
    assert(script.includes("scripts/package-smoke.mjs"), `${name} must use the package smoke checker`);
    assert(script.includes(platformFlag), `${name} must target ${platformFlag}`);
    assert(script.includes(archFlag), `${name} must target ${archFlag}`);
  }
  for (const [name, scriptPath, requiredSnippets] of REQUIRED_HOST_SMOKE_SCRIPTS) {
    const script = scripts[name];
    assert(Boolean(script), `missing host launch smoke script: ${name}`);
    assert(script.includes(scriptPath), `${name} must use ${scriptPath}`);
    for (const snippet of requiredSnippets) {
      assert(script.includes(snippet), `${name} must include ${snippet}`);
    }
  }

  assert(hasTarget(builder.mac, "dmg", "arm64"), "macOS matrix must include arm64 dmg");
  assert(hasTarget(builder.mac, "zip", "arm64"), "macOS matrix must include arm64 zip");
  assert(hasTarget(builder.mac, "dmg", "x64"), "macOS matrix must include Intel x64 dmg");
  assert(hasTarget(builder.mac, "zip", "x64"), "macOS matrix must include Intel x64 zip");
  assert(hasTarget(builder.win, "nsis", "x64"), "Windows matrix must include x64 nsis");
  assert(hasTarget(builder.win, "zip", "x64"), "Windows matrix must include x64 zip");
  assert(hasTarget(builder.linux, "AppImage", "x64"), "Linux matrix must include x64 AppImage");
  assert(hasTarget(builder.linux, "deb", "x64"), "Linux matrix must include x64 deb");

  return {
    mac: listTargetEntries(builder.mac),
    win: listTargetEntries(builder.win),
    linux: listTargetEntries(builder.linux),
    scripts: [
      ...REQUIRED_PACK_SCRIPTS,
      ...REQUIRED_BUILD_SCRIPTS,
      ...REQUIRED_SMOKE_SCRIPTS.map(([name]) => name),
      ...REQUIRED_HOST_SMOKE_SCRIPTS.map(([name]) => name),
    ],
  };
}

export function validateRuntimeDependencies(rootDir, options = {}) {
  const dependencies =
    options.dependencies ?? readJson(rootDir, "package.json").dependencies ?? {};
  const runtime = [...(options.runtime ?? MAIN_PROCESS_RUNTIME_DEPENDENCIES)].sort();
  const declared = Object.keys(dependencies).sort();

  const unexpected = declared.filter((name) => !runtime.includes(name));
  assert(
    unexpected.length === 0,
    `package.json dependencies must stay limited to the Electron main-process runtime ` +
      `(${runtime.join(", ")}), but also lists ${unexpected.join(", ")}. ` +
      `electron-builder copies every production dependency into the shipped app on top of the ` +
      `files glob, so a renderer package here ships as raw node_modules alongside the copy ` +
      `next build already inlined into out/. Move it to devDependencies.`
  );

  const missing = runtime.filter((name) => !declared.includes(name));
  assert(
    missing.length === 0,
    `package.json dependencies is missing main-process runtime module(s): ${missing.join(", ")}. ` +
      `electron/*.js require()s them at runtime and electron-builder only bundles production ` +
      `dependencies, so a demoted module ships a broken app that crashes on launch.`
  );

  return { runtime, declared };
}

export function validateShippedFileGlobs(rootDir, files) {
  const globs = files ?? readBuilderConfig(rootDir).files;
  assert(Array.isArray(globs), "electron-builder config must declare a files array");
  assert(
    globs.some((glob) => glob.startsWith("!") && glob.includes(".test.")),
    `electron-builder files must exclude test files from the shipped app; ` +
      `electron/*.test.ts sits beside the modules it covers and "electron/**/*" ships it ` +
      `verbatim into a user's app bundle. Add a "!electron/**/*.test.*" negation.`
  );
  return globs;
}

// Walks without following symlinks: an .app bundle points Frameworks/*/Versions/Current
// at Versions/A, so following links counts the Electron framework three times over.
export function measureDirectoryBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else total += statSync(full).size;
    }
  }
  return total;
}

export function validatePackagedAppSize(rootDir, options = {}) {
  const appDirs = options.appDirs ?? PACKAGED_APP_DIRS;
  const budgetBytes = options.budgetBytes ?? PACKAGED_APP_BUDGET_BYTES;
  const measure = options.measure ?? measureDirectoryBytes;

  const apps = appDirs
    .filter((appDir) => existsSync(path.join(rootDir, appDir)))
    .map((appDir) => ({ appDir, bytes: measure(path.join(rootDir, appDir)) }));

  const oversized = apps.filter((app) => app.bytes > budgetBytes);
  assert(
    oversized.length === 0,
    oversized
      .map(
        (app) =>
          `${app.appDir} is ${mib(app.bytes)} MiB, which exceeds the packaged app size budget ` +
          `of ${mib(budgetBytes)} MiB.`
      )
      .join(" ") +
      ` Look at package.json "dependencies" first: electron-builder ships every production ` +
      `dependency into Contents/Resources/app.asar (and app.asar.unpacked for native ones), ` +
      `so one renderer package pulls its whole tree in. Break the bundle down with ` +
      `du -sh <app>/Contents/Resources/*. If the growth is really Electron itself, raise ` +
      `PACKAGED_APP_BUDGET_BYTES in scripts/release-preflight.mjs deliberately.`
  );

  return { checked: apps.length > 0, apps, budgetBytes };
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
  const manifest = validateReleaseManifest(resolvedRoot);
  const files = validateRequiredFiles(resolvedRoot);
  const runtimeDependencies = validateRuntimeDependencies(resolvedRoot);
  const shippedGlobs = validateShippedFileGlobs(resolvedRoot);
  const packagedSize = validatePackagedAppSize(resolvedRoot);
  const matrix = validatePackagingMatrix(resolvedRoot);
  const windowsWorkflow = validateWindowsLaunchWorkflow(resolvedRoot);
  const electronMain = validateElectronMainDesktopSupport(resolvedRoot);
  const docs = validateReleaseDocs(resolvedRoot);
  const inspected = assertLocalOnlyChecks(resolvedRoot);

  console.log(`[release:preflight] metadata ok: Markie ${metadata.version} (${metadata.appId})`);
  console.log(`[release:preflight] stable channel ok: ${manifest.siteUrl}${manifest.latestManifestRoute}`);
  console.log(`[release:preflight] required files ok: ${files.length} files`);
  console.log(
    `[release:preflight] app payload ok: dependencies=${runtimeDependencies.declared.join(", ")}; ` +
      `shipped globs=${shippedGlobs.join(" ")}`
  );
  if (packagedSize.checked) {
    for (const app of packagedSize.apps) {
      console.log(
        `[release:preflight] packaged size ok: ${app.appDir} ${mib(app.bytes)} MiB ` +
          `(budget ${mib(packagedSize.budgetBytes)} MiB)`
      );
    }
  } else {
    console.log(
      `[release:preflight] packaged size not checked: no packed app in dist/ ` +
        `(run npm run electron:pack:mac:arm64 to measure against the ` +
        `${mib(packagedSize.budgetBytes)} MiB budget)`
    );
  }
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
  return {
    metadata,
    manifest,
    files,
    runtimeDependencies,
    shippedGlobs,
    packagedSize,
    matrix,
    windowsWorkflow,
    electronMain,
    docs,
    inspected,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    runReleasePreflight();
  } catch (error) {
    console.error(`[release:preflight] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
