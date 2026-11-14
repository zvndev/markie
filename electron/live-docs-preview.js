// Live Docs, step M1: show a running local Darkmown project in a native view
// inside the main window, and keep it live as the project's files change.
//
// This is the proof behind the nightly flag, not the finished area. Three
// rules hold here, and main.js holds them again at the IPC edge:
//
// - The main process picks and keeps the folder. The renderer can ask to start
//   or stop the preview of that folder and nothing else: no path, no command.
// - What runs is the project's own Darkmown (`node_modules/.bin/darkmown dev`),
//   under the user's own Node, found through their login shell the way the
//   terminal finds it. The packaged app ships no `node`. No path is ever
//   written into a shell string: the shell only reports PATH.
// - The page gets a view with no preload, its own in-memory session, every
//   permission denied, and top-level navigation locked to the one loopback
//   origin the dev server answers on.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn: spawnDefault, execFile: execFileDefault } = require("child_process");
const { externalWebTarget } = require("./external-web.cjs");
const { resolveShell } = require("./terminal");

const DARKMOWN_PACKAGE = "@zvndev/darkmown";
// Not "persist:": the preview's cookies and storage live in memory and never
// share a jar with Markie's own session.
const PREVIEW_PARTITION = "live-docs-preview";
const LOOPBACK_HOST = "127.0.0.1";
// Darkmown's dev server serves its live-reload client here. A 200 with a
// script on this path is a Darkmown dev server, not just any open port.
const READY_PATH = "/__wd/dev-client.js";
const READY_TIMEOUT_MS = 60_000;
const SHELL_PROBE_TIMEOUT_MS = 10_000;
// Darkmown's package.json says "engines": { "node": ">=20" }.
const MIN_NODE_MAJOR = 20;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const LOG_LINES = 40;
// How long after a click or key press a navigation still counts as the user's.
const GESTURE_WINDOW_MS = 1500;

/** @typedef {{ ok: false, code: string, message: string, log?: string[] }} Refusal */

/** @returns {Refusal} */
function refuse(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function statOrNull(fsMod, target) {
  try { return fsMod.statSync(target); } catch { return null; }
}

function readPackageJson(fsMod, root) {
  const file = path.join(root, "package.json");
  const stat = statOrNull(fsMod, file);
  if (!stat || !stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return null;
  try {
    const parsed = JSON.parse(fsMod.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dependsOnDarkmown(pkg) {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((field) => {
    const deps = pkg?.[field];
    return !!deps && typeof deps === "object" && Object.prototype.hasOwnProperty.call(deps, DARKMOWN_PACKAGE);
  });
}

/**
 * The gate on the folder the user picked. Answers the canonical folder and why
 * it counts as a Darkmown project, or a refusal that says why not.
 *
 * @param {unknown} candidate
 * @param {{ fs?: typeof fs, home?: string }} [deps]
 * @returns {{ ok: true, root: string, name: string, reasons: string[] } | Refusal}
 */
function checkProjectFolder(candidate, { fs: fsMod = fs, home = os.homedir() } = {}) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4096
    || /[\x00-\x1f\x7f]/.test(candidate) || !path.isAbsolute(candidate)) {
    return refuse("invalid-path", "Choose a folder on this Mac.");
  }
  let root;
  try { root = fsMod.realpathSync(candidate); }
  catch { return refuse("missing", "That folder no longer exists."); }
  const stat = statOrNull(fsMod, root);
  if (!stat || !stat.isDirectory()) return refuse("not-a-folder", "Choose a folder, not a file.");
  const name = path.basename(root) || root;
  let homeRoot = home;
  try { homeRoot = fsMod.realpathSync(home); } catch { /* keep the unresolved home */ }
  // The folder itself, not its spelling: /System/Volumes/Data/Users/<me>,
  // /users/<me> or the path in capitals are all the home folder on macOS.
  // The root of the disk, the home folder and any folder that holds the home
  // folder are never a project.
  const same = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
  const homeStat = statOrNull(fsMod, homeRoot);
  const diskRoot = statOrNull(fsMod, path.parse(root).root);
  const holdsHome = (() => {
    for (let at = homeRoot; ; at = path.dirname(at)) {
      if (same(statOrNull(fsMod, at), stat)) return true;
      if (path.dirname(at) === at) return false;
    }
  })();
  if (root === path.parse(root).root || root === homeRoot || same(stat, homeStat) || same(stat, diskRoot) || holdsHome) {
    return refuse("too-broad", `${name} is not a project folder. Choose the folder that holds the project's site/pages.`);
  }
  const reasons = [];
  if (statOrNull(fsMod, path.join(root, "site", "pages"))?.isDirectory()) reasons.push("has site/pages");
  if (dependsOnDarkmown(readPackageJson(fsMod, root))) reasons.push(`depends on ${DARKMOWN_PACKAGE}`);
  if (reasons.length === 0) {
    return refuse(
      "not-a-project",
      `${name} is not a Darkmown project. It has no site/pages folder, and its package.json does not depend on ${DARKMOWN_PACKAGE}.`
    );
  }
  return { ok: true, root, name, reasons };
}

/**
 * The project's own Darkmown CLI. A project gets it from `npm install`; the
 * framework's own checkout runs its CLI from source.
 *
 * @param {string} root A folder that passed checkProjectFolder.
 * @param {{ fs?: typeof fs }} [deps]
 * @returns {{ ok: true, cli: string } | Refusal}
 */
function findDarkmownCli(root, { fs: fsMod = fs } = {}) {
  const bin = path.join(root, "node_modules", ".bin", "darkmown");
  if (statOrNull(fsMod, bin)?.isFile()) return { ok: true, cli: bin };
  const pkg = readPackageJson(fsMod, root);
  const own = pkg?.name === DARKMOWN_PACKAGE && typeof pkg.bin?.darkmown === "string"
    ? path.resolve(root, pkg.bin.darkmown)
    : null;
  if (own && own.startsWith(root + path.sep) && statOrNull(fsMod, own)?.isFile()) return { ok: true, cli: own };
  return refuse(
    "not-installed",
    `Darkmown is not installed in ${path.basename(root)}. Run npm install in that folder, then try again.`
  );
}

// ── Finding Node ──
// The shell is asked for PATH and nothing else. printenv and echo are the same
// commands in zsh, bash and fish, so the probe needs no per-shell syntax.
const PATH_PROBE = "echo __MARKIE_PATH__; /usr/bin/printenv PATH; echo __MARKIE_PATH_END__";
const PATH_PROBE_RE = /__MARKIE_PATH__\r?\n([^\r\n]*)\r?\n__MARKIE_PATH_END__/g;

/** The PATH a login shell printed, ignoring whatever its profile printed around it. */
function parsePathProbe(stdout) {
  let found = null;
  for (const match of String(stdout || "").matchAll(PATH_PROBE_RE)) found = match[1];
  return found && found.trim() ? found.trim() : null;
}

/** First executable file called `name` on a PATH, like `command -v`. */
function findExecutable(name, searchPath, { fs: fsMod = fs } = {}) {
  for (const dir of String(searchPath || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (!fsMod.statSync(candidate).isFile()) continue;
      fsMod.accessSync(candidate, fsMod.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version || "").trim());
  return match ? Number(match[1]) : null;
}

function execFileText(execFile, file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout) => resolve({ error, stdout: String(stdout || "") }));
  });
}

const NODE_MISSING_MESSAGE =
  "Markie could not find Node.js. Darkmown projects run on Node " + MIN_NODE_MAJOR +
  " or newer. Install it from nodejs.org or with Homebrew (brew install node), then try again.";

/**
 * Find the user's `node` the way their terminal would. A plain login shell
 * first (quiet, and enough for Homebrew and most installers); then an
 * interactive login shell, because nvm and friends usually live in .zshrc.
 *
 * @returns {Promise<{ ok: true, node: string, version: string, path: string, via: string } | Refusal>}
 */
async function resolveNode({
  platform = process.platform,
  env = process.env,
  execFile = execFileDefault,
  fs: fsMod = fs,
} = {}) {
  if (platform === "win32") {
    return refuse("unsupported-platform", "The Darkmown project preview runs on macOS and Linux for now.");
  }
  const shell = resolveShell(platform, env);
  for (const flags of [["-l"], ["-i", "-l"]]) {
    const { stdout } = await execFileText(execFile, shell.command, [...flags, "-c", PATH_PROBE], {
      env: { ...env, MARKIE_RESOLVING_ENVIRONMENT: "1" },
      timeout: SHELL_PROBE_TIMEOUT_MS,
      // An interactive shell ignores SIGTERM, which is execFile's default.
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const searchPath = parsePathProbe(stdout);
    if (!searchPath) continue;
    const node = findExecutable("node", searchPath, { fs: fsMod });
    if (!node) continue;
    const probe = await execFileText(execFile, node, ["--version"], { env: { ...env, PATH: searchPath }, timeout: 5_000 });
    const version = probe.stdout.trim();
    const major = nodeMajor(version);
    if (major === null) continue;
    if (major < MIN_NODE_MAJOR) {
      return refuse("node-too-old", `Darkmown needs Node ${MIN_NODE_MAJOR} or newer. Markie found ${version} at ${node}.`);
    }
    return { ok: true, node, version, path: searchPath, via: `${path.basename(shell.command)} ${flags.join(" ")}` };
  }
  return refuse("node-missing", NODE_MISSING_MESSAGE);
}

// ── Running the dev server ──
// The dev server runs under a small watchdog, passed to node as a fixed -e
// script with the CLI path as an argument. Its stdin is a pipe from Markie: if
// Markie dies in a way no quit handler sees (a crash, a SIGKILL), the pipe
// closes and the watchdog takes the dev server down with it.
const WATCHDOG_SCRIPT = [
  '"use strict";',
  'const { spawn } = require("child_process");',
  "const [cli, ...args] = process.argv.slice(1);",
  'const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "inherit", "inherit"] });',
  "let stopping = false;",
  "const stop = () => {",
  "  if (stopping) return;",
  "  stopping = true;",
  '  try { child.kill("SIGTERM"); } catch {}',
  '  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(0); }, 3000).unref();',
  "};",
  'process.stdin.on("end", stop);',
  'process.stdin.on("close", stop);',
  'process.stdin.on("error", stop);',
  "process.stdin.resume();",
  'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);',
  'child.on("error", () => process.exit(1));',
  'child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));',
].join("\n");

function previewOrigin(port) {
  return `http://${LOOPBACK_HOST}:${port}`;
}

function devServerEnv(baseEnv, searchPath, port) {
  const env = { ...baseEnv, PATH: searchPath, PORT: String(port), HOST: LOOPBACK_HOST, NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    // Markie's own Electron switches mean nothing to node, and a widened host
    // list would let other names reach a server only this view should see.
    if (key.startsWith("ELECTRON_") || key === "DARKMOWN_ALLOWED_HOSTS" || key === "MARKIE_RESOLVING_ENVIRONMENT") delete env[key];
  }
  return env;
}

function pickPortDefault() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

function probeReadyDefault(origin) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}${READY_PATH}`, { timeout: 1_500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200 && /javascript/.test(String(response.headers["content-type"] || "")));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function pushLog(log, chunk) {
  for (const line of String(chunk).replace(ANSI_RE, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
    if (log.length > LOG_LINES) log.shift();
  }
}

// A process group belongs to us only when we created it: an integer pid above
// 1 from a child we spawned detached. Anything else gets a plain kill.
//
// scripts/lib/safe-kill.mjs bans group kills for Electron, which relaunches
// itself through LaunchServices and leaves its group, so the pgid can end up
// naming someone else. The watchdog is plain node: it never relaunches, it
// leads the group it was spawned into, and its pid cannot be reused before
// libuv reaps it, which is the same tick that sets run.exited. Callers check
// run.exited first.
function signalRun(run, signal, kill) {
  const pid = run.child.pid;
  if (run.detached && Number.isInteger(pid) && pid > 1) {
    try { kill(-pid, signal); return; } catch { /* fall through to the child itself */ }
  }
  try { run.child.kill(signal); } catch { /* already gone */ }
}

/**
 * One dev server at a time, for whichever folder main.js hands it.
 */
function createDevServerRunner({
  spawn = spawnDefault,
  execFile = execFileDefault,
  fs: fsMod = fs,
  env = process.env,
  platform = process.platform,
  pickPort = pickPortDefault,
  probeReady = probeReadyDefault,
  readyTimeoutMs = READY_TIMEOUT_MS,
  pollMs = 200,
  stopGraceMs = 3_000,
  kill = (pid, signal) => { process.kill(pid, signal); },
} = {}) {
  let active = null;
  let generation = 0;

  function launch(root, cli, node, port, onExit) {
    const detached = platform !== "win32";
    const child = spawn(node.node, ["-e", WATCHDOG_SCRIPT, "--", cli, "dev"], {
      cwd: root,
      env: devServerEnv(env, node.path, port),
      stdio: ["pipe", "pipe", "pipe"],
      detached,
      shell: false,
      windowsHide: true,
    });
    const run = { child, detached, port, origin: previewOrigin(port), log: [], exited: null, stopping: false };
    child.stdout?.on("data", (chunk) => pushLog(run.log, chunk));
    child.stderr?.on("data", (chunk) => pushLog(run.log, chunk));
    // A broken pipe on a watchdog that already left is not Markie's problem.
    child.stdin?.on("error", () => {});
    child.on("error", (error) => {
      pushLog(run.log, error?.message || String(error));
      if (!run.exited) run.exited = { code: null, signal: null };
    });
    child.on("exit", (code, signal) => {
      if (run.exited && run.exitSeen) return;
      run.exitSeen = true;
      run.exited = { code, signal };
      if (active === run) active = null;
      if (!run.stopping && run.ready) onExit?.({ code, signal, log: [...run.log] });
    });
    return run;
  }

  async function waitUntilReady(run, gen) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (gen !== generation) return refuse("superseded", "The preview was stopped before it finished starting.");
      if (run.exited) {
        return refuse("start-failed", "The Darkmown dev server stopped before it was ready.", { log: [...run.log] });
      }
      if (await probeReady(run.origin)) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return refuse("start-timeout", `The Darkmown dev server did not answer within ${Math.round(readyTimeoutMs / 1000)} seconds.`, { log: [...run.log] });
  }

  async function stopRun(run) {
    if (!run || run.exited) return;
    run.stopping = true;
    try { run.child.stdin?.end(); } catch { /* already closed */ }
    signalRun(run, "SIGTERM", kill);
    const exited = await new Promise((resolve) => {
      if (run.exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), stopGraceMs);
      timer.unref?.();
      run.child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) signalRun(run, "SIGKILL", kill);
  }

  /**
   * @param {string} root A folder that passed checkProjectFolder.
   * @param {{ onExit?: (info: { code: number | null, signal: string | null, log: string[] }) => void }} [options]
   *   Called when a dev server that was ready stops on its own.
   */
  async function start(root, { onExit } = {}) {
    await stop();
    const gen = ++generation;
    const cli = findDarkmownCli(root, { fs: fsMod });
    if (!cli.ok) return cli;
    const node = await resolveNode({ platform, env, execFile, fs: fsMod });
    if (!node.ok) return node;
    if (gen !== generation) return refuse("superseded", "The preview was stopped before it finished starting.");
    let last = null;
    // Picking a free port and binding it are two steps; another process can
    // take the port in between. One retry covers that race.
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await pickPort();
      if (gen !== generation) return refuse("superseded", "The preview was stopped before it finished starting.");
      const run = launch(root, cli.cli, node, port, onExit);
      active = run;
      const ready = await waitUntilReady(run, gen);
      if (ready.ok) {
        run.ready = true;
        return { ok: true, origin: run.origin, port, cli: cli.cli, node: { path: node.node, version: node.version, via: node.via } };
      }
      await stopRun(run);
      if (active === run) active = null;
      last = ready;
      if (ready.code !== "start-failed" || !run.log.some((line) => /EADDRINUSE/.test(line))) break;
    }
    return last || refuse("start-failed", "The Darkmown dev server could not start.");
  }

  /** Stop the dev server and wait for it to go. Safe to call at any time. */
  async function stop() {
    generation++;
    const run = active;
    active = null;
    await stopRun(run);
  }

  /** Quit path: signal now, wait for nothing. The watchdog covers the rest. */
  function stopNow() {
    generation++;
    const run = active;
    active = null;
    if (!run || run.exited) return;
    run.stopping = true;
    try { run.child.stdin?.end(); } catch { /* already closed */ }
    signalRun(run, "SIGTERM", kill);
  }

  return { start, stop, stopNow, running: () => !!active && !active.exited };
}

// ── The view ──

/**
 * webPreferences for the preview's WebContentsView. No preload, so no Markie
 * API; its own in-memory partition, so no Markie cookies or accounts.
 */
function previewWebPreferences({ isPackaged }) {
  return {
    partition: PREVIEW_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: !isPackaged,
  };
}

const lockedSessions = new WeakSet();

/** Deny every permission and download the preview's session is ever asked for. */
function lockDownSession(ses) {
  if (!ses || lockedSessions.has(ses)) return;
  lockedSessions.add(ses);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler?.(() => false);
  ses.on("will-download", (event) => event.preventDefault());
}

/**
 * Where a navigation from the preview may go: its own origin ("allow"), the
 * system browser ("external", only ordinary web addresses), or nowhere.
 *
 * @param {unknown} target
 * @param {string} origin The exact loopback origin of the dev server.
 * @returns {"allow" | "external" | "block"}
 */
function navigationDecision(target, origin) {
  if (typeof target !== "string") return "block";
  let url;
  try { url = new URL(target); } catch { return "block"; }
  if (url.origin === origin && url.protocol === "http:" && !url.username && !url.password) return "allow";
  return externalWebTarget(target) ? "external" : "block";
}

const GESTURE_INPUTS = new Set(["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "char", "touchStart", "gestureTap"]);

/**
 * Keep the preview on its origin. Same-origin links load in place, a link to
 * any other web address opens in the system browser if the user just clicked
 * or pressed a key, and everything else is refused. No new windows, ever.
 *
 * @param {import("electron").WebContents} webContents
 * @param {{ origin: string, openExternal: (url: string) => void, now?: () => number }} options
 */
function lockNavigation(webContents, { origin, openExternal, now = Date.now }) {
  let lastGesture = -Infinity;
  webContents.on("input-event", (_event, input) => {
    if (GESTURE_INPUTS.has(input?.type)) lastGesture = now();
  });
  // One external page per gesture, so a page cannot answer a click with a
  // burst of tabs.
  const openIfGesture = (url) => {
    if (now() - lastGesture > GESTURE_WINDOW_MS) return;
    lastGesture = -Infinity;
    const target = externalWebTarget(url);
    if (target) openExternal(target);
  };
  webContents.on("will-navigate", (event, legacyUrl) => {
    const url = event?.url ?? legacyUrl;
    const decision = navigationDecision(url, origin);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") openIfGesture(url);
  });
  // A same-origin link that redirects off the origin is the server's doing,
  // not a click on another site.
  webContents.on("will-redirect", (event, legacyUrl, _inPlace, legacyIsMainFrame) => {
    const isMainFrame = event?.isMainFrame ?? legacyIsMainFrame;
    if (isMainFrame === false) return;
    if (navigationDecision(event?.url ?? legacyUrl, origin) !== "allow") event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = navigationDecision(url, origin);
    if (decision === "allow") webContents.loadURL(url).catch(() => {});
    else if (decision === "external") openIfGesture(url);
    return { action: "deny" };
  });
}

/**
 * The view's bounds, in window DIPs, from the placeholder's CSS rectangle the
 * renderer reported. Anything malformed hides the view rather than guessing.
 *
 * @param {unknown} layout
 * @param {{ width: number, height: number }} content The window's content size.
 * @param {number} [zoom] The main renderer's zoom factor.
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function previewBounds(layout, content, zoom = 1) {
  if (!layout || typeof layout !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (layout);
  const values = ["x", "y", "width", "height"].map((key) => (typeof raw[key] === "number" ? raw[key] : NaN));
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (values.some((value) => !Number.isFinite(value))) return null;
  const maxWidth = Math.max(0, Math.floor(content?.width || 0));
  const maxHeight = Math.max(0, Math.floor(content?.height || 0));
  const clamp = (value, max) => Math.min(Math.max(0, Math.round(value * scale)), max);
  const x = clamp(values[0], maxWidth);
  const y = clamp(values[1], maxHeight);
  const width = Math.min(clamp(values[2], maxWidth), maxWidth - x);
  const height = Math.min(clamp(values[3], maxHeight), maxHeight - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

module.exports = {
  DARKMOWN_PACKAGE,
  PREVIEW_PARTITION,
  READY_PATH,
  WATCHDOG_SCRIPT,
  NODE_MISSING_MESSAGE,
  checkProjectFolder,
  findDarkmownCli,
  parsePathProbe,
  findExecutable,
  resolveNode,
  devServerEnv,
  createDevServerRunner,
  previewOrigin,
  previewWebPreferences,
  lockDownSession,
  navigationDecision,
  lockNavigation,
  previewBounds,
};
