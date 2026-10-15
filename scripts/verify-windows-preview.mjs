import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsX64Image } from "./lib/windows-pe.mjs";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PTY_BINARIES = ["pty.node", "conpty.node", "conpty_console_list.node", "winpty.dll", "winpty-agent.exe", "conpty/conpty.dll", "conpty/OpenConsole.exe"];
const CHROMIUM_FILES = ["icudtl.dat", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak", "v8_context_snapshot.bin", "locales/en-US.pak"];
const MCP_FILES = ["markie-mcp.mjs", "lib.mjs", "scan.mjs", "package.json"];

function fileExists(file) {
  return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
}

function validAssetPath(name) {
  return name === "index.html" || name === "favicon.ico" || /^assets\/[\w.-]+$/.test(name);
}

/** @param {{appDir?: string, productName?: string, expectedProvenance?: Record<string, unknown>, electronVersion?: string}} [options] */
export function verifyWindowsPreview({
  appDir = path.join(rootDir, ".desktop-preview", "win-unpacked"),
  productName = "Markie Preview",
  expectedProvenance,
  electronVersion = JSON.parse(readFileSync(path.join(rootDir, "node_modules/electron/package.json"), "utf8")).version,
} = {}) {
  if (!productName || /[\\/]/.test(productName)) throw new Error("productName must be an executable basename");
  appDir = path.resolve(appDir);
  const failures = [];
  const binaries = [];
  const resources = path.join(appDir, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked", "node_modules");
  const sqlite = path.join(unpacked, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const executable = path.join(appDir, `${productName}.exe`);
  const archive = path.join(resources, "app.asar");
  const needFile = (file) => {
    if (fileExists(file)) return true;
    failures.push(`missing or empty file: ${path.relative(appDir, file)}`);
    return false;
  };
  for (const file of [executable, sqlite, ...PTY_BINARIES.map((name) => path.join(unpacked, "node-pty", "prebuilds", "win32-x64", name))]) {
    if (!needFile(file)) continue;
    try {
      const image = assertWindowsX64Image(file);
      binaries.push({ file: path.relative(appDir, file), machine: "x64", bytes: image.size });
    } catch (error) {
      failures.push(error.message);
    }
  }
  for (const name of CHROMIUM_FILES) needFile(path.join(appDir, name));
  for (const name of MCP_FILES) needFile(path.join(resources, "mcp", name));
  for (const name of ["app-update.yml", "app-update.yaml"]) {
    if (existsSync(path.join(resources, name))) failures.push(`preview must not contain an updater feed: resources/${name}`);
  }

  let receipt = null;
  const receiptPath = path.join(resources, "windows-native-prebuild.json");
  if (needFile(receiptPath)) {
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (receipt.schemaVersion !== 1 || receipt.module !== "better-sqlite3" || receipt.platform !== "win32" || receipt.arch !== "x64" || receipt.electronVersion !== electronVersion) {
        failures.push("SQLite native receipt does not match Windows x64 / expected Electron target");
      }
      if (fileExists(sqlite) && receipt.sha256 !== createHash("sha256").update(readFileSync(sqlite)).digest("hex")) {
        failures.push("SQLite native receipt hash does not match installed binding");
      }
    } catch (error) {
      failures.push(`invalid SQLite native receipt: ${error.message}`);
    }
  }

  let provenance = null;
  let rendererAssets = [];
  if (needFile(archive)) {
    try {
      asar.uncache(archive);
      const files = new Set(asar.listPackage(archive).map((name) => name.replace(/^\//, "").replaceAll("\\", "/")));
      const readPackaged = (name) => {
        if (!files.has(name)) throw new Error(`packaged file missing: ${name}`);
        const bytes = asar.extractFile(archive, name);
        if (!bytes.length) throw new Error(`packaged file empty: ${name}`);
        return bytes.toString("utf8");
      };
      const metadata = JSON.parse(readPackaged("package.json"));
      if (metadata.name !== "markie-preview" || metadata.markieDesktopPreview !== true) failures.push("packaged app is not explicitly marked markie-preview");
      if (metadata.main !== "electron/main.js") failures.push("packaged desktop main entry is not electron/main.js");
      provenance = metadata.markiePreviewProvenance;
      const validBuiltAt = typeof provenance?.builtAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(provenance.builtAt) && Number.isFinite(Date.parse(provenance.builtAt));
      if (!provenance || provenance.schemaVersion !== 1 || !/^[a-f\d]{40}$/i.test(provenance.gitCommit ?? "") || !validBuiltAt || provenance.platform !== "win32" || provenance.arch !== "x64") {
        failures.push("packaged Windows preview provenance is missing or invalid");
      }
      for (const [key, value] of Object.entries(expectedProvenance ?? {})) {
        if (provenance?.[key] !== value) failures.push(`packaged provenance mismatch: ${key}`);
      }
      const sqliteMetadata = JSON.parse(readPackaged("node_modules/better-sqlite3/package.json"));
      if (receipt && sqliteMetadata.version !== receipt.moduleVersion) failures.push("SQLite receipt module version does not match packaged dependency");
      for (const name of ["electron/main.js", "electron/preload.js", "node_modules/node-pty/lib/index.js", "node_modules/node-pty/lib/windowsPtyAgent.js", "node_modules/node-pty/lib/windowsConoutConnection.js", "node_modules/node-pty/lib/conpty_console_list_agent.js", "node_modules/node-pty/lib/worker/conoutSocketWorker.js"]) readPackaged(name);
      const html = readPackaged("out/index.html");
      const htmlAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
      if (!htmlAssets.some((name) => /^\.\/assets\/.+\.js$/.test(name)) || !htmlAssets.some((name) => /^\.\/assets\/.+\.css$/.test(name))) failures.push("renderer HTML lacks local bundled JavaScript or CSS");
      for (const value of htmlAssets) {
        const name = value.replace(/^\.\//, "");
        if (!validAssetPath(name)) throw new Error(`renderer HTML references non-local asset: ${value}`);
        readPackaged(`out/${name}`);
      }
      const worker = readPackaged("out/service-worker.js");
      const manifest = worker.match(/const FILES = (\[[^\n]*\]);/);
      if (!manifest) throw new Error("renderer shell asset manifest is missing");
      const parsedAssets = JSON.parse(manifest[1]);
      if (!Array.isArray(parsedAssets) || !parsedAssets.includes("index.html")) throw new Error("invalid renderer shell asset manifest");
      rendererAssets = parsedAssets;
      for (const name of rendererAssets) {
        if (typeof name !== "string" || !validAssetPath(name)) throw new Error("renderer shell contains a non-local asset path");
        readPackaged(`out/${name}`);
      }
      for (const prefix of ["docx-", "word-document-editor-", "document-workspace-host-", "legacy-doc.worker-", "vault-panel-", "document-import-"]) {
        if (!rendererAssets.some((name) => name.startsWith(`assets/${prefix}`) && name.endsWith(".js"))) failures.push(`renderer capability bundle missing: ${prefix}`);
      }
    } catch (error) {
      failures.push(`packaged application validation: ${error.message}`);
    } finally {
      asar.uncache(archive);
    }
  }
  return {
    ok: failures.length === 0,
    platform: "win32",
    arch: "x64",
    mode: "structure-only",
    appDir,
    executable,
    provenance,
    nativeReceipt: receipt,
    binaries,
    rendererAssetCount: rendererAssets.length,
    failures,
    notTested: ["Windows OS launch, native module loading, local document editing and export must still be exercised on Windows"],
  };
}

export function parseWindowsPreviewArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!["--app-dir", "--product-name", "--provenance"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`invalid argument: ${flag}`);
    const value = args[++index];
    if (flag === "--app-dir") options.appDir = value;
    else if (flag === "--product-name") options.productName = value;
    else options.expectedProvenance = JSON.parse(readFileSync(value, "utf8"));
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = verifyWindowsPreview(parseWindowsPreviewArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[windows-preview] ${error.message}`);
    process.exitCode = 1;
  }
}
