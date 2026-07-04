import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SIGNING_ENV_KEYS = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
];

export function localElectronBuilderEnv(baseEnv = process.env) {
  const env = { ...baseEnv, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("CSC_") && key !== "CSC_IDENTITY_AUTO_DISCOVERY") || SIGNING_ENV_KEYS.includes(key)) {
      delete env[key];
    }
  }
  return env;
}

export function electronBuilderBin(rootDir) {
  const binName = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
  const localBin = path.join(rootDir, "node_modules", ".bin", binName);
  return existsSync(localBin) ? localBin : binName;
}

function targetsMac(argv) {
  return argv.some((arg) => arg === "--mac" || arg === "-m" || arg.startsWith("--mac=") || arg.startsWith("-m="));
}

function targetsWindows(argv) {
  return argv.some((arg) => arg === "--win" || arg === "-w" || arg.startsWith("--win=") || arg.startsWith("-w="));
}

export function localElectronBuilderArgs(argv) {
  const args = [...argv];
  if (targetsMac(args) && !args.some((arg) => arg.includes("mac.identity"))) {
    args.push("-c.mac.identity=null");
  }
  if (targetsWindows(args) && !args.some((arg) => arg.includes("win.signAndEditExecutable"))) {
    args.push("-c.win.signAndEditExecutable=false");
  }
  return args;
}

export function runLocalElectronBuilder(
  argv = process.argv.slice(2),
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: node scripts/local-electron-builder.mjs <electron-builder args>");
    console.log("Runs electron-builder with local signing and notarization credentials stripped.");
    return 0;
  }

  const command = electronBuilderBin(rootDir);
  const env = localElectronBuilderEnv();
  const args = localElectronBuilderArgs(argv);
  console.log("[local-electron-builder] CSC_IDENTITY_AUTO_DISCOVERY=false; signing credentials stripped");
  if (args.some((arg) => arg === "-c.mac.identity=null")) {
    console.log("[local-electron-builder] mac.identity=null; Developer ID signing disabled");
  }
  if (args.some((arg) => arg === "-c.win.signAndEditExecutable=false")) {
    console.log("[local-electron-builder] win.signAndEditExecutable=false; Windows signing/editing disabled");
  }
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = runLocalElectronBuilder();
  } catch (error) {
    console.error(`[local-electron-builder] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
