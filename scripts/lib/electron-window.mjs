// One way to put a real Markie window in front of a check script, and one way
// to take it away again.
//
// Taking it away is the hard half. On macOS Electron re-launches itself through
// LaunchServices, so the pid we spawn is a launcher and the app runs under a
// different one. safeKill signals the launcher, which by then has nothing to
// pass the signal on to, and the window survives the run that opened it. Every
// check left one behind, pass or fail, and a script that restarts the window
// mid-run found the debugging port still held by the instance it thought it
// had stopped.
//
// Killing the app by name would fix that and is exactly what must never happen
// here: `pkill -f electron` on a developer's machine reaches every other
// project, and a group kill by negative pid once took Finder down with it. See
// scripts/lib/safe-kill.mjs.
//
// So the window is asked, not killed. CDP's Browser.close tells the app to
// quit, it quits the way it would from the menu, and the launcher we did spawn
// exits with it.
//
// The fallback, for a window whose debugger never answers, is SIGTERM and only
// SIGTERM. node_modules/.bin/electron is Electron's cli.js: a Node process that
// spawns the real binary and forwards SIGINT, SIGTERM and SIGUSR2 to it, and
// nothing else. SIGKILL cannot be caught, so it ends that shim and hands the
// app to init, which is the orphan this module exists to stop.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { safeKill } from "./safe-kill.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(path.join(repoRoot, "server", "package.json"));
const WebSocket = require("ws");

// Measured on this machine: a window with the debugger attached, which is every
// window a check drives, answers Browser.close and is gone in under two
// seconds. One that had only just finished launching took just under eight,
// all of it the app's own quit sequence. The budget is generous because it only
// costs anything when a window refuses to go; a healthy one is waited on for
// exactly as long as it takes.
const QUIT_TIMEOUT_MS = 10000;
// A window that ignored the debugger gets a signal and a shorter wait.
const SIGNAL_TIMEOUT_MS = 5000;

/**
 * Launch the app in a real window with the debugger attached.
 *
 * @param {object} options
 * @param {number} options.debugPort  Remote debugging port; the flag is added here.
 * @param {string[]} [options.args]   The rest of Electron's argv, "." included.
 * @param {object} [options.env]      Merged over process.env.
 * @param {string} [options.cwd]      Defaults to the repo root.
 * @param {string} [options.log]      Append the window's output to this file.
 * @returns {{ child: import("node:child_process").ChildProcess, debugPort: number, debugOrigin: string, close: () => Promise<void> }}
 */
export function launchElectron({ debugPort, args = [], env, cwd = repoRoot, log } = {}) {
  if (!Number.isInteger(debugPort) || debugPort <= 0) {
    throw new Error(`launchElectron needs a debugPort, got ${JSON.stringify(debugPort)}`);
  }
  const bin = path.join(repoRoot, "node_modules", ".bin", "electron");
  const child = spawn(bin, [...args, `--remote-debugging-port=${debugPort}`], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (log) {
    const stream = createWriteStream(log, { flags: "a" });
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }

  const handle = {
    child,
    debugPort,
    debugOrigin: `http://127.0.0.1:${debugPort}`,
    closed: false,
    close: () => closeElectron(handle),
  };
  // A script killed before its own teardown runs still must not leave a window
  // behind. An exit handler cannot wait, so it cannot ask the window to quit
  // and cannot escalate: SIGTERM, forwarded by the shim, is the whole handler.
  process.on("exit", () => safeKill(child, "SIGTERM"));
  return handle;
}

/**
 * Ask the window to quit, wait for it, and fall back to a signal.
 * Safe to call twice, and safe on a window that already died.
 */
export async function closeElectron(handle) {
  if (!handle || handle.closed) return;
  handle.closed = true;
  await askToQuit(handle.debugOrigin);
  if (await waitUntilGone(handle, QUIT_TIMEOUT_MS)) return;
  // The debugger never answered. SIGTERM reaches the app through the shim and
  // the app quits on it, so this is a real second chance rather than a formality.
  safeKill(handle.child, "SIGTERM");
  if (await waitUntilGone(handle, SIGNAL_TIMEOUT_MS)) return;
  // Last resort, and an admission of defeat: SIGKILL ends the shim without
  // reaching the binary it spawned, so it tidies our own child list and leaves
  // the window. Nothing else here can do better without killing by name.
  safeKill(handle.child, "SIGKILL");
}

async function askToQuit(debugOrigin) {
  let ws;
  try {
    const res = await fetch(`${debugOrigin}/json/version`, { signal: AbortSignal.timeout(2000) });
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) return;
    ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger did not accept a connection")), 2000);
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    // The browser target, not a page: closing a page leaves the app running.
    ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {
    // The window is already gone, or too broken to answer. The signal follows.
  } finally {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }
}

async function waitUntilGone({ child, debugOrigin }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      // The launcher is gone. The port outlives it by a moment, and while it
      // answers there is still a window on this machine.
      try {
        await fetch(`${debugOrigin}/json/version`, { signal: AbortSignal.timeout(500) });
      } catch {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * End the run with an explicit code, once stdout has drained.
 *
 * A check that fell off the end of its script used to hang instead of exiting:
 * the CDP websocket it opened was still connected, and an open socket keeps
 * Node's event loop alive with no work left to do. Ending the window closes
 * that socket, and this makes sure of it either way.
 */
export async function endRun(code = process.exitCode ?? 0) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}
