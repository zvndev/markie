import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDesktopLaunchSmokeArtifact,
  resolveDesktopLaunchApp,
} from "../scripts/desktop-launch-smoke.mjs";

const tempDirs: string[] = [];
const machoHeader = Buffer.from("cffaedfe00000000", "hex");

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "markie-desktop-launch-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(rootDir: string, relativePath: string, mode?: number, content: string | Buffer = "fixture") {
  const fullPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  if (mode) chmodSync(fullPath, mode);
}

function writeMacFixture(rootDir: string, appDir: string) {
  writeFixtureFile(rootDir, "package.json", undefined, JSON.stringify({ name: "markie", version: "0.2.8" }));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "MacOS", "Markie"), 0o755, machoHeader);
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Info.plist"));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Resources", "app.asar"));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Resources", "mcp", "markie-mcp.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Resources", "mcp", "lib.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Resources", "mcp", "scan.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "Contents", "Resources", "mcp", "package.json"));
  writeFixtureFile(
    rootDir,
    path.join(
      appDir,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    undefined,
    machoHeader
  );
  writeFixtureFile(
    rootDir,
    path.join(appDir, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "pty.node"),
    undefined,
    machoHeader
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("desktop launch smoke", () => {
  it("resolves host-native mac packages to an executable launch target", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "mac-arm64", "Markie.app");
    writeMacFixture(rootDir, appDir);

    const app = resolveDesktopLaunchApp(rootDir, {
      platform: "mac",
      arch: "arm64",
      host: { platform: "darwin", arch: "arm64" },
    });

    expect(app).toMatchObject({
      profile: { id: "mac-arm64", platform: "mac", arch: "arm64" },
      host: { mode: "host-native" },
    });
    expect(app.appDir).toBe(path.join(rootDir, appDir));
    expect(app.executable).toBe(path.join(rootDir, appDir, "Contents", "MacOS", "Markie"));
  });

  it("rejects packages that can only be structurally checked on the current host", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "mac-arm64", "Markie.app");
    writeMacFixture(rootDir, appDir);

    expect(() =>
      resolveDesktopLaunchApp(rootDir, {
        platform: "mac",
        arch: "arm64",
        host: { platform: "win32", arch: "x64" },
      })
    ).toThrow(/OS-level launch must run on mac\/arm64/);
  });

  it("builds launch evidence with package, host, target, and renderer details", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "mac-arm64", "Markie.app");
    writeMacFixture(rootDir, appDir);
    const app = resolveDesktopLaunchApp(rootDir, {
      platform: "mac",
      arch: "arm64",
      host: { platform: "darwin", arch: "arm64" },
    });

    const artifact = buildDesktopLaunchSmokeArtifact({
      baseDir: rootDir,
      app,
      debugOrigin: "http://127.0.0.1:9224",
      target: { type: "page", title: "Markie", url: "app://markie/index.html" },
      probe: { title: "Markie", readyState: "complete", url: "app://markie/index.html", hasEditor: true },
      validation: { ok: true, failures: [] },
      generatedAt: "2026-07-05T00:00:00.000Z",
      platform: "darwin",
      arch: "arm64",
      versions: { node: "22.13.1", electron: "41.0.0", chrome: "140.0.0" },
    });

    expect(artifact).toMatchObject({
      ok: true,
      generatedAt: "2026-07-05T00:00:00.000Z",
      host: { platform: "darwin", arch: "arm64", node: "22.13.1" },
      package: {
        name: "markie",
        version: "0.2.8",
        productName: "Markie",
        distDir: "dist",
        profile: "mac-arm64",
        layout: path.join("dist", "mac-arm64", "Markie.app"),
      },
      app: {
        appDir: path.join(rootDir, appDir),
        executable: path.join(rootDir, appDir, "Contents", "MacOS", "Markie"),
        launchMode: { mode: "host-native" },
      },
      validation: { ok: true, failures: [] },
    });
  });
});
