// The local channel an MCP server uses to ask the running app for Cloud work.
//
// The MCP server is a separate process with no Cloud session, and must never
// get one: syncing and links have to happen in here, with the user's own
// session, behind the user's consent. So the app listens on a Unix socket in
// ~/.markie (0700) and writes a discovery file beside it (0600) naming the
// socket and a random token. Only this user can reach either, and a caller
// must present the token, so another account on the machine, or a process
// that guesses the socket name, is refused.
//
// One request per connection, newline-delimited JSON:
//   -> {"token": "...", "method": "cloud_status", "params": {...}}
//   <- {"ok": true, "result": {...}}   or   {"ok": false, "error": "..."}
//
// Dependency-injected (fs, net, handlers) so the protocol is unit tested
// without Electron.
"use strict";

const nodeFs = require("fs");
const nodeNet = require("net");
const nodePath = require("path");
const nodeCrypto = require("crypto");

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // a consent prompt may wait on a person

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && nodeCrypto.timingSafeEqual(x, y);
}

/**
 * @param {object} opts
 * @param {string} opts.dir          discovery directory, ~/.markie
 * @param {string} opts.instance     stable id for this build's userData, so stable and nightly do not collide
 * @param {object} opts.info         what the discovery file says about the app (name, version)
 * @param {Record<string, (params: any) => Promise<any>>} opts.handlers
 */
function createAgentBridge({ dir, instance, info = {}, handlers, fs = nodeFs, net = nodeNet, pid = process.pid }) {
  const socketPath = nodePath.join(dir, `agent-${instance}.sock`);
  const discoveryPath = nodePath.join(dir, `agent-bridge-${instance}.json`);
  const token = nodeCrypto.randomBytes(32).toString("hex");
  let server = null;

  async function dispatch(raw) {
    let req;
    try { req = JSON.parse(raw); } catch { return { ok: false, error: "Bad request." }; }
    if (!req || !safeEqual(req.token, token)) return { ok: false, error: "Not authorized." };
    const handler = typeof req.method === "string" && Object.prototype.hasOwnProperty.call(handlers, req.method) ? handlers[req.method] : null;
    if (!handler) return { ok: false, error: `Unknown method: ${String(req.method)}` };
    try {
      return { ok: true, result: await handler(req.params && typeof req.params === "object" ? req.params : {}) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : "Markie could not do that." };
    }
  }

  function onConnection(socket) {
    let buf = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (done) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) { done = true; socket.end(JSON.stringify({ ok: false, error: "Request too large." }) + "\n"); return; }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      done = true;
      void dispatch(buf.slice(0, nl)).then((res) => { if (!socket.destroyed) socket.end(JSON.stringify(res) + "\n"); });
    });
  }

  function start() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to fix; the socket mode still holds */ }
    // A socket left by a crashed run would make listen() fail with EADDRINUSE.
    try { fs.unlinkSync(socketPath); } catch { /* none */ }
    return new Promise((resolve, reject) => {
      server = net.createServer(onConnection);
      server.once("error", reject);
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { /* dir is 0700 regardless */ }
        const body = JSON.stringify({ socket: socketPath, token, pid, ...info, startedAt: new Date().toISOString() });
        const tmp = `${discoveryPath}.${pid}.tmp`;
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, discoveryPath);
        resolve({ socketPath, discoveryPath });
      });
    });
  }

  function stop() {
    try { server?.close(); } catch { /* already closed */ }
    server = null;
    // Only remove what is still ours: a newer instance may have replaced it.
    try {
      const current = JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
      if (current.token === token) fs.unlinkSync(discoveryPath);
    } catch { /* gone */ }
    try { fs.unlinkSync(socketPath); } catch { /* gone */ }
  }

  return { start, stop, dispatch, socketPath, discoveryPath, token };
}

module.exports = { createAgentBridge, MAX_REQUEST_BYTES };
