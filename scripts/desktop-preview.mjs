import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localElectronBuilderEnv } from "./local-electron-builder.mjs";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

export const PREVIEW_NAME = "Markie Preview";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const previewRoot = path.join(root, ".desktop-preview");
export function previewTarget(value, host = { platform: process.platform, arch: process.arch }) {
  value ??= host.platform === "win32" ? "windows-x64" : host.platform === "darwin" ? `mac-${host.arch}` : "unsupported-host";
  const target = { "mac-arm64": { platform: "darwin", arch: "arm64", folder: "mac-arm64", executable: "Markie Preview.app" }, "mac-x64": { platform: "darwin", arch: "x64", folder: "mac", executable: "Markie Preview.app" }, "windows-x64": { platform: "win32", arch: "x64", folder: "win-unpacked", executable: "Markie Preview.exe" } }[value];
  if (!target) throw new Error("Choose mac-arm64, mac-x64 or windows-x64.");
  return { ...target, id: value };
}
export function previewBuildEnv(base = process.env) {
  const env = localElectronBuilderEnv(base);
  for (const key of Object.keys(env)) if (/^(?:APPLE_|AZURE_|WIN_CSC_|NOTARIZE_|SIGN_)/.test(key) || ["MARKIE_WINDOWS_SIGNING", "GH_TOKEN", "GITHUB_TOKEN"].includes(key)) delete env[key];
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return env;
}
function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited ${result.status}.`);
}
export function buildDesktopPreview(targetName) {
  const target = previewTarget(targetName);
  mkdirSync(previewRoot, { recursive: true });
  const output = mkdtempSync(path.join(previewRoot, `${target.id}-`));
  const env = { ...previewBuildEnv(), MARKIE_PREVIEW_PLATFORM: target.platform, MARKIE_PREVIEW_ARCH: target.arch, MARKIE_PREVIEW_OUTPUT: output };
  // Invoke installed JS entrypoints directly. Windows .cmd wrappers and
  // shell-concatenated paths fail in projects whose directory contains spaces.
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"], env);
  run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"], env);
  run(process.execPath, [path.join(root, "node_modules/electron-builder/cli.js"), "--config", "electron-builder.preview.cjs", target.platform === "darwin" ? "--mac" : "--win", `--${target.arch}`, "--dir", "--publish", "never"], env);
  const artifact = path.join(output, target.folder, target.executable);
  if (!existsSync(artifact)) throw new Error(`Expected preview artifact was not produced: ${artifact}`);
  const receipt = { schemaVersion: 1, target: target.id, artifact, output, builtAt: new Date().toISOString() };
  writeFileSync(path.join(previewRoot, `latest-${target.id}.json`), JSON.stringify(receipt, null, 2));
  console.log(`\nDesktop preview: ${artifact}`);
  return receipt;
}
export function runDesktopPreview(targetName) {
  const target = previewTarget(targetName);
  if (target.platform !== process.platform) throw new Error("Run the preview on its target operating system.");
  const receipt = JSON.parse(readFileSync(path.join(previewRoot, `latest-${target.id}.json`), "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.target !== target.id || typeof receipt.artifact !== "string" || path.basename(receipt.artifact) !== target.executable
    || !existsSync(receipt.artifact) || !realpathSync(receipt.artifact).startsWith(realpathSync(previewRoot) + path.sep)) throw new Error("Build the current desktop preview first.");
  if (process.platform === "darwin") run("/usr/bin/open", ["-n", receipt.artifact], process.env);
  else {
    const child = spawn(receipt.artifact, [], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", (error) => { console.error(`[desktop-preview] ${error.message}`); process.exitCode = 1; });
    child.unref();
  }
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = "build", target] = process.argv.slice(2);
    if (command === "build") buildDesktopPreview(target);
    else if (command === "run" || command === "build-and-run") {
      requireElectronConsent("desktop-preview", import.meta.url);
      if (command === "build-and-run") buildDesktopPreview(target);
      runDesktopPreview(target);
    } else throw new Error("Usage: node scripts/desktop-preview.mjs build|run|build-and-run [mac-arm64|mac-x64|windows-x64]");
  } catch (error) { console.error(`[desktop-preview] ${error.message}`); process.exitCode = 1; }
}
