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
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const WINDOW_TIMEOUT_MS = 40000;
const POLL_MS = 1000;
// A word present in every title the window legitimately shows.
//
// This used to be "Markdown Viewer", the static HTML title from Next's
// metadata — and that made the gate race React. Once mounted, page.tsx sets
// document.title from the open file, which under MARKIE_PREFLIGHT (no file) is
// exactly "Markie". So the needle matched only in the window between load and
// mount: arm64 sampled inside it and passed, x64 under Rosetta mounted first
// and failed, on identical, working builds.
//
// Matching "Markie" is stable on both sides of mount. It is deliberately weak
// on its own — a window with no page at all reports the application name,
// which is also "Markie" — and that is fine, because READY_FILE below is the
// signal that actually carries the proof and cannot be faked by an empty
// window. The title is a sanity check; the handshake is the gate.
const TITLE_NEEDLE = "Markie";

// So the window check is only half of it. The app writes this file into its
// profile directory from the IPC handshake the renderer makes on mount, which
// is the part a loaded-but-crashed renderer cannot fake.
const READY_FILE = "preflight-ready";

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


  console.log(`\n[preflight] release gate: smoke-testing ${appPath}`);

  // Its own profile directory, which is what the single-instance lock is keyed
  // on. The gate therefore does not care whether Markie is already running:
  // it gets its own lock instead of quitting into somebody else's window, and
  // the smoke is a genuine first run rather than a replay of whatever state
  // this machine happened to be in. Killing the developer's running copy was
  // the alternative, and it is not the gate's business to close their unsaved
  // documents.
  const profileDir = mkdtempSync(path.join(tmpdir(), "markie-preflight-"));

  // MARKIE_PREFLIGHT stops the app opening a document at launch. Without it
  // macOS restores whatever was last open, the window takes that file's name,
  // and this gate reads a title it was never going to match — which is exactly
  // how it aborted a release on a build that was fine.
  const child = spawn(bin, [`--user-data-dir=${profileDir}`], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MARKIE_PREFLIGHT: "1" },
  });
  child.unref();

  // Addressed by pid, never by name.
  //
  // `process "Markie"` returns the *first* process with that name, so with the
  // developer's own copy running it can never be made to mean the app this
  // gate just launched — it answered for a stale demo copy once and aborted a
  // release on a build that was fine. Worse, the same confusion would have
  // passed a build that never started, on a stray window's good title.
  const ours = `(first process whose unix id is ${child.pid})`;
  const ask = (what) =>
    sh(`osascript -e 'tell application "System Events" to tell ${ours} to ${what}'`);

  const countWindows = () => Number(ask("count windows") || "0");
  const windowTitles = () => ask("get name of windows");

  let ok = false;
  let lastCount = 0;
  let lastTitles = "";
  let lastPid = 0;
  let mounted = false;
  const started = Date.now();
  while (Date.now() - started < WINDOW_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const alive = (() => {
      try { process.kill(child.pid, 0); return true; } catch { return false; }
    })();
    lastPid = child.pid;
    lastCount = countWindows();
    lastTitles = windowTitles();
    mounted = existsSync(path.join(profileDir, READY_FILE));
    if (lastCount >= 1 && lastTitles.includes(TITLE_NEEDLE) && mounted) {
      ok = true;
      break;
    }
    if (!alive) {
      // Process exited on its own — crashed or quit. Keep looping briefly in
      // case it's relaunching, but this is usually a hard failure.
      console.log("[preflight] (app process not running yet/again…)");
    }
  }

  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  rmSync(profileDir, { recursive: true, force: true });

  if (!ok) {
    throw new Error(
      `[preflight] HARD STOP — release aborted.\n` +
        `  ${appName} did not present a loaded window within ${WINDOW_TIMEOUT_MS / 1000}s.\n` +
        `  last window count: ${lastCount}; last titles: ${lastTitles || "(none)"}\n` +
        `  launched pid ${child.pid}; the window belonged to pid ${lastPid || "(none)"}\n` +
        `  renderer mounted: ${mounted ? "yes" : "no"}\n` +
        `  A main-process crash (e.g. a missing module) or a renderer that never\n` +
        `  loads will trip this. Fix and re-run the release; nothing was published.`
    );
  }

  console.log(`[preflight] ✓ renderer mounted (count=${lastCount}, title=${lastTitles})\n`);
}

module.exports = afterPack;
module.exports.preflightMode = preflightMode;
module.exports.windowsNativePrebuildScriptPath = windowsNativePrebuildScriptPath;
