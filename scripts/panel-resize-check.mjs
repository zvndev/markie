#!/usr/bin/env node
// Focused interaction check for the drag-resizable left library panel.
// Launches Markie locally, drives the resize handle through CDP with real
// pointer events, and fails when the width does not follow the pointer, does
// not clamp, or does not survive a relaunch.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("panel-resize-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `panel-resize-check-${stamp}`);
const screenshotsDir = path.join(artifactDir, "screenshots");
const children = [];
const tempPaths = [];
let devOrigin = "http://localhost:3000";
let debugOrigin = "http://127.0.0.1:9222";

const PANEL = ".markie-side-panel";
const HANDLE = "[data-left-panel-resizer]";
const LIBRARY_BUTTON = 'button[aria-label="Library — recent & files (⌘L)"]';
const WIDTH_KEY = "markie.leftpanel.width.v1";
const DEFAULT_WIDTH = 252;
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;

await mkdir(screenshotsDir, { recursive: true });

function logPath(name) {
  return path.join(artifactDir, `${name}.log`);
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
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

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 2000);
  });
}

async function stopChildren() {
  await Promise.all(children.map(stopChild));
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("could not allocate a port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find(
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("devtools://") &&
      (target.url.startsWith("app://") || target.url.startsWith(devOrigin) || target.url.startsWith("http://localhost:3000"))
  );
  if (!page) return null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  let nextId = 1;
  const pending = new Map();
  ws.on("message", (message) => {
    const msg = JSON.parse(message);
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
        else if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  };

  return { send, ev, close: () => ws.close() };
}

async function capture(cdp, name) {
  await cdp.send("Page.bringToFront");
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const file = path.join(screenshotsDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
}

async function clickCenter(cdp, selector) {
  const rect = await cdp.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`missing click target: ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
}

async function panelWidth(cdp) {
  return cdp.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(PANEL)});
    return el ? Math.round(el.getBoundingClientRect().width) : null;
  })()`);
}

async function openPanel(cdp) {
  if (!(await cdp.ev(`!!document.querySelector(${JSON.stringify(PANEL)})`))) {
    await clickCenter(cdp, LIBRARY_BUTTON);
  }
  try {
    await waitFor("library panel resize handle", () => cdp.ev(`!!document.querySelector(${JSON.stringify(HANDLE)})`), 10000);
  } catch (error) {
    const dom = await cdp.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(PANEL)});
      return el ? el.outerHTML.slice(0, 600) : "no side panel in the DOM";
    })()`);
    throw new Error(`${error.message}\npanel DOM: ${dom}`);
  }
}

// Real pointer events: the handle uses pointer capture, so the move/up have to
// carry the same pointer the press started.
async function dragHandle(cdp, dx) {
  const rect = await cdp.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(HANDLE)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error("missing resize handle");
  const common = { button: "left", buttons: 1, pointerType: "mouse", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, ...common });
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x + (dx * i) / steps,
      y: rect.y,
      ...common,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x + dx,
    y: rect.y,
    ...common,
    buttons: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return panelWidth(cdp);
}

async function bootRenderer(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete' && !!document.body"), 30000);
  await waitFor("activity bar boot", () => cdp.ev(`!!document.querySelector(${JSON.stringify(LIBRARY_BUTTON)})`), 30000);
}

function startElectron(debugPort, userDataDir, homeDir) {
  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  return start(electronBin, [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`], {
    env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1" },
    log: logPath("electron"),
  });
}

async function main() {
  const devPort = await pickPort();
  const debugPort = await pickPort();
  devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-panel-check-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-panel-home-"));
  tempPaths.push(userDataDir, homeDir);

  start("npm", ["run", "dev", "--", "--port", String(devPort)], { log: logPath("next") });
  await waitFor("Next dev renderer", async () => {
    const res = await fetch(devOrigin).catch(() => null);
    return !!res;
  }, 60000);

  let electron = startElectron(debugPort, userDataDir, homeDir);
  let cdp = await waitFor("Electron CDP app target", cdpConnect, 30000);
  await bootRenderer(cdp);
  await openPanel(cdp);

  const failures = [];
  const check = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
    return actual;
  };

  const startWidth = check("default width", await panelWidth(cdp), DEFAULT_WIDTH);
  const screenshots = { default: await capture(cdp, "panel-default") };

  // The handle must not sit on the window's drag surface, and must advertise a
  // resize cursor — otherwise the drag would move the window instead.
  const handleGeometry = await cdp.ev(`(() => {
    const handle = document.querySelector(${JSON.stringify(HANDLE)});
    if (!handle) return null;
    const drag = document.querySelector('[data-window-drag-surface]');
    const style = getComputedStyle(handle);
    const box = handle.getBoundingClientRect();
    return {
      region: style.webkitAppRegion,
      cursor: style.cursor,
      role: handle.getAttribute('role'),
      top: box.top,
      dragBottom: drag ? drag.getBoundingClientRect().bottom : 0,
    };
  })()`);
  if (!handleGeometry) failures.push("resize handle: missing");
  else {
    if (handleGeometry.region === "drag") failures.push("resize handle: sits on the window drag region");
    if (handleGeometry.cursor !== "col-resize") failures.push(`resize handle: cursor is ${handleGeometry.cursor}`);
    if (handleGeometry.role !== "separator") failures.push(`resize handle: role is ${handleGeometry.role}`);
    if (handleGeometry.top < handleGeometry.dragBottom) failures.push("resize handle: overlaps the titlebar drag surface");
  }

  const widened = check("drag +120", await dragHandle(cdp, 120), startWidth + 120);
  screenshots.widened = await capture(cdp, "panel-widened");

  // Dragging hard left clamps at the minimum. It must NOT collapse the panel.
  const narrowed = check("drag -400 clamps at min", await dragHandle(cdp, -400), MIN_WIDTH);
  if (!(await cdp.ev(`!!document.querySelector(${JSON.stringify(PANEL)})`))) {
    failures.push("drag past the minimum collapsed the panel");
  }
  screenshots.minimum = await capture(cdp, "panel-minimum");

  const viewportMax = await cdp.ev(
    `Math.max(${MIN_WIDTH}, Math.min(${MAX_WIDTH}, Math.round(window.innerWidth * 0.45)))`
  );
  check("drag +900 clamps at max", await dragHandle(cdp, 900), viewportMax);

  await cdp.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(HANDLE)});
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check("double-click resets", await panelWidth(cdp), DEFAULT_WIDTH);

  // Keyboard separator semantics: four right arrows = four 16px steps.
  await cdp.ev(`document.querySelector(${JSON.stringify(HANDLE)}).focus()`);
  for (let i = 0; i < 4; i += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const keyboardWidth = check("4x ArrowRight", await panelWidth(cdp), DEFAULT_WIDTH + 64);
  check(
    "aria-valuenow",
    await cdp.ev(`document.querySelector(${JSON.stringify(HANDLE)}).getAttribute('aria-valuenow')`),
    String(DEFAULT_WIDTH + 64)
  );
  check(
    "stored width",
    await cdp.ev(`localStorage.getItem(${JSON.stringify(WIDTH_KEY)})`),
    String(DEFAULT_WIDTH + 64)
  );
  screenshots.keyboard = await capture(cdp, "panel-keyboard");

  // Relaunch with the same profile: the panel is unmounted while collapsed, so
  // the width has to come back from storage rather than from React state.
  cdp.close();
  await stopChild(electron);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  electron = startElectron(debugPort, userDataDir, homeDir);
  cdp = await waitFor("relaunched Electron CDP app target", cdpConnect, 30000);
  await bootRenderer(cdp);
  await openPanel(cdp);
  const restored = check("width after relaunch", await panelWidth(cdp), keyboardWidth);
  screenshots.restored = await capture(cdp, "panel-restored");

  const artifact = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    artifactDir,
    screenshots,
    handleGeometry,
    widths: { startWidth, widened, narrowed, viewportMax, keyboardWidth, restored },
    failures,
  };
  const artifactPath = path.join(artifactDir, "panel-resize.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (failures.length) {
    throw new Error(`panel resize check failed: ${failures.join("; ")}`);
  }

  console.log(JSON.stringify({ ok: true, artifact: artifactPath, screenshots, widths: artifact.widths }, null, 2));
  cdp.close();
}

try {
  await main();
} finally {
  await stopChildren();
  await Promise.allSettled(tempPaths.map((p) => rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })));
}
