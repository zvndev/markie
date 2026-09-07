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
import { execFileSync, spawn } from "node:child_process";
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
// Reaching the debugger and proving whose it is share one budget. Neither is
// worth waiting on: if the window will not talk, the signal is right there.
const HANDSHAKE_BUDGET_MS = 2000;

/**
 * Launch the app in a real window with the debugger attached.
 *
 * @param {object} options
 * @param {number} options.debugPort  Remote debugging port; the flag is added here.
 * @param {string[]} [options.args]   The rest of Electron's argv, "." included.
 * @param {object} [options.env]      Merged over process.env.
 * @param {string} [options.cwd]      Defaults to the repo root.
 * @param {string} [options.log]      Append the window's output to this file.
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, debugPort: number, debugOrigin: string, close: () => Promise<void> }>}
 */
export async function launchElectron({ debugPort, args = [], env, cwd = repoRoot, log } = {}) {
  if (!Number.isInteger(debugPort) || debugPort <= 0) {
    throw new Error(`launchElectron needs a debugPort, got ${JSON.stringify(debugPort)}`);
  }
  await refuseATakenPort(debugPort);
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
    // Set once the app on the port has proved it is ours. Until then the port
    // says nothing about whether our window is gone.
    portProven: false,
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
  const asked = await askToQuit(handle);
  if (asked && (await waitUntilGone(handle, QUIT_TIMEOUT_MS))) return;
  // Either the debugger never answered or the app on that port was not ours to
  // close. SIGTERM reaches our own app through the shim and it quits on it, so
  // this is a real second chance rather than a formality.
  safeKill(handle.child, "SIGTERM");
  if (await waitUntilGone(handle, SIGNAL_TIMEOUT_MS)) return;
  // Last resort, and an admission of defeat: SIGKILL ends the shim without
  // reaching the binary it spawned, so it tidies our own child list and leaves
  // the window. Nothing else here can do better without killing by name.
  // escalate, because the SIGTERM above already set the child's killed flag.
  safeKill(handle.child, "SIGKILL", { escalate: true });
}

/**
 * Ask the app on the debugging port to quit, but only once it has proved it is
 * the app this handle spawned. Browser.close is not a request one aims at
 * whoever happens to answer: a stray window from an earlier run, or the
 * developer's own browser on 9222, would take it and close with unsaved work
 * inside. Returns whether the request was actually sent.
 */
async function askToQuit(handle) {
  const { debugOrigin, child } = handle;
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  const left = () => Math.max(1, deadline - Date.now());
  let ws;
  try {
    const res = await fetch(`${debugOrigin}/json/version`, { signal: AbortSignal.timeout(left()) });
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) return false;
    ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger did not accept a connection")), left());
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    const info = await once(ws, { id: 1, method: "SystemInfo.getProcessInfo", params: {} }, left());
    const browserPid = info?.result?.processInfo?.find((p) => p.type === "browser")?.id;
    if (!descendsFrom(browserPid, child.pid)) {
      process.stderr.write(
        `electron-window: ${debugOrigin} answers for pid ${browserPid ?? "unknown"}, which is not ` +
          `${child.pid} or a child of it. Not sending Browser.close; signalling our own process instead.\n`
      );
      return false;
    }

    handle.portProven = true;
    // The browser target, not a page: closing a page leaves the app running.
    ws.send(JSON.stringify({ id: 2, method: "Browser.close", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
  } catch {
    // The window is already gone, too broken to answer, or too slow to prove
    // itself inside the budget. The signal follows either way.
    return false;
  } finally {
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }
}

// One request, one reply, or nothing within the budget.
function once(ws, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error(`${message.method} did not answer`)); }, timeoutMs);
    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id !== message.id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
    ws.send(JSON.stringify(message));
  });
}

// Is `pid` the process we spawned, or something it spawned? On macOS the app
// Electron re-launches through LaunchServices is the shim's own child, so the
// walk is short; five levels is generous and bounded.
function descendsFrom(pid, ancestorPid) {
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(ancestorPid) || ancestorPid <= 1) return false;
  let current = pid;
  for (let depth = 0; depth < 5; depth++) {
    if (current === ancestorPid) return true;
    const parent = parentOf(current);
    if (parent === null || parent <= 1) return false;
    current = parent;
  }
  return false;
}

function parentOf(pid) {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8" });
    const parent = Number.parseInt(out.trim(), 10);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

// A debugging port that already answers belongs to someone else: a window an
// earlier run left behind, or the developer's own browser, and 9222 is a port
// two of these scripts still hardcode. Spawning into it means Electron quietly
// fails to bind, the script drives that other window for forty seconds and then
// times out, and the teardown asks a stranger's app to quit. Refuse first.
async function refuseATakenPort(debugPort) {
  const origin = `http://127.0.0.1:${debugPort}`;
  let res;
  try {
    res = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(1000) });
  } catch (error) {
    // A refused connection is the good case: the port is free. A timeout is
    // not, since something is holding it without answering and will not yield
    // it either, so that falls through to the refusal.
    if (error?.name !== "TimeoutError") return;
  }
  // Anything at all on the port is enough; whether it answers this route, or
  // answers it with JSON, only decides how well the refusal can name it.
  let who = "";
  try {
    who = (await res?.json())?.Browser ?? "";
  } catch {
    /* not a debugger, but still on the port */
  }
  throw new Error(
    `debugging port ${debugPort} is already in use${who ? ` by ${who}` : ""}. ` +
      "Nothing was launched: another debuggable app holds it, and this run would have driven " +
      "that window and asked it to quit. Close it, or give the script a free port."
  );
}

async function waitUntilGone({ child, debugOrigin, portProven }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      // The launcher is gone. Our port outlives it by a moment, and while it
      // answers there is still a window on this machine. A port that was never
      // proved ours is somebody else's business and is not waited on: it would
      // answer forever and turn every unowned teardown into a timeout.
      if (!portProven) return true;
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
