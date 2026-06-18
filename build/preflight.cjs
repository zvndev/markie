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

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.MARKIE_SKIP_PREFLIGHT === "1") {
    console.log("[preflight] skipped (MARKIE_SKIP_PREFLIGHT=1)");
    return;
  }

  const appName = context.packager.appInfo.productFilename; // "Markie"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const bin = path.join(appPath, "Contents", "MacOS", appName);
  const procPat = `${appName}.app/Contents/MacOS/${appName}`;

  console.log(`\n[preflight] release gate: smoke-testing ${appPath}`);

  // Clear any instance holding the single-instance lock (it would make our
  // smoke launch quit immediately → false failure).
  sh(`pkill -9 -f "${procPat}"`);
  await sleep(800);

  const child = spawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref();

  const countWindows = () =>
    Number(
      sh(`osascript -e 'tell application "System Events" to tell process "${appName}" to count windows'`) || "0"
    );
  const windowTitles = () =>
    sh(`osascript -e 'tell application "System Events" to tell process "${appName}" to get name of windows'`);

  let ok = false;
  let lastCount = 0;
  let lastTitles = "";
  const started = Date.now();
  while (Date.now() - started < WINDOW_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const alive = sh(`pgrep -f "${procPat}"`) !== "";
    lastCount = countWindows();
    lastTitles = windowTitles();
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
        `  A main-process crash (e.g. a missing module) or a renderer that never\n` +
        `  loads will trip this. Fix and re-run the release; nothing was published.`
    );
  }

  console.log(`[preflight] ✓ window loaded (count=${lastCount}, title=${lastTitles})\n`);
};
