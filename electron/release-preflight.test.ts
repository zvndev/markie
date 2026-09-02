import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalOnlyChecks,
  validatePackagedAppSize,
  validatePackagingMatrix,
  validateElectronMainDesktopSupport,
  validateReleaseDocs,
  validateReleaseManifest,
  validateReleaseMetadata,
  validateRequiredFiles,
  validateRuntimeDependencies,
  validateShippedFileGlobs,
  validateWindowsLaunchWorkflow,
} from "../scripts/release-preflight.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("release preflight", () => {
  it("keeps the beta channel out of the public platform list", () => {
    // validateReleaseManifest reads the real manifest, so this fails if anyone
    // ever promotes beta to something the download page can render.
    expect(() => validateReleaseManifest(rootDir)).not.toThrow();
  });

  it("checks release metadata and required local files without credentials", () => {
    expect(validateReleaseMetadata(rootDir)).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      appId: "com.zvn.markie",
      productName: "Markie",
    });

    expect(validateRequiredFiles(rootDir)).toEqual(
      expect.arrayContaining([
        "build/preflight.cjs",
        "build/entitlements.mac.plist",
        "build/icon.ico",
        "build/icons/256x256.png",
        "electron-builder.config.cjs",
        "scripts/install-win-native-prebuild.mjs",
        "scripts/local-electron-builder.mjs",
        "scripts/restore-host-native-prebuild.mjs",
        "scripts/package-smoke.mjs",
        "scripts/desktop-launch-smoke.mjs",
        "scripts/windows-launch-smoke.mjs",
        "scripts/release.mjs",
        ".github/workflows/windows-launch-smoke.yml",
        "electron/csp.js",
        "electron/update-policy.js",
        "public/icon.icns",
        "mcp/markie-mcp.mjs",
        "server/package.json",
        "server/download-manifest.json",
      ])
    );
  });

  it("keeps storage, updater feeds, and stable download routes in one manifest", () => {
    expect(validateReleaseManifest(rootDir)).toEqual({
      channel: "stable",
      siteUrl: "https://markie.zvndev.com",
      latestManifestRoute: "/download/latest.json",
      feedPath: "mac/latest-mac.yml",
      bucket: "markie-releases",
    });
  });

  it("validates the local desktop packaging matrix without publishing", () => {
    expect(validatePackagingMatrix(rootDir)).toMatchObject({
      scripts: expect.arrayContaining([
        "electron:pack:mac:arm64",
        "electron:pack:mac:x64",
        "electron:pack:win",
        "electron:pack:linux",
        "electron:build:mac",
        "electron:build:win",
        "electron:build:linux",
        "electron:smoke:mac:arm64",
        "electron:smoke:mac:launch",
        "electron:smoke:mac:x64",
        "electron:smoke:win",
        "electron:smoke:win:launch",
        "electron:smoke:linux",
      ]),
      mac: expect.arrayContaining([
        { target: "dmg", arch: expect.arrayContaining(["arm64", "x64"]) },
        { target: "zip", arch: expect.arrayContaining(["arm64", "x64"]) },
      ]),
      win: expect.arrayContaining([
        { target: "nsis", arch: expect.arrayContaining(["x64"]) },
        { target: "zip", arch: expect.arrayContaining(["x64"]) },
      ]),
      linux: expect.arrayContaining([
        { target: "AppImage", arch: expect.arrayContaining(["x64"]) },
        { target: "deb", arch: expect.arrayContaining(["x64"]) },
      ]),
    });
  });

  it("keeps release docs explicit about platform artifacts and local-only gates", () => {
    expect(validateReleaseDocs(rootDir)).toEqual(
      expect.arrayContaining([
        "Per-platform local artifact contract",
        "npm run electron:pack:mac:arm64",
        "npm run electron:pack:mac:x64",
        "npm run electron:pack:win",
        "npm run electron:pack:linux",
        "Markie-<version>-arm64.dmg",
        "Markie-<version>-x64.exe",
        "Markie-<version>-x64.AppImage",
        "npm run electron:smoke:mac:launch",
        "npm run electron:smoke:win:launch",
        "screenshot.png",
        "npm run release:prepare:mac",
        "regenerates DMG blockmaps and updater hashes after stapling",
        'npm run release:verify:public -- --version="$MARKIE_RELEASE_VERSION" --deep',
        "https://markie.zvndev.com/download/latest.json",
        "Check for Updates",
        // 0.5.0 turned the Windows updater on. The doc has to describe a
        // recurring release runbook now, not a platform waiting for approval.
        "## Windows release runbook",
        "npm run release:publish:win",
        "Linux update checks stay disabled",
        "--publish never",
      ])
    );
  });

  it("keeps the Windows launch workflow dispatchable and automatic on main", () => {
    expect(validateWindowsLaunchWorkflow(rootDir)).toEqual({
      snippets: expect.arrayContaining([
        "workflow_dispatch:",
        "push:",
        "pull_request:",
        "windows-latest",
        "npm run electron:pack:win",
        "npm run electron:smoke:win",
        "npm run electron:smoke:win:launch",
        ".autoloop/runs/windows-launch-smoke-*/screenshot.png",
      ]),
      paths: expect.arrayContaining([
        ".github/workflows/windows-launch-smoke.yml",
        "electron/**",
        "scripts/**",
        "src/**",
        "package.json",
        "package-lock.json",
      ]),
    });
  });

  it("keeps desktop update checks user-visible and packaged menus clean", () => {
    expect(validateElectronMainDesktopSupport(rootDir)).toEqual(
      expect.arrayContaining([
        'const { ASSET_SCHEME, buildAppCsp } = require("./csp");',
        'const { desktopUpdatePolicy, shouldSetupAutoUpdate } = require("./update-policy");',
        "async function requestUpdateCheck",
        "desktopUpdatePolicy({",
        "return { ok: false, reason: policy.reason };",
        "shouldSetupAutoUpdate({ isDev, isPackaged: app.isPackaged, platform: process.platform })",
        "autoUpdater.checkForUpdates()",
        'buttons: ["Restart & Update", "Later"]',
        'const csp = buildAppCsp(path.join(__dirname, "../out"));',
        'label: "Check for Updates…"',
        "...(isDev ? [{ type: \"separator\" }, { role: \"toggleDevTools\" }] : [])",
      ])
    );
  });

  it("ships only the Electron main process runtime as production dependencies", () => {
    expect(validateRuntimeDependencies(rootDir)).toEqual({
      runtime: ["better-sqlite3", "electron-updater", "node-pty"],
      declared: ["better-sqlite3", "electron-updater", "node-pty"],
    });
  });

  it("rejects a renderer-only package that leaks back into dependencies", () => {
    expect(() =>
      validateRuntimeDependencies(rootDir, {
        dependencies: {
          "better-sqlite3": "^12.10.0",
          "electron-updater": "^6.8.9",
          "node-pty": "^1.1.0",
          next: "16.1.7",
          react: "19.2.3",
        },
      })
    ).toThrow(/next, react/);
  });

  it("rejects a main-process runtime module demoted out of dependencies", () => {
    expect(() =>
      validateRuntimeDependencies(rootDir, {
        dependencies: { "electron-updater": "^6.8.9", "node-pty": "^1.1.0" },
      })
    ).toThrow(/better-sqlite3/);
  });

  it("skips the packaged size budget when nothing has been packaged yet", () => {
    expect(validatePackagedAppSize(rootDir, { appDirs: ["dist/nothing-packaged-here.app"] })).toEqual({
      checked: false,
      budgetBytes: expect.any(Number),
      apps: [],
    });
  });

  it("measures a packaged bundle against the size budget", () => {
    expect(
      validatePackagedAppSize(rootDir, { appDirs: ["electron"], budgetBytes: 64 * 1024 * 1024 })
    ).toMatchObject({
      checked: true,
      apps: [{ appDir: "electron", bytes: expect.any(Number) }],
    });
  });

  it("fails a packaged bundle that blows the size budget", () => {
    expect(() =>
      validatePackagedAppSize(rootDir, { appDirs: ["electron"], budgetBytes: 1024 })
    ).toThrow(/exceeds the packaged app size budget/);
  });

  it("keeps test files out of the shipped app bundle", () => {
    expect(validateShippedFileGlobs(rootDir)).toEqual(
      expect.arrayContaining(["electron/**/*", "out/**/*", "!electron/**/*.test.*"])
    );
  });

  it("rejects a files glob that would ship electron test files", () => {
    expect(() => validateShippedFileGlobs(rootDir, ["electron/**/*", "out/**/*"])).toThrow(
      /test files/
    );
  });

  it("runs only local test, lint, and build checks", () => {
    const inspected = assertLocalOnlyChecks(rootDir).join("\n");

    expect(inspected).toContain("npm test vitest run");
    expect(inspected).toContain("node --test mcp/lib.test.mjs");
    expect(inspected).toContain("npm run lint eslint");
    expect(inspected).toContain("npm run build next build");
    expect(inspected).not.toMatch(
      /\b(electron-builder|--publish|publish|notarize|notarytool|codesign|xcrun|deploy|railway|aws|s3)\b/i
    );
  });

  it("rejects accidental release or deploy actions in the local plan", () => {
    expect(() =>
      assertLocalOnlyChecks(rootDir, [
        {
          label: "bad release",
          command: "npm",
          args: ["run", "electron:release"],
          script: "electron:release",
        },
      ])
    ).toThrow(/forbidden release\/deploy action/);
  });
});
