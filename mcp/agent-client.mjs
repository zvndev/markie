// Talks to the running Markie app over its agent bridge (electron/agent-bridge.js).
//
// The MCP server never holds a Cloud session. For anything Cloud it asks the
// app, which syncs with the user's own session and asks the user for consent.
// The app advertises itself with ~/.markie/agent-bridge-<instance>.json; when
// several builds are installed, the newest one still running answers.
import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const REPLY_TIMEOUT_MS = 10 * 60 * 1000; // the user may be reading a consent prompt
const LAUNCH_WAIT_MS = 20_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/** The newest live bridge advertised in `dir`, or null. */
export async function findBridge({ dir = join(homedir(), ".markie"), isAlive = alive } = {}) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    if (!/^agent-bridge-[a-f0-9]+\.json$/.test(name)) continue;
    try {
      const info = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (typeof info.socket === "string" && typeof info.token === "string" && isAlive(info.pid)) found.push(info);
    } catch {
      // half-written or foreign; skip it
    }
  }
  found.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return found[0] ?? null;
}

/** One request, one reply. Rejects with the app's own message on refusal. */
export function callBridge(info, method, params, { timeoutMs = REPLY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(info.socket);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Markie did not answer in time."));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ token: info.token, method, params }) + "\n"));
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err && err.code === "ENOENT" || err && err.code === "ECONNREFUSED" ? "Markie isn't running." : "Markie could not be reached."));
    });
    socket.on("close", () => {
      clearTimeout(timer);
      const line = buf.split("\n")[0];
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        reject(new Error("Markie sent an unreadable reply."));
        return;
      }
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error || "Markie refused."));
    });
  });
}

function launchMarkie(platform = process.platform) {
  if (platform !== "darwin") return false;
  try {
    const child = spawn("open", ["-g", "-a", "Markie"], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the app something only if it is already running, and never wait long.
 * For notes the app can use but a write must not depend on: no launch, a
 * short timeout, and null instead of an error.
 */
export async function tellMarkie(method, params, { find = findBridge, call = callBridge, timeoutMs = 2000 } = {}) {
  try {
    const info = await find();
    if (!info) return null;
    return await call(info, method, params, { timeoutMs });
  } catch {
    return null;
  }
}

/** Ask the running app; start it first on macOS when it is not running. */
export async function askMarkie(method, params, {
  find = findBridge,
  call = callBridge,
  launch = launchMarkie,
  waitMs = LAUNCH_WAIT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  notRunning = "Markie isn't running. Open the Markie app, sign in to Markie Cloud, and try again.",
} = {}) {
  let info = await find();
  if (!info && launch()) {
    for (let waited = 0; !info && waited < waitMs; waited += 500) {
      await sleep(500);
      info = await find();
    }
  }
  if (!info) throw new Error(notRunning);
  return call(info, method, params);
}
