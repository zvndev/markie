#!/usr/bin/env node
// Live Docs step M1, proven in a packaged build. Launches the local Markie
// Preview app (npm run desktop:preview:mac), runs "Open Darkmown project
// preview…" from the palette, confirms the folder in the real native picker,
// and records what the native view does:
//
// - screenshots of the window before and after a page file changes on disk,
//   and the Darkmown error overlay inside the view
// - whether a DOM overlay in Markie draws under the view, and whether the
//   palette (which hides the view) draws over it
// - the view's size against its placeholder, before and after a resize
// - what the page can reach: Markie's API, app:// and markie-asset://,
//   cookies, permissions, navigation off its origin
// - that the dev server stops when the preview closes, when the app quits,
//   and when the app is killed outright
//
// Usage:
//   MARKIE_ALLOW_E2E=1 node scripts/live-docs-preview-check.mjs --project <dir>
//
// <dir> is an installed Darkmown project outside this repository, for example
// `npx @zvndev/darkmown init site && cd site && npm install` in a temp folder.
// Its site/pages/index.wd is edited during the run and restored at the end.
//
// macOS only. The shell running this needs Accessibility (one targeted click
// on the picker's Preview button, and one window resize, both aimed at the
// Markie Preview process, never typed keys) and Screen Recording (window
// screenshots). Evidence goes to .autoloop/runs/live-docs-preview-check-<stamp>/.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

requireElectronConsent("live-docs-preview-check", import.meta.url);

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const requireFromServer = createRequire(path.join(root, "server", "package.json"));
const WebSocket = requireFromServer("ws");
const requireHere = createRequire(import.meta.url);
const PROCESS_NAME = "Markie Preview";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── CDP ──
async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let nextId = 1;
  const pending = new Map();
  // A target that goes away (the app quitting) answers nothing; fail the
  // calls still waiting instead of leaving them to hang.
  ws.on("close", () => {
    for (const { reject } of pending.values()) reject(new Error("target closed"));
    pending.clear();
  });
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function targets(debugOrigin) {
  const response = await fetch(`${debugOrigin}/json/list`);
  return response.json();
}

async function key(cdp, keyName, { code = keyName, keyCode, modifiers = 0, text } = {}) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  if (text) await cdp.send("Input.dispatchKeyEvent", { type: "char", key: keyName, text, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

// ── macOS ──
async function osa(script) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 15_000 });
  return stdout.trim();
}

// The app's own windows, by owner pid, from the window server.
async function windowsOf(pid) {
  const script = `
    ObjC.import("CoreGraphics");
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
    JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === ${Number(pid)} && w.kCGWindowLayer === 0)
      .map((w) => ({ id: w.kCGWindowNumber, bounds: w.kCGWindowBounds, onscreen: !!w.kCGWindowIsOnscreen })));
  `;
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 15_000 });
  return JSON.parse(stdout.trim() || "[]");
}

async function screenshotWindow(pid, file) {
  const windows = (await windowsOf(pid)).filter((w) => w.onscreen && w.bounds.Height > 200);
  windows.sort((a, b) => b.bounds.Width * b.bounds.Height - a.bounds.Width * a.bounds.Height);
  if (!windows[0]) throw new Error("no on-screen Markie Preview window to capture");
  await execFileAsync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(windows[0].id), file], { timeout: 15_000 });
  return file;
}

async function confirmPicker() {
  // A sheet on Markie Preview's own window: click its Preview button by
  // accessibility. Nothing is typed, so focus elsewhere cannot catch keys.
  const sheet = `sheet 1 of window 1 of process "${PROCESS_NAME}"`;
  await waitFor("the native folder picker", async () => (await osa(`tell application "System Events" to exists ${sheet}`)) === "true", 15_000);
  // NSOpenPanel fills in its folder listing a moment after it appears.
  await sleep(1_200);
  // NSOpenPanel nests its buttons a level or two down, and the depth differs
  // between macOS releases, so look for the button rather than a path to it.
  const clicked = await osa(`tell application "System Events"
    set found to missing value
    -- Take the list once. Iterating the specifier itself asks System Events
    -- for "item n of entire contents" on every pass, which it cannot answer.
    set items_ to entire contents of ${sheet}
    repeat with element in items_
      try
        if role of element is "AXButton" and name of element is "Preview" then set found to contents of element
      end try
      if found is not missing value then exit repeat
    end repeat
    if found is missing value then return "missing"
    perform action "AXPress" of found
    return "clicked"
  end tell`);
  if (clicked !== "clicked") {
    const seen = await osa(`tell application "System Events"
      set out to ""
      set items_ to entire contents of ${sheet}
      set out to out & (count of items_) & " elements" & linefeed
      repeat with element in items_
        try
          if role of element is "AXButton" then set out to out & (name of element as text) & " | " & (description of element as text) & " | " & (title of element as text) & linefeed
        end try
      end repeat
      return out
    end tell`).catch((error) => String(error));
    throw new Error(`the picker has no Preview button. Buttons seen:\n${seen}`);
  }
}

async function resizeWindow(width, height) {
  await osa(`tell application "System Events" to set size of window 1 of process "${PROCESS_NAME}" to {${width}, ${height}}`);
}

async function processesFor(pattern) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", pattern]);
    return stdout.split("\n").map((line) => Number(line.trim())).filter(Boolean);
  } catch {
    return [];
  }
}

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.status;
  } catch {
    return 0;
  }
}

// ── the run ──
const projectArg = arg("--project");
if (!projectArg) {
  console.error("Pass --project <dir>: an installed Darkmown project outside this repository.");
  process.exit(2);
}
const project = realpathSync(projectArg);
if (project.startsWith(root + path.sep)) throw new Error("Use a project outside the Markie repository.");
if (!existsSync(path.join(project, "node_modules", ".bin", "darkmown"))) throw new Error("Run npm install in the project first.");
const page = path.join(project, "site", "pages", "index.wd");
if (!existsSync(page)) throw new Error(`Expected ${page}; scaffold the project with the starter template.`);
const originalPage = readFileSync(page, "utf8");
// The dev server, its watchdog and its build children all run from here. The
// pattern never matches this script's own --project argument.
const serverPattern = `${project}/node_modules/`;

const receipt = JSON.parse(readFileSync(path.join(root, ".desktop-preview", `latest-mac-${process.arch}.json`), "utf8"));
const appBundle = arg("--app") || receipt.artifact;
const executable = path.join(appBundle, "Contents", "MacOS", PROCESS_NAME);
if (!existsSync(executable)) throw new Error(`No packaged Markie Preview at ${appBundle}. Run npm run desktop:preview:mac.`);

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const out = path.join(root, ".autoloop", "runs", `live-docs-preview-check-${stamp}`);
mkdirSync(out, { recursive: true });
const result = { project, app: appBundle, startedAt: new Date().toISOString(), steps: {}, screenshots: {} };
const record = (name, value) => { result.steps[name] = value; console.log(`• ${name}:`, typeof value === "string" ? value : JSON.stringify(value)); };

async function launch(label) {
  const userData = await mkdtemp(path.join(tmpdir(), "markie-live-docs-check-"));
  // A fresh profile seeds example documents into ~/Documents/Markie. Mark them
  // seeded so this run never writes into the developer's real Documents.
  const { EXAMPLES } = requireHere("../electron/examples.js");
  writeFileSync(path.join(userData, "seeded-examples.json"), JSON.stringify({ seeded: EXAMPLES.map((example) => example.id) }));
  const debugPort = await pickPort();
  const debugOrigin = `http://127.0.0.1:${debugPort}`;
  const log = createWriteStream(path.join(out, `${label}.log`));
  // A shell started by another Electron app (an editor, an agent host) can
  // carry ELECTRON_RUN_AS_NODE, which turns Markie into plain node.
  const env = { ...process.env, MARKIE_E2E_LIVE_DOCS_START_DIR: project };
  for (const name of Object.keys(env)) if (name.startsWith("ELECTRON_")) delete env[name];
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const appTarget = await waitFor("the Markie window", async () => (await targets(debugOrigin)).find((t) => t.type === "page" && t.url.startsWith("app://markie/")), 45_000);
  const app = await connect(appTarget.webSocketDebuggerUrl);
  await waitFor("the app shell", () => app.evaluate("!!document.querySelector('.markie-shell') && document.readyState === 'complete'"), 30_000);
  await sleep(1_500);
  return { child, app, debugOrigin, userData };
}

async function openPreview(session) {
  const { app } = session;
  await key(app, "k", { code: "KeyK", keyCode: 75, modifiers: 4 });
  await waitFor("the command palette", () => app.evaluate("!!document.querySelector('[aria-label=\"Command palette\"] input')"), 10_000);
  await app.send("Input.insertText", { text: "Darkmown project preview" });
  await waitFor("the preview command", () => app.evaluate("!!document.querySelector('#markie-command-live-docs-preview')"), 5_000);
  await key(app, "Enter", { keyCode: 13, text: "\r" });
  await confirmPicker();
  const phase = await waitFor("the preview to be ready", async () => {
    const value = await app.evaluate("document.querySelector('[data-live-docs-phase]')?.getAttribute('data-live-docs-phase') ?? null");
    return value === "ready" || value === "error" || value === "rejected" ? value : null;
  }, 90_000);
  const header = await app.evaluate("document.querySelector('[data-live-docs-phase] header')?.innerText ?? ''");
  if (phase !== "ready") {
    const body = await app.evaluate("document.querySelector('[data-live-docs-preview-body]')?.innerText ?? ''");
    throw new Error(`preview ${phase}: ${header}\n${body}`);
  }
  const url = (header.match(/http:\/\/127\.0\.0\.1:\d+\//) || [])[0];
  const previewTarget = await waitFor("the preview page target", async () => (await targets(session.debugOrigin)).find((t) => t.type === "page" && url && t.url.startsWith(url)), 15_000);
  const preview = await connect(previewTarget.webSocketDebuggerUrl);
  await waitFor("the preview page to load", () => preview.evaluate("document.readyState === 'complete' && !!document.querySelector('h1')"), 20_000);
  return { url, header, preview };
}

const panelRect = (app) => app.evaluate(`(() => {
  const r = document.querySelector('[data-live-docs-preview-body]').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
})()`);
const viewSize = (preview) => preview.evaluate("({ width: window.innerWidth, height: window.innerHeight })");

let first;
let second;
try {
  // ── Run 1: open, screenshot, edit, screenshot, probe, close, quit ──
  first = await launch("run-1");
  record("app", { pid: first.child.pid, executable });
  const opened = await openPreview(first);
  const { preview } = opened;
  record("ready header", opened.header.replace(/\s+/g, " ").trim());
  record("focus once ready", { markie: await first.app.evaluate("document.hasFocus()"), preview: await preview.evaluate("document.hasFocus()") });
  await sleep(800);
  result.screenshots.preview = await screenshotWindow(first.child.pid, path.join(out, "01-preview.png"));

  // Edit the page on disk. Nothing in Markie is touched.
  const marker = `Edited on disk at ${new Date().toTimeString().slice(0, 8)}`;
  const navBefore = await preview.evaluate("performance.timeOrigin");
  const edited = originalPage.replace(/^# .*$/m, `# ${marker}`);
  if (edited === originalPage) throw new Error("index.wd has no top-level heading to edit");
  const editedAt = Date.now();
  writeFileSync(page, edited);
  await waitFor("the edit to show in the preview", () => preview.evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`), 20_000, 100);
  const reload = await preview.evaluate("({ timeOrigin: performance.timeOrigin, type: performance.getEntriesByType('navigation')[0]?.type })");
  record("live reload", { ms: Date.now() - editedAt, navigationType: reload.type, newDocument: reload.timeOrigin !== navBefore, heading: marker });
  await sleep(600);
  result.screenshots.afterEdit = await screenshotWindow(first.child.pid, path.join(out, "02-after-edit.png"));

  // Darkmown's error overlay, inside the view.
  writeFileSync(page, `${edited}\n@loop todos into todo\n- { todo }\n`);
  const overlay = await waitFor("the Darkmown error overlay", () => preview.evaluate("document.getElementById('__wd-error-overlay')?.innerText ?? null"), 20_000, 100);
  record("error overlay", overlay.split("\n").slice(0, 3).join(" | "));
  await sleep(400);
  result.screenshots.errorOverlay = await screenshotWindow(first.child.pid, path.join(out, "03-error-overlay.png"));
  writeFileSync(page, edited);
  await waitFor("the overlay to clear", () => preview.evaluate(`!document.getElementById('__wd-error-overlay') && document.body.innerText.includes(${JSON.stringify(marker)})`), 20_000, 100);
  record("error overlay cleared", true);

  // A DOM element in Markie's own page, over the view's rectangle.
  await first.app.evaluate(`(() => {
    const r = document.querySelector('[data-live-docs-preview-body]').getBoundingClientRect();
    const probe = document.createElement('div');
    probe.id = '__m1_dom_probe';
    probe.textContent = 'MARKIE DOM POPOVER (z-index 9999)';
    probe.style.cssText = 'position:fixed;z-index:9999;left:' + (r.left + 40) + 'px;top:' + (r.top + 40) + 'px;width:360px;height:120px;background:#d33;color:#fff;font:600 16px system-ui;display:grid;place-items:center;border-radius:12px';
    document.body.appendChild(probe);
  })()`);
  await sleep(500);
  result.screenshots.domUnderView = await screenshotWindow(first.child.pid, path.join(out, "04-dom-popover-under-view.png"));
  await first.app.evaluate("document.getElementById('__m1_dom_probe')?.remove()");

  // The palette hides the view while it is open.
  await key(first.app, "k", { code: "KeyK", keyCode: 75, modifiers: 4 });
  await waitFor("the palette over the preview", () => first.app.evaluate("!!document.querySelector('[aria-label=\"Command palette\"]')"), 5_000);
  await sleep(500);
  result.screenshots.palette = await screenshotWindow(first.child.pid, path.join(out, "05-palette-over-preview.png"));
  const focusWithPalette = { markie: await first.app.evaluate("document.hasFocus()"), preview: await preview.evaluate("document.hasFocus()") };
  await key(first.app, "Escape", { keyCode: 27 });
  await waitFor("the palette to close", async () => !(await first.app.evaluate("!!document.querySelector('[aria-label=\"Command palette\"]')")), 5_000);
  await sleep(400);
  record("focus while palette open", focusWithPalette);

  // Size, before and after the window changes.
  const before = { panel: await panelRect(first.app), view: await viewSize(preview) };
  await resizeWindow(980, 700);
  await sleep(900);
  const after = { panel: await panelRect(first.app), view: await viewSize(preview) };
  record("layout", { before, after });
  result.screenshots.resized = await screenshotWindow(first.child.pid, path.join(out, "06-resized.png"));

  // What the page can reach.
  const reach = await preview.evaluate(`(async () => {
    const tryFetch = (url) => fetch(url).then((r) => 'reachable ' + r.status, (e) => 'blocked (' + e.name + ')');
    const geo = await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve('denied ' + e.code), { timeout: 3000 }));
    const camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => 'denied ' + e.name);
    const notifications = await Notification.requestPermission();
    return {
      electronAPI: typeof window.electronAPI,
      require: typeof window.require,
      process: typeof window.process,
      appScheme: await tryFetch('app://markie/index.html'),
      assetScheme: await tryFetch('markie-asset://local/x.png'),
      cookies: document.cookie,
      geolocation: geo,
      camera,
      notifications,
      popup: String(window.open('https://example.com/')),
    };
  })()`);
  record("page reach", reach);
  const origin = new URL(opened.url).origin;
  await preview.evaluate("location.href = 'https://example.com/'; true");
  await sleep(1_000);
  const offOrigin = await preview.evaluate("location.origin");
  await preview.evaluate("location.href = '/about/'; true");
  await waitFor("same-origin navigation", async () => (await preview.evaluate("location.pathname")) === "/about/", 10_000);
  record("navigation", { offOriginStayedOn: offOrigin, sameOrigin: await preview.evaluate("location.href"), expectedOrigin: origin });

  // Close the preview: the dev server stops.
  const serverPids = await processesFor(serverPattern);
  await first.app.evaluate("document.querySelector('[aria-label=\"Close preview\"]').click(); true");
  const closedAt = Date.now();
  await waitFor("the dev server to stop after close", async () => (await answers(opened.url)) === 0 && (await processesFor(serverPattern)).length === 0, 15_000);
  record("stop on close", { ms: Date.now() - closedAt, serverPidsBefore: serverPids.length, after: (await processesFor(serverPattern)).length });

  // Open it again and quit the app: the dev server stops.
  const reopened = await openPreview(first);
  reopened.preview.close();
  const quitAt = Date.now();
  // The app quits before it can answer, so the reply is not waited on.
  first.app.send("Browser.close").catch(() => {});
  await waitFor("the app to quit", () => first.child.exitCode !== null || first.child.signalCode !== null, 20_000);
  await waitFor("the dev server to stop after quit", async () => (await answers(reopened.url)) === 0 && (await processesFor(serverPattern)).length === 0, 15_000);
  record("stop on quit", { ms: Date.now() - quitAt });

  // ── Run 2: kill the app outright; the watchdog takes the server down ──
  second = await launch("run-2");
  const crashed = await openPreview(second);
  crashed.preview.close();
  second.app.close();
  const killAt = Date.now();
  second.child.kill("SIGKILL");
  await waitFor("the dev server to stop after SIGKILL", async () => (await answers(crashed.url)) === 0 && (await processesFor(serverPattern)).length === 0, 20_000);
  record("stop on SIGKILL of Markie", { ms: Date.now() - killAt });
  // Chromium's helpers leave when their browser process dies; make sure.
  const leftovers = await waitFor("helpers to exit", async () => ((await processesFor(second.userData)).length === 0 ? "none" : null), 15_000).catch(() => "some");
  record("helpers left after SIGKILL", leftovers);

  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error?.stack || error);
  console.error(error);
  if (first?.child?.pid) {
    try { await screenshotWindow(first.child.pid, path.join(out, "failure.png")); } catch { /* best effort */ }
  }
} finally {
  writeFileSync(page, originalPage);
  for (const child of [first?.child, second?.child]) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nEvidence: ${out}`);
}
process.exit(result.ok ? 0 : 1);
