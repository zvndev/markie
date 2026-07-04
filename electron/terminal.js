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

function nearestWorkspace(filePath, workspaceRoots = []) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  let nearest = null;
  for (const root of workspaceRoots) {
    if (!root) continue;
    const candidate = path.resolve(root);
    if (resolved === candidate || resolved.startsWith(candidate + path.sep)) {
      if (!nearest || candidate.length > nearest.length) nearest = candidate;
    }
  }
  return nearest;
}

function resolveContext(context = {}, workspaceRoots = []) {
  const filePath = context.filePath ? path.resolve(context.filePath) : null;
  const fallbackDir = filePath ? path.dirname(filePath) : null;
  const cwd = context.cwd || fallbackDir;
  const workspace = nearestWorkspace(filePath, workspaceRoots) || fallbackDir;
  return { cwd, filePath, dir: fallbackDir, workspace };
}

function buildEnv(context, baseEnv = process.env) {
  const env = { ...baseEnv, TERM: "xterm-256color" };
  if (context?.filePath) env.MARKIE_FILE = context.filePath;
  if (context?.dir) env.MARKIE_DIR = context.dir;
  if (context?.workspace) env.MARKIE_WORKSPACE = context.workspace;
  return env;
}

function envValue(baseEnv, ...names) {
  for (const name of names) {
    if (baseEnv[name]) return baseEnv[name];
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(baseEnv)) {
    if (wanted.has(key.toLowerCase()) && value) return value;
  }
  return null;
}

function resolveShell(platform = process.platform, baseEnv = process.env) {
  if (platform === "win32") {
    return {
      command: envValue(baseEnv, "ComSpec", "COMSPEC") || "powershell.exe",
      args: [],
    };
  }
  return {
    command:
      envValue(baseEnv, "SHELL") ||
      (platform === "darwin" ? "/bin/zsh" : "/bin/bash"),
    args: ["-l"],
  };
}

function create(context, onData, onExit) {
  if (!pty) return null;
  const id = `t${++counter}`;
  const shell = resolveShell(process.platform, process.env);
  const home = os.homedir();
  const dir = context?.cwd && fs.existsSync(context.cwd) ? context.cwd : home;
  const p = pty.spawn(shell.command, shell.args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: dir,
    env: buildEnv(context),
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
const MAC_TERMINAL_CANDIDATES = [
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

const WINDOWS_TERMINAL_CANDIDATES = [
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    command: "wt.exe",
    detect: true,
    args: (dir) => ["-d", dir],
  },
  {
    id: "powershell",
    name: "PowerShell",
    command: "powershell.exe",
    args: (dir) => ["-NoExit", "-Command", `Set-Location -LiteralPath ${quotePowerShell(dir)}`],
  },
  {
    id: "cmd",
    name: "Command Prompt",
    command: "cmd.exe",
    args: (dir) => ["/K", "cd", "/d", dir],
  },
];

const LINUX_TERMINAL_CANDIDATES = [
  {
    id: "gnome-terminal",
    name: "GNOME Terminal",
    command: "gnome-terminal",
    detect: true,
    args: (dir) => ["--working-directory", dir],
  },
  {
    id: "konsole",
    name: "Konsole",
    command: "konsole",
    detect: true,
    args: (dir) => ["--workdir", dir],
  },
  {
    id: "xfce4-terminal",
    name: "Xfce Terminal",
    command: "xfce4-terminal",
    detect: true,
    args: (dir) => ["--working-directory", dir],
  },
  {
    id: "xterm",
    name: "xterm",
    command: "xterm",
    detect: true,
    args: () => [],
  },
];

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function splitPathList(value, platform = process.platform) {
  return String(value || "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
}

function commandExists(command, {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (!command) return false;
  if (path.isAbsolute(command)) return existsSync(command);
  const extensions = platform === "win32"
    ? splitPathList(env.PATHEXT || ".EXE;.CMD;.BAT;.COM", platform)
    : [""];
  const names = platform === "win32" && path.extname(command)
    ? [command]
    : extensions.map((ext) => `${command}${ext}`);
  return splitPathList(env.PATH, platform).some((dir) =>
    names.some((name) => existsSync(path.join(dir, name)))
  );
}

function linuxEnvTerminal(env = process.env) {
  const command = env.TERMINAL;
  if (!command || !/^[\w.+-]+$/.test(command)) return null;
  return {
    id: "env-terminal",
    name: path.basename(command),
    command,
    detect: true,
    args: () => [],
  };
}

function platformCandidates(platform = process.platform, env = process.env) {
  if (platform === "darwin") return MAC_TERMINAL_CANDIDATES;
  if (platform === "win32") return WINDOWS_TERMINAL_CANDIDATES;
  if (platform === "linux") {
    const envTerminal = linuxEnvTerminal(env);
    return envTerminal
      ? [envTerminal, ...LINUX_TERMINAL_CANDIDATES]
      : LINUX_TERMINAL_CANDIDATES;
  }
  return [];
}

function availableCandidate(candidate, platform, deps) {
  if (platform === "darwin") {
    return candidate.paths.some((p) => deps.existsSync(p));
  }
  if (!candidate.detect) return true;
  return commandExists(candidate.command, deps);
}

function externalApps({
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const deps = { platform, env, existsSync };
  return platformCandidates(platform, env)
    .filter((candidate) => availableCandidate(candidate, platform, deps))
    .map((candidate) => ({ id: candidate.id, name: candidate.name }));
}

// Only a known candidate (by id or display name) may be launched — the appName
// comes from the renderer, so never hand arbitrary commands to spawn/open.
function findCandidate(appName, platform = process.platform, env = process.env) {
  return platformCandidates(platform, env).find((candidate) =>
    candidate.id === appName || candidate.name === appName
  ) || null;
}

function isKnownApp(appName, platform = null) {
  if (platform) return !!findCandidate(appName, platform);
  return ["darwin", "win32", "linux"].some((candidatePlatform) =>
    !!findCandidate(appName, candidatePlatform)
  );
}

function openExternal(appName, cwd, {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  spawnFn = spawn,
  home = os.homedir(),
} = {}) {
  const candidate = findCandidate(appName, platform, env);
  if (!candidate) return { error: "unknown terminal app" };
  if (!availableCandidate(candidate, platform, { platform, env, existsSync })) {
    return { error: "terminal app unavailable" };
  }
  const dir = cwd && existsSync(cwd) ? cwd : home;
  try {
    if (platform === "darwin") {
      spawnFn("open", ["-a", candidate.name, dir], { detached: true, stdio: "ignore" }).unref();
      return { ok: true };
    }
    if (platform === "win32" || platform === "linux") {
      const launchDir = cwd && existsSync(cwd) ? cwd : home;
      spawnFn(candidate.command, candidate.args(launchDir), {
        cwd: launchDir,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: false,
      }).unref();
      return { ok: true };
    }
    return { error: "unsupported platform" };
  } catch (err) {
    return { error: String(err) };
  }
}

function terminalLabel(platform = process.platform, baseEnv = process.env) {
  const shell = resolveShell(platform, baseEnv);
  return path.basename(shell.command).replace(/\.(exe|cmd|bat|com)$/i, "") || "Shell";
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
  resolveContext,
  buildEnv,
  resolveShell,
  terminalLabel,
  commandExists,
};
