#!/usr/bin/env node
// End-to-end check for "Reveal in Finder" on the open document.
//
// Driven through the real preload bridge in a real Electron window, because
// the interesting half of this feature is the refusal: revealing a file points
// the OS file manager at a path, so it must be limited to files the user
// actually opened in Markie. A unit test of the handler would not exercise the
// bridge, and the bridge is where a wiring mistake would hide.
//
//   node scripts/reveal-check.mjs
//
// Opens one Finder window for the passing case. That is the feature working.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("reveal-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `reveal-check-${stamp}`);
const children = [];
const tempPaths = [];
let debugOrigin = "http://127.0.0.1:9222";

await mkdir(artifactDir, { recursive: true });
const logPath = (name) => path.join(artifactDir, `${name}.log`);

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  if (options.log) {
    const stream = createWriteStream(options.log, { flags: "a" });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  }
  return child;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) return resolve();
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 1500);
        })
    )
  );
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`
  );
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools://")
  );
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else if (msg.result?.exceptionDetails)
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    )?.result?.value;
  return { send, ev, close: () => ws.close() };
}

// Ask Finder what it is actually showing. This is the only way to tell
// "revealed the document" from "brought Finder to the front", which look
// identical from inside the app.
function osascript(script) {
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out.trim()));
  });
}

async function closeFinderWindows() {
  await osascript('tell application "Finder" to close every window');
}

async function finderState() {
  const raw = await osascript(`
    tell application "Finder"
      set sel to "-"
      set win to "-"
      try
        if (count of selection) > 0 then set sel to POSIX path of (item 1 of selection as alias)
      end try
      try
        if (count of windows) > 0 then set win to POSIX path of (target of front Finder window as alias)
      end try
      return sel & "|" & win
    end tell
  `);
  const [selection, frontWindow] = raw.split("|");
  return {
    selection: selection === "-" ? null : selection,
    frontWindow: frontWindow === "-" ? null : frontWindow,
  };
}

// Finder reports resolved paths with a trailing slash on folders; /tmp is a
// symlink to /private/tmp. Compare what the user would call the same place.
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) =>
    p.replace(/\/+$/, "").replace(/^\/private\/tmp\//, "/tmp/");
  return norm(a) === norm(b);
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-reveal-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-reveal-profile-"));
  tempPaths.push(workDir, userDataDir);

  const docPath = path.join(await realpath(workDir), "reveal-me.md");
  await writeFile(docPath, "# Reveal me\n\ndrag this somewhere\n", "utf-8");

  // A file Markie was never given. Not secret, just never opened here, which
  // is exactly the case the grant check exists for.
  const unopened = path.join(await realpath(workDir), "never-opened.md");
  await writeFile(unopened, "# Not yours\n", "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    log: logPath("next"),
  });
  await waitFor(
    "Next dev renderer",
    async () => !!(await fetch(devOrigin).catch(() => null)),
    90000
  );

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  // Passed as a launch argument, which is the double-click route and grants
  // the file outright.
  start(
    electronBin,
    [
      ".",
      docPath,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
    ],
    {
      env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: logPath("electron"),
    }
  );

  const cdp = await waitFor("Electron CDP target", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor(
    "renderer boot",
    () => cdp.ev("document.readyState === 'complete' && !!document.body"),
    40000
  );
  await waitFor("preload", () => cdp.ev("!!window.electronAPI"), 30000);

  check(
    "the preload bridge exposes revealFile",
    (await cdp.ev("typeof window.electronAPI.revealFile")) === "function"
  );
  check(
    "the preload bridge exposes the menu subscription",
    (await cdp.ev("typeof window.electronAPI.onMenuReveal")) === "function"
  );

  await waitFor("editor boot", () => cdp.ev("!!window.__markieEditor"), 40000);
  await waitFor(
    "document loaded",
    () => cdp.ev(`window.__markieEditor.getText().includes("drag this somewhere")`),
    30000
  );

  // The document Markie has open: revealing it is the whole point.
  //
  // Asserting the return value alone proves nothing here. showItemInFolder
  // returns void, so {ok:true} only says the IPC ran; it says nothing about
  // where Finder ended up. An earlier version of this check stopped there and
  // passed while the feature was, from the user's side, opening a Finder window
  // onto the wrong place. Ask Finder instead.
  await closeFinderWindows();
  const opened = await cdp.ev(
    `window.electronAPI.revealFile(${JSON.stringify(docPath)})`
  );
  check(
    "revealing the open document succeeds",
    opened?.ok === true,
    JSON.stringify(opened)
  );

  // Finder opens the window and applies the selection asynchronously, so poll
  // rather than reading once and calling a slow reveal a broken one.
  let state = await finderState();
  for (let i = 0; i < 15 && !samePath(state.selection, docPath); i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    state = await finderState();
  }

  check(
    "Finder opens the folder the document is in",
    samePath(state.frontWindow, path.dirname(docPath)),
    `front window ${state.frontWindow ?? "(none)"}`
  );

  // Reported, not asserted. Finder's `selection` returns empty for a window it
  // has just created, whether the reveal came from Electron or from `open -R`,
  // and the same sequence run twice does not always agree. That is a limit of
  // reading Finder over AppleScript, not a statement about what is on screen,
  // so gating on it would only produce a test that fails at random.
  console.log(
    `  note  Finder reports selection: ${state.selection ?? "(none — see comment)"}`
  );

  // A file this window was never given must be refused, or "reveal" becomes a
  // way to ask the main process to point at any path the renderer names.
  const refused = await cdp.ev(
    `window.electronAPI.revealFile(${JSON.stringify(unopened)})`
  );
  check(
    "revealing a file Markie was never given is refused",
    !!refused?.error && refused?.ok !== true,
    JSON.stringify(refused)
  );

  const outside = await cdp.ev(
    `window.electronAPI.revealFile("/etc/hosts")`
  );
  check(
    "revealing an arbitrary system path is refused",
    !!outside?.error && outside?.ok !== true,
    JSON.stringify(outside)
  );

  cdp.close();
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nfatal: ${error.message}`);
} finally {
  await stopChildren();
  await Promise.all(
    tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {}))
  );
}

const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
console.log(`logs: ${artifactDir}`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
