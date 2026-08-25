import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectRosettaAvailable,
  hostSmokeMode,
  packageProfile,
  verifyPackageLayout,
} from "../scripts/package-smoke.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "markie-package-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function writeFixtureFile(rootDir: string, relativePath: string, mode?: number, content: string | Buffer = "fixture") {
  const fullPath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  if (mode) chmodSync(fullPath, mode);
}

const machoHeader = Buffer.from("cffaedfe00000000", "hex");
const peHeader = Buffer.from("4d5a900000000000", "hex");

function writeMacFixture(rootDir: string, appDir: string) {
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

function writeWindowsFixture(rootDir: string, appDir: string, betterSqliteHeader = peHeader) {
  writeFixtureFile(rootDir, path.join(appDir, "Markie.exe"), undefined, peHeader);
  writeFixtureFile(rootDir, path.join(appDir, "resources", "app.asar"));
  writeFixtureFile(rootDir, path.join(appDir, "resources", "mcp", "markie-mcp.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "resources", "mcp", "lib.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "resources", "mcp", "scan.mjs"));
  writeFixtureFile(rootDir, path.join(appDir, "resources", "mcp", "package.json"));
  writeFixtureFile(
    rootDir,
    path.join(
      appDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node"
    ),
    undefined,
    betterSqliteHeader
  );
  for (const name of ["pty.node", "conpty.node", "conpty_console_list.node"]) {
    writeFixtureFile(
      rootDir,
      path.join(appDir, "resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64", name),
      undefined,
      peHeader
    );
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});


// packageProfile and hostSmokeMode normalise their inputs, so they accept
// electron-builder profile names ("mac", "windows") as well as Node's own.
// Their parameter types are inferred from `process.platform` defaults, which
// does not say that, so fixtures cross the boundary through these.
type ProfileTarget = NonNullable<Parameters<typeof packageProfile>[0]>;
const packageTarget = (o: {
  platform: string;
  arch: string;
  distDir?: string;
  productName?: string;
}): ProfileTarget => o as unknown as ProfileTarget;

type SmokeHost = Parameters<typeof hostSmokeMode>[1];
const smokeHost = (o: {
  platform: string;
  arch: string;
  rosettaAvailable?: boolean;
}): SmokeHost => o as unknown as SmokeHost;

describe("package smoke checker", () => {
  it("maps local package targets to electron-builder unpacked output paths", () => {
    expect(packageProfile(packageTarget({ platform: "darwin", arch: "arm64" }))).toMatchObject({
      id: "mac-arm64",
      appDir: path.join("dist", "mac-arm64", "Markie.app"),
    });
    expect(packageProfile(packageTarget({ platform: "mac", arch: "x64" }))).toMatchObject({
      id: "mac-x64",
      appDir: path.join("dist", "mac", "Markie.app"),
    });
    expect(packageProfile(packageTarget({ platform: "windows", arch: "x64" }))).toMatchObject({
      id: "windows-x64",
      appDir: path.join("dist", "win-unpacked"),
      executableCandidates: [path.join("dist", "win-unpacked", "Markie.exe")],
    });
    expect(packageProfile(packageTarget({ platform: "linux", arch: "x64" }))).toMatchObject({
      id: "linux-x64",
      appDir: path.join("dist", "linux-unpacked"),
    });
  });

  it("reports missing package structure with concrete relative paths", () => {
    const rootDir = makeTempDir();

    const result = verifyPackageLayout(rootDir, { platform: "mac", arch: "arm64" });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        path.join("dist", "mac-arm64", "Markie.app"),
        path.join("dist", "mac-arm64", "Markie.app", "Contents", "MacOS", "Markie"),
        path.join("dist", "mac-arm64", "Markie.app", "Contents", "Resources", "app.asar"),
        path.join("dist", "mac-arm64", "Markie.app", "Contents", "Resources", "mcp", "markie-mcp.mjs"),
        path.join(
          "dist",
          "mac-arm64",
          "Markie.app",
          "Contents",
          "Resources",
          "app.asar.unpacked",
          "node_modules",
          "better-sqlite3",
          "build",
          "Release",
          "better_sqlite3.node"
        ),
      ])
    );
  });

  it("rejects unsupported non-macOS package architectures", () => {
    expect(() => packageProfile(packageTarget({ platform: "windows", arch: "arm64" }))).toThrow(/supports x64/);
    expect(() => packageProfile(packageTarget({ platform: "linux", arch: "arm64" }))).toThrow(/supports x64/);
  });

  it("passes when a packaged macOS app has executable and bundled MCP resources", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "mac-arm64", "Markie.app");

    writeMacFixture(rootDir, appDir);

    const result = verifyPackageLayout(rootDir, { platform: "mac", arch: "arm64" });

    expect(result.ok).toBe(true);
    expect(result.executable).toBe(path.join(appDir, "Contents", "MacOS", "Markie"));
    expect(result.missing).toEqual([]);
    expect(result.binaryFailures).toEqual([]);
  });

  it("requires Windows native modules and PE binaries", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "win-unpacked");

    writeWindowsFixture(rootDir, appDir);

    const result = verifyPackageLayout(rootDir, { platform: "windows", arch: "x64" });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.binaryFailures).toEqual([]);
  });

  it("rejects Windows artifacts that contain non-PE native payloads", () => {
    const rootDir = makeTempDir();
    const appDir = path.join("dist", "win-unpacked");

    writeWindowsFixture(rootDir, appDir, machoHeader);

    const result = verifyPackageLayout(rootDir, { platform: "windows", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.binaryFailures).toEqual([
      path.join(
        appDir,
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node"
      ) + " (macho, expected pe)",
    ]);
  });

  it("separates structure-only smoke from host-native launch evidence", () => {
    const macArm = packageProfile(packageTarget({ platform: "mac", arch: "arm64" }));
    expect(hostSmokeMode(macArm, smokeHost({ platform: "darwin", arch: "arm64" }))).toMatchObject({
      mode: "host-native",
    });
    expect(hostSmokeMode(macArm, smokeHost({ platform: "windows", arch: "x64" }))).toMatchObject({
      mode: "structure-only",
    });
    expect(hostSmokeMode(macArm, smokeHost({ platform: "darwin", arch: "x64" }))).toMatchObject({
      mode: "structure-only",
    });
  });

  it("reports macOS Intel artifacts as host-compatible on Apple Silicon with Rosetta", () => {
    const macIntel = packageProfile(packageTarget({ platform: "mac", arch: "x64" }));

    expect(hostSmokeMode(macIntel, smokeHost({ platform: "darwin", arch: "arm64", rosettaAvailable: true }))).toMatchObject({
      mode: "host-compatible",
    });
    expect(hostSmokeMode(macIntel, smokeHost({ platform: "darwin", arch: "arm64", rosettaAvailable: false }))).toMatchObject({
      mode: "structure-only",
    });
    expect(typeof detectRosettaAvailable()).toBe("boolean");
  });
});
