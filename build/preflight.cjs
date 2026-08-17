// electron-builder afterPack hook — release gate.
//
// Smoke-tests the freshly packed .app by actually launching it and verifying a
// real window appears with the renderer loaded. Runs BEFORE signing /
// notarization / publish, so a broken build is a HARD STOP: throwing here
// aborts the whole electron-builder run and nothing is uploaded.
//
// This exists because 0.2.5 shipped a build that launched but never showed a
// window (a missing module crashed main.js before app.whenReady). That class of
// regression — "app starts but no window" — is exactly what this catches.
//
// Set MARKIE_SKIP_PREFLIGHT=1 to skip (local quick iteration only; the release
// scripts never set it).

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const WINDOW_TIMEOUT_MS = 40000;
const POLL_MS = 1000;
// The renderer sets <title>Markie — Markdown Viewer</title>; requiring this
// distinctive substring proves the HTML actually loaded, not just that some
// empty BrowserWindow exists.
const TITLE_NEEDLE = "Markdown Viewer";

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function preflightMode(context, env = process.env) {
  if (context.electronPlatformName === "win32") return "windows-native-prebuild";
  if (context.electronPlatformName !== "darwin") return "unsupported-host-smoke";
  if (env.MARKIE_SKIP_PREFLIGHT === "1") return "skip-mac-window-smoke";
  return "mac-window-smoke";
}

function windowsNativePrebuildScriptPath() {
  return path.join(__dirname, "../scripts/install-win-native-prebuild.mjs");
}

async function installWindowsNativePrebuild(context) {
  const scriptUrl = pathToFileURL(windowsNativePrebuildScriptPath()).href;
  const { installWindowsBetterSqlitePrebuild } = await import(scriptUrl);
  installWindowsBetterSqlitePrebuild({ appDir: context.appOutDir });
}

async function afterPack(context) {
  const mode = preflightMode(context);
  if (mode === "windows-native-prebuild") {
    await installWindowsNativePrebuild(context);
    console.log(
      "[preflight] win32 packaged with Windows native modules; OS-level window smoke must run on Windows"
    );
    return;
  }
  if (mode === "unsupported-host-smoke") {
    console.log(
      `[preflight] ${context.electronPlatformName} packaged; OS-level window smoke is currently implemented for macOS only`
    );
    return;
  }
  if (process.env.MARKIE_SKIP_PREFLIGHT === "1") {
    console.log("[preflight] skipped (MARKIE_SKIP_PREFLIGHT=1)");
    return;
  }

  const appName = context.packager.appInfo.productFilename; // "Markie"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const bin = path.join(appPath, "Contents", "MacOS", appName);
  // Any Markie bundle, not just one named exactly Markie.app. A copy sitting
  // at Markie-demo.app runs the same executable name, holds the same
  // single-instance lock, and answers to the same AppleScript process name.
  const procPat = `/Contents/MacOS/${appName}`;

  console.log(`\n[preflight] release gate: smoke-testing ${appPath}`);

  // Clear any instance holding the single-instance lock (it would make our
  // smoke launch quit immediately → false failure).
  sh(`pkill -9 -f "${procPat}"`);
  await sleep(800);
  const strays = sh(`pgrep -f "${procPat}"`);
  if (strays) {
    throw new Error(
      `[preflight] HARD STOP — could not clear running ${appName} instances (pids ${strays.split("\n").join(", ")}).\n` +
        `  They hold the single-instance lock, so the packed app would quit on launch\n` +
        `  and this gate would read the wrong window. Quit them and re-run.`
    );
  }

  // MARKIE_PREFLIGHT stops the app opening a document at launch. Without it
  // macOS restores whatever was last open, the window takes that file's name,
  // and this gate reads a title it was never going to match — which is exactly
  // how it aborted a release on a build that was fine.
  const child = spawn(bin, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MARKIE_PREFLIGHT: "1" },
  });
  child.unref();

  const countWindows = () =>
    Number(
      sh(`osascript -e 'tell application "System Events" to tell process "${appName}" to count windows'`) || "0"
    );
  const windowTitles = () =>
    sh(`osascript -e 'tell application "System Events" to tell process "${appName}" to get name of windows'`);

  // The pid AppleScript is answering for. Without this the gate reads whatever
  // process happens to be called "Markie" — which is how it once judged a
  // freshly packed build by a stale demo copy's window, and would just as
  // happily have passed a broken build on a good stray window.
  const scriptedPid = () =>
    Number(
      sh(`osascript -e 'tell application "System Events" to tell process "${appName}" to get unix id'`) || "0"
    );

  let ok = false;
  let lastCount = 0;
  let lastTitles = "";
  let lastPid = 0;
  const started = Date.now();
  while (Date.now() - started < WINDOW_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const alive = sh(`pgrep -f "${procPat}"`) !== "";
    lastPid = scriptedPid();
    lastCount = countWindows();
    lastTitles = windowTitles();
    if (lastPid !== child.pid) {
      // Some other Markie answered. Keep waiting for ours rather than
      // believing what this one says about itself.
      continue;
    }
    if (lastCount >= 1 && lastTitles.includes(TITLE_NEEDLE)) {
      ok = true;
      break;
    }
    if (!alive) {
      // Process exited on its own — crashed or quit. Keep looping briefly in
      // case it's relaunching, but this is usually a hard failure.
      console.log("[preflight] (app process not running yet/again…)");
    }
  }

  sh(`pkill -9 -f "${procPat}"`);

  if (!ok) {
    throw new Error(
      `[preflight] HARD STOP — release aborted.\n` +
        `  ${appName} did not present a loaded window within ${WINDOW_TIMEOUT_MS / 1000}s.\n` +
        `  last window count: ${lastCount}; last titles: ${lastTitles || "(none)"}\n` +
        `  launched pid ${child.pid}; the window belonged to pid ${lastPid || "(none)"}\n` +
        `  A main-process crash (e.g. a missing module) or a renderer that never\n` +
        `  loads will trip this. Fix and re-run the release; nothing was published.`
    );
  }

  console.log(`[preflight] ✓ window loaded (count=${lastCount}, title=${lastTitles})\n`);
}

module.exports = afterPack;
module.exports.preflightMode = preflightMode;
module.exports.windowsNativePrebuildScriptPath = windowsNativePrebuildScriptPath;
