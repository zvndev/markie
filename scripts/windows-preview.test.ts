import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { assertWindowsX64Image, readPeImage } from "./lib/windows-pe.mjs";
import { installWindowsBetterSqlitePrebuild } from "./install-win-native-prebuild.mjs";
import { parseWindowsPreviewArgs, verifyWindowsPreview } from "./verify-windows-preview.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const directories: string[] = [];
const provenance = { schemaVersion: 1, gitCommit: "1".repeat(40), builtAt: "2026-10-15T14:00:00.000Z", platform: "win32", arch: "x64" };

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "markie-windows-preview-test-"));
  directories.push(dir);
  return dir;
}

function write(root: string, name: string, content: string | Buffer = "fixture") {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function pe(machine = 0x8664, magic = 0x20b) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xf0, 0x94);
  bytes.writeUInt16LE(0x0002, 0x96);
  bytes.writeUInt16LE(magic, 0x98);
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  asar.uncacheAll();
});

describe("Windows image architecture validation", () => {
  it("checks PE signature and x64 machine rather than MZ alone", () => {
    const file = write(tempDir(), "native.node", pe());
    expect(assertWindowsX64Image(file)).toMatchObject({ machine: 0x8664, optionalMagic: 0x20b, sections: 1 });
  });

  it.each([[0xaa64, 0x20b], [0x14c, 0x10b], [0x8664, 0x10b]])("rejects wrong machine or optional header %i/%i", (machine, magic) => {
    expect(() => assertWindowsX64Image(write(tempDir(), "wrong.node", pe(machine, magic)))).toThrow("expected Windows x64");
  });

  it("rejects short MZ, missing PE signature and out-of-bounds pointers", () => {
    const dir = tempDir();
    expect(() => readPeImage(write(dir, "dos.exe", "MZ"))).toThrow("DOS MZ");
    const signature = pe();
    signature.writeUInt32LE(0, 0x80);
    expect(() => readPeImage(write(dir, "signature.exe", signature))).toThrow("PE signature");
    const pointer = pe();
    pointer.writeUInt32LE(0xffffffff, 0x3c);
    expect(() => readPeImage(write(dir, "pointer.exe", pointer))).toThrow("outside");
  });

  it("rejects truncated section tables, impossible section counts and non-images", () => {
    const dir = tempDir();
    expect(() => readPeImage(write(dir, "truncated.exe", pe().subarray(0, 200)))).toThrow("truncated");
    const sections = pe();
    sections.writeUInt16LE(97, 0x86);
    expect(() => readPeImage(write(dir, "sections.exe", sections))).toThrow("section count");
    const object = pe();
    object.writeUInt16LE(0, 0x96);
    expect(() => readPeImage(write(dir, "object.exe", object))).toThrow("not executable");
  });
});

function nativeProject() {
  const projectDir = tempDir();
  const appDir = path.join(projectDir, ".desktop-preview", "renamed-output");
  mkdirSync(appDir, { recursive: true });
  write(projectDir, "node_modules/electron/package.json", JSON.stringify({ version: "41.0.2" }));
  write(projectDir, "node_modules/better-sqlite3/package.json", JSON.stringify({ version: "12.10.0" }));
  write(projectDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", "host-native-unchanged");
  return { projectDir, appDir };
}

describe("isolated Windows SQLite prebuild installation", () => {
  it("targets installed Electron x64 in a temporary copy, preserves host bytes, and writes a hash receipt", () => {
    const fixture = nativeProject();
    const runPrebuild = vi.fn((_bin, args, options) => {
      expect(args).toEqual(["--runtime", "electron", "--target", "41.0.2", "--platform", "win32", "--arch", "x64"]);
      expect(options.cwd).not.toContain(fixture.projectDir);
      expect(existsSync(path.join(options.cwd, "build"))).toBe(false);
      write(options.cwd, "build/Release/better_sqlite3.node", pe());
      return { status: 0 };
    });
    const destination = installWindowsBetterSqlitePrebuild({ ...fixture, runPrebuild });
    expect(readFileSync(destination)).toEqual(pe());
    expect(readFileSync(path.join(fixture.projectDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("host-native-unchanged");
    expect(existsSync(runPrebuild.mock.calls[0][2].cwd)).toBe(false);
    const receipt = JSON.parse(readFileSync(path.join(fixture.appDir, "resources/windows-native-prebuild.json"), "utf8"));
    expect(receipt).toEqual({ schemaVersion: 1, module: "better-sqlite3", moduleVersion: "12.10.0", electronVersion: "41.0.2", platform: "win32", arch: "x64", sha256: createHash("sha256").update(pe()).digest("hex") });
  });

  it("rejects non-x64 downloads before replacing a packaged binding", () => {
    const fixture = nativeProject();
    const destination = write(fixture.appDir, "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node", "existing-packaged-binding");
    const runPrebuild = vi.fn((_bin, _args, options) => {
      write(options.cwd, "build/Release/better_sqlite3.node", pe(0xaa64));
      return { status: 0 };
    });
    expect(() => installWindowsBetterSqlitePrebuild({ ...fixture, runPrebuild })).toThrow("expected Windows x64");
    expect(readFileSync(destination, "utf8")).toBe("existing-packaged-binding");
    expect(existsSync(runPrebuild.mock.calls[0][2].cwd)).toBe(false);
    expect(existsSync(path.join(fixture.appDir, "resources/windows-native-prebuild.json"))).toBe(false);
  });

  it("fails closed and removes temporary download state on installer errors", () => {
    const fixture = nativeProject();
    const runPrebuild = vi.fn((_bin, _args, options) => {
      expect(options.cwd).toContain("markie-win-native-");
      return { status: 7 };
    });
    expect(() => installWindowsBetterSqlitePrebuild({ ...fixture, runPrebuild })).toThrow("exit code 7");
    expect(existsSync(runPrebuild.mock.calls[0][2].cwd)).toBe(false);
  });

  it("rejects invalid Electron targets before executing a downloader", () => {
    const fixture = nativeProject();
    const runPrebuild = vi.fn();
    expect(() => installWindowsBetterSqlitePrebuild({ ...fixture, version: "--anything", runPrebuild })).toThrow("invalid Electron");
    expect(runPrebuild).not.toHaveBeenCalled();
  });
});

async function previewFixture(options: { missing?: string; metadata?: Record<string, unknown>; manifest?: string[]; html?: string; native?: string; receipt?: Record<string, unknown> } = {}) {
  const root = tempDir();
  const appDir = path.join(root, "arbitrary-preview-dir");
  const source = path.join(root, "source");
  const assets = ["assets/index-test.js", "assets/index-test.css", "assets/docx-test.js", "assets/word-document-editor-test.js", "assets/document-workspace-host-test.js", "assets/legacy-doc.worker-test.js", "assets/vault-panel-test.js", "assets/document-import-test.js", "favicon.ico", "index.html"];
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "markie-preview", main: "electron/main.js", markieDesktopPreview: true, markiePreviewProvenance: provenance, ...options.metadata }),
    "electron/main.js": "main",
    "electron/preload.js": "preload",
    "node_modules/better-sqlite3/package.json": JSON.stringify({ version: "12.10.0" }),
    "out/index.html": options.html ?? '<script src="./assets/index-test.js"></script><link href="./assets/index-test.css"><link href="./favicon.ico">',
    "out/service-worker.js": `const FILES = ${JSON.stringify(options.manifest ?? assets)};\n`,
  };
  for (const name of ["index.js", "windowsPtyAgent.js", "windowsConoutConnection.js", "conpty_console_list_agent.js", "worker/conoutSocketWorker.js"]) files[`node_modules/node-pty/lib/${name}`] = "runtime";
  for (const name of assets) if (name !== "index.html") files[`out/${name}`] = "asset";
  for (const [name, bytes] of Object.entries(files)) if (name !== options.missing) write(source, name, bytes);
  mkdirSync(path.join(appDir, "resources"), { recursive: true });
  // createPackage resolves with out.end(), before the writable has flushed.
  // Reading the archive then races the final file payload under parallel load.
  const archiveStream = await asar.createPackage(source, path.join(appDir, "resources/app.asar"));
  await finished(archiveStream);
  expect(archiveStream.writableFinished).toBe(true);
  write(appDir, "Markie Preview.exe", options.native === "executable" ? pe(0xaa64) : pe());
  const sqlite = "resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
  write(appDir, sqlite, options.native === "sqlite" ? pe(0xaa64) : pe());
  for (const name of ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"]) {
    if (name !== options.missing) write(appDir, `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/${name}`, name === options.native ? pe(0xaa64) : pe());
  }
  for (const name of ["icudtl.dat", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak", "v8_context_snapshot.bin", "locales/en-US.pak"]) if (name !== options.missing) write(appDir, name);
  for (const name of ["markie-mcp.mjs", "lib.mjs", "scan.mjs", "package.json"]) write(appDir, `resources/mcp/${name}`);
  write(appDir, "resources/windows-native-prebuild.json", JSON.stringify({ schemaVersion: 1, module: "better-sqlite3", moduleVersion: "12.10.0", electronVersion: "41.0.2", platform: "win32", arch: "x64", sha256: createHash("sha256").update(pe()).digest("hex"), ...options.receipt }));
  return { appDir };
}

describe("Windows preview structural verifier", () => {
  it("verifies a renamed real ASAR without claiming an OS launch", async () => {
    const fixture = await previewFixture();
    const result = verifyWindowsPreview({ ...fixture, expectedProvenance: { gitCommit: provenance.gitCommit }, electronVersion: "41.0.2" });
    expect(result).toMatchObject({ ok: true, mode: "structure-only", rendererAssetCount: 10, provenance });
    expect(result.binaries).toHaveLength(9);
    expect(result.notTested[0]).toContain("Windows OS launch");
  });

  it.each(["winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe", "locales/en-US.pak", "out/assets/legacy-doc.worker-test.js", "node_modules/node-pty/lib/worker/conoutSocketWorker.js"])("rejects absent runtime sidecar or renderer worker %s", async (missing) => {
    const result = verifyWindowsPreview({ ...await previewFixture({ missing }), electronVersion: "41.0.2" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain(missing);
  });

  it.each(["executable", "sqlite", "conpty.node", "winpty.dll", "conpty/OpenConsole.exe"])("rejects incorrect PE architecture in %s", async (native) => {
    const result = verifyWindowsPreview({ ...await previewFixture({ native }), electronVersion: "41.0.2" });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("expected Windows x64");
  });

  it("requires the exact product executable and explicit preview metadata", async () => {
    const fixture = await previewFixture({ metadata: { name: "markie", markieDesktopPreview: false } });
    const result = verifyWindowsPreview({ ...fixture, productName: "Other Preview", electronVersion: "41.0.2" });
    expect(result.failures.join(" ")).toContain("Other Preview.exe");
    expect(result.failures.join(" ")).toContain("not explicitly marked");
  });

  it("rejects stale provenance and native ABI-target/hash receipts", async () => {
    const result = verifyWindowsPreview({ ...await previewFixture({ receipt: { electronVersion: "40.0.0", moduleVersion: "1.0.0", sha256: "0".repeat(64) } }), expectedProvenance: { gitCommit: "2".repeat(40) }, electronVersion: "41.0.2" });
    expect(result.failures.join(" ")).toContain("expected Electron target");
    expect(result.failures.join(" ")).toContain("receipt hash");
    expect(result.failures.join(" ")).toContain("receipt module version");
    expect(result.failures.join(" ")).toContain("provenance mismatch");
  });

  it("rejects missing provenance and preview updater feeds", async () => {
    const fixture = await previewFixture({ metadata: { markiePreviewProvenance: null } });
    write(fixture.appDir, "resources/app-update.yml", "url: https://markiedocs.com/stable");
    const result = verifyWindowsPreview({ ...fixture, electronVersion: "41.0.2" });
    expect(result.failures.join(" ")).toContain("updater feed");
    expect(result.failures.join(" ")).toContain("provenance is missing");
  });

  it("rejects non-ISO provenance timestamps", async () => {
    const fixture = await previewFixture({ metadata: { markiePreviewProvenance: { ...provenance, builtAt: "1" } } });
    expect(verifyWindowsPreview({ ...fixture, electronVersion: "41.0.2" }).failures.join(" ")).toContain("provenance is missing or invalid");
  });

  it("rejects remote HTML and traversing shell paths", async () => {
    const remote = verifyWindowsPreview({ ...await previewFixture({ html: '<script src="http://localhost:3000/app.js"></script>' }), electronVersion: "41.0.2" });
    expect(remote.failures.join(" ")).toContain("non-local asset");
    const traversal = verifyWindowsPreview({ ...await previewFixture({ manifest: ["index.html", "../private.txt"] }), electronVersion: "41.0.2" });
    expect(traversal.failures.join(" ")).toContain("non-local asset path");
  });

  it("requires the document, vault and import chunks even if the manifest is internally consistent", async () => {
    const result = verifyWindowsPreview({ ...await previewFixture({ manifest: ["index.html", "assets/index-test.js"] }), electronVersion: "41.0.2" });
    expect(result.failures.join(" ")).toContain("legacy-doc.worker-");
    expect(result.failures.join(" ")).toContain("word-document-editor-");
  });

  it("accepts explicit artifact paths and refuses unknown CLI switches", () => {
    expect(parseWindowsPreviewArgs(["--app-dir", "/tmp/Preview Output", "--product-name", "Markie Preview"])).toEqual({ appDir: "/tmp/Preview Output", productName: "Markie Preview" });
    expect(() => parseWindowsPreviewArgs(["--publish", "always"])).toThrow("invalid argument");
    expect(() => parseWindowsPreviewArgs(["--app-dir"])).toThrow("invalid argument");
  });
});
