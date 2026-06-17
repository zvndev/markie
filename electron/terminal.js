// In-app terminal: real PTY sessions via node-pty, streamed to the renderer's
// xterm.js. One pty per tab. Also detects installed terminal apps for the
// "Open in…" external launcher.
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let pty = null;
try {
  pty = require("node-pty");
} catch (err) {
  console.error("node-pty unavailable:", err && err.message);
}

const sessions = new Map(); // id -> ptyProcess
let counter = 0;

function create(cwd, onData, onExit) {
  if (!pty) return null;
  const id = `t${++counter}`;
  const shell = process.env.SHELL || "/bin/zsh";
  const home = os.homedir();
  const dir = cwd && fs.existsSync(cwd) ? cwd : home;
  const p = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: dir,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  p.onData((d) => onData(id, d));
  p.onExit(() => {
    sessions.delete(id);
    onExit(id);
  });
  sessions.set(id, p);
  return id;
}

function write(id, data) {
  const p = sessions.get(id);
  if (p) p.write(data);
}

function resize(id, cols, rows) {
  const p = sessions.get(id);
  if (p) {
    try {
      p.resize(Math.max(1, cols | 0), Math.max(1, rows | 0));
    } catch {
      // pty already gone
    }
  }
}

function kill(id) {
  const p = sessions.get(id);
  if (p) {
    try {
      p.kill();
    } catch {
      // already dead
    }
    sessions.delete(id);
  }
}

function killAll() {
  for (const p of sessions.values()) {
    try {
      p.kill();
    } catch {
      // already dead
    }
  }
  sessions.clear();
}

// ── External terminal apps ──
const CANDIDATES = [
  { id: "ghostty", name: "Ghostty", paths: ["/Applications/Ghostty.app"] },
  { id: "iterm", name: "iTerm", paths: ["/Applications/iTerm.app"] },
  { id: "warp", name: "Warp", paths: ["/Applications/Warp.app"] },
  { id: "kitty", name: "kitty", paths: ["/Applications/kitty.app"] },
  { id: "alacritty", name: "Alacritty", paths: ["/Applications/Alacritty.app"] },
  {
    id: "terminal",
    name: "Terminal",
    paths: [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/Utilities/Terminal.app",
    ],
  },
];

function externalApps() {
  if (process.platform !== "darwin") return [];
  return CANDIDATES.filter((c) => c.paths.some((p) => fs.existsSync(p))).map(
    (c) => ({ id: c.id, name: c.name })
  );
}

// Only a known candidate (by id or display name) may be launched — the appName
// comes from the renderer, so never hand an arbitrary value to `open -a`.
function isKnownApp(appName) {
  return CANDIDATES.some((c) => c.id === appName || c.name === appName);
}

function openExternal(appName, cwd) {
  if (process.platform !== "darwin") return { error: "macOS only" };
  if (!isKnownApp(appName)) return { error: "unknown terminal app" };
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  try {
    spawn("open", ["-a", appName, dir], { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
}

module.exports = {
  available: () => !!pty,
  create,
  write,
  resize,
  kill,
  killAll,
  externalApps,
  openExternal,
  isKnownApp,
};
