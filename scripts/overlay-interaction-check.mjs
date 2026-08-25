#!/usr/bin/env node
// Focused interaction/visual check for keyboard-first overlays and menus.
// Launches Markie locally, drives real controls through CDP, captures
// screenshots, and fails when focus/selection affordances are not visible.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("overlay-interaction-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `overlay-interaction-check-${stamp}`);
const screenshotsDir = path.join(artifactDir, "screenshots");
const children = [];
const tempPaths = [];
let devOrigin = "http://localhost:3000";
let debugOrigin = "http://127.0.0.1:9222";

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

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) {
            resolve();
            return;
          }
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

async function switchMode(cdp, mode) {
  const label = `${mode[0].toUpperCase()}${mode.slice(1)} theme`;
  await clickCenter(cdp, `button[aria-label="${label}"]`);
  await waitFor(`${mode} color mode`, () =>
    cdp.ev(
      mode === "dark"
        ? "document.documentElement.classList.contains('dark')"
        : "!document.documentElement.classList.contains('dark')"
    )
  );
}

async function openPalette(cdp) {
  await cdp.ev("window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
  if (await cdp.ev("!!document.querySelector('input[placeholder^=\"Type a command\"]')")) return;
  for (const modifier of ["metaKey", "ctrlKey"]) {
    await cdp.ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ${modifier}: true, bubbles: true }))`);
    try {
      await waitFor("command palette", () => cdp.ev("!!document.querySelector('input[placeholder^=\"Type a command\"]')"), 1500);
      return;
    } catch {
      // try the other platform shortcut modifier
    }
  }
  await waitFor("command palette", () => cdp.ev("!!document.querySelector('input[placeholder^=\"Type a command\"]')"));
}

async function closeOverlay(cdp) {
  await cdp.ev(`(() => {
    document.querySelector('input[placeholder^="Type a command"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.activeElement
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (document.querySelector('input[placeholder^="Type a command"]')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(
    "command palette closed",
    () => cdp.ev("!document.querySelector('input[placeholder^=\"Type a command\"]')"),
    2000
  ).catch(() => {});
}

async function collectFocusMetric(cdp, label, selector) {
  return cdp.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { label: ${JSON.stringify(label)}, present: false };
    el.focus({ preventScroll: true });
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      label: ${JSON.stringify(label)},
      present: true,
      tag: el.tagName,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
      color: style.color,
      focused: document.activeElement === el,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  })()`);
}

async function runForMode(cdp, mode) {
  const screenshots = {};
  const metrics = [];

  await switchMode(cdp, mode);

  await clickCenter(cdp, 'button[aria-label="Export menu"]');
  await waitFor("PDF menu", () => cdp.ev("!![...document.querySelectorAll('button')].find((button) => button.textContent.includes('PDF (Dark)'))"));
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await waitFor("PDF menu dismissed by Escape", () => cdp.ev("![...document.querySelectorAll('button')].some((button) => button.textContent.includes('PDF (Dark)'))"));

  await clickCenter(cdp, 'button[aria-label="Export menu"]');
  await waitFor("PDF menu reopened", () => cdp.ev("!![...document.querySelectorAll('button')].find((button) => button.textContent.includes('PDF (Dark)'))"));
  metrics.push(await collectFocusMetric(cdp, `${mode} PDF menu item focus`, "button.markie-menu-item"));
  screenshots[`${mode}PdfMenu`] = await capture(cdp, `${mode}-01-pdf-menu`);
  await clickCenter(cdp, "[data-markie-document-area]");
  await waitFor("PDF menu dismissed by outside click", () => cdp.ev("![...document.querySelectorAll('button')].some((button) => button.textContent.includes('PDF (Dark)'))"));

  await cdp.ev("document.querySelector('button')?.focus()");
  await openPalette(cdp);
  await cdp.ev("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
  await waitFor("palette selected second row", () =>
    cdp.ev("document.querySelectorAll('[role=\"option\"]')[1]?.getAttribute('aria-selected') === 'true'")
  );
  screenshots[`${mode}CommandPalette`] = await capture(cdp, `${mode}-02-command-palette`);
  metrics.push(await collectFocusMetric(cdp, `${mode} command input focus`, "input[placeholder^='Type a command']"));
  metrics.push(await cdp.ev(`(() => {
    const row = document.querySelector('[role="option"][aria-selected="true"]');
    if (!row) return { label: ${JSON.stringify(`${mode} selected command row`)}, present: false };
    row.focus({ preventScroll: true });
    const style = getComputedStyle(row);
    return {
      label: ${JSON.stringify(`${mode} selected command row`)},
      present: true,
      focused: document.activeElement === row,
      selected: row.getAttribute('aria-selected') === 'true',
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
      color: style.color
    };
  })()`));
  await closeOverlay(cdp);

  await openPalette(cdp);
  await cdp.ev(`(() => {
    const input = document.querySelector('input[placeholder^="Type a command"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'settings');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("settings command result", () => cdp.ev("[...document.querySelectorAll('[role=\"option\"]')].some((row) => row.textContent.includes('Settings'))"));
  await cdp.ev(`(() => {
    const input = document.querySelector('input[placeholder^="Type a command"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor("settings overlay", () => cdp.ev("!!document.querySelector('#markie-settings-title')"));
  metrics.push(await collectFocusMetric(cdp, `${mode} settings close focus`, "button[aria-label='Close settings']"));
  screenshots[`${mode}Settings`] = await capture(cdp, `${mode}-03-settings`);
  await clickCenter(cdp, "button[aria-label='Close settings']");
  await waitFor("settings overlay closed", () => cdp.ev("!document.querySelector('#markie-settings-title')"));

  await clickCenter(cdp, 'button[aria-label="Theme presets"]');
  await waitFor("theme settings overlay", () => cdp.ev(`(() => {
    const appearance = [...document.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent === 'Appearance');
    return !!document.querySelector('#markie-settings-title') && appearance?.getAttribute('aria-selected') === 'true';
  })()`));
  metrics.push(await collectFocusMetric(cdp, `${mode} theme preset focus`, ".markie-overlay-button"));
  metrics.push(await collectFocusMetric(cdp, `${mode} theme color field focus`, "input[type='color']"));
  screenshots[`${mode}ThemeSettings`] = await capture(cdp, `${mode}-04-theme-settings`);
  await clickCenter(cdp, "button[aria-label='Close settings']");
  await waitFor("theme settings overlay closed", () => cdp.ev("!document.querySelector('#markie-settings-title')"));

  await openPalette(cdp);
  await cdp.ev(`(() => {
    const input = document.querySelector('input[placeholder^="Type a command"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'stat');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("statistics command result", () => cdp.ev("[...document.querySelectorAll('[role=\"option\"]')].some((row) => row.textContent.includes('Statistics'))"));
  await cdp.ev(`(() => {
    const input = document.querySelector('input[placeholder^="Type a command"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await waitFor("stats overlay", () => cdp.ev("!!document.querySelector('[aria-label=\"Document statistics\"]')"));
  metrics.push(await collectFocusMetric(cdp, `${mode} stats close focus`, "button[aria-label='Close statistics']"));
  screenshots[`${mode}Stats`] = await capture(cdp, `${mode}-05-stats`);
  await clickCenter(cdp, "button[aria-label='Close statistics']");
  await waitFor("stats overlay closed", () => cdp.ev("!document.querySelector('[aria-label=\"Document statistics\"]')"));

  return { screenshots, metrics };
}

async function verifyWorkspaceFlow(cdp, homeDir) {
  await clickCenter(cdp, 'button[aria-label="Library — recent & files (⌘L)"]');
  await waitFor("Library panel", () => cdp.ev("!!document.querySelector('.markie-side-panel')"));
  await clickCenter(cdp, 'button[data-library-tab="files"]');
  await waitFor("default workspace new file action", () =>
    cdp.ev("!!document.querySelector('[data-workspace-new-file]')")
  );
  await clickCenter(cdp, "[data-workspace-new-file]");
  await waitFor("new file name input", () =>
    cdp.ev("!!document.querySelector('[data-workspace-new-file-input]')")
  );
  await cdp.ev(`(() => {
    const input = document.querySelector('[data-workspace-new-file-input]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'window-flow.md');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  // The docked panel is navigation chrome, not an overlay: page.tsx keeps it
  // open across a document swap on purpose, so browsing file-to-file does not
  // slam it shut. The check asserts that, not the old close-on-open.
  await waitFor("new workspace file opened with the panel still docked", () =>
    cdp.ev("document.title.startsWith('window-flow.md') && !!document.querySelector('.markie-side-panel')")
  );
  const openedScreenshot = await capture(cdp, "workspace-01-created-file-open");

  const createdPath = path.join(homeDir, "Documents", "Markie", "window-flow.md");
  const createdContent = await readFile(createdPath, "utf8");

  // No reopen click: the panel never closed. Clicking the rail button here
  // would collapse it instead.
  await clickCenter(cdp, 'button[data-library-tab="files"]');
  await waitFor("workspace file action", () =>
    cdp.ev("!!document.querySelector('[data-file-actions-trigger]')")
  );
  await clickCenter(cdp, "[data-file-actions-trigger]");
  await waitFor("workspace action menu", () =>
    cdp.ev("[...document.querySelectorAll('button')].some((button) => button.textContent === 'Copy path')")
  );
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await waitFor("workspace action menu dismissed", () =>
    cdp.ev("![...document.querySelectorAll('button')].some((button) => button.textContent === 'Copy path')")
  );

  await clickCenter(cdp, "[data-file-actions-trigger]");
  await waitFor("workspace action menu reopened", () =>
    cdp.ev("[...document.querySelectorAll('button')].some((button) => button.textContent === 'Copy path')")
  );
  await clickCenter(cdp, 'button[aria-label="Browse all markdown"]');
  await waitFor("Browse navigation", () =>
    cdp.ev("document.querySelector('.markie-side-panel')?.textContent.includes('Browse') && ![...document.querySelectorAll('button')].some((button) => button.textContent === 'Copy path')")
  );
  const navigationScreenshot = await capture(cdp, "workspace-02-browse-navigation");
  await clickCenter(cdp, 'button[aria-label="Browse all markdown"]');
  await waitFor("side panel collapsed", () => cdp.ev("!document.querySelector('.markie-side-panel')"));

  return {
    createdPath,
    createdContentLength: createdContent.length,
    openedTitle: await cdp.ev("document.title"),
    screenshots: { openedScreenshot, navigationScreenshot },
  };
}

function metricFailures(metrics) {
  return metrics.flatMap((metric) => {
    const failures = [];
    if (!metric.present) {
      failures.push(`${metric.label}: target missing`);
      return failures;
    }
    if (metric.label.includes("selected command row") && !metric.selected) {
      failures.push(`${metric.label}: row is not keyboard-selected`);
    }
    if (!metric.focused) failures.push(`${metric.label}: target could not receive focus`);
    if (!metric.boxShadow || metric.boxShadow === "none") {
      failures.push(`${metric.label}: no visible focus ring box-shadow`);
    }
    return failures;
  });
}

async function main() {
  const devPort = await pickPort();
  const debugPort = await pickPort();
  devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-overlay-check-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-overlay-home-"));
  tempPaths.push(userDataDir, homeDir);

  start("npm", ["run", "dev", "--", "--port", String(devPort)], { log: logPath("next") });
  await waitFor("Next dev renderer", async () => {
    const res = await fetch(devOrigin).catch(() => null);
    return !!res;
  }, 60000);

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  start(electronBin, [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`], {
    env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1" },
    log: logPath("electron"),
  });

  const cdp = await waitFor("Electron CDP app target", cdpConnect, 30000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete' && !!document.body"), 30000);
  await waitFor("toolbar boot", () => cdp.ev("!!document.querySelector('button[aria-label=\"Theme presets\"]')"), 30000);

  const dragRegions = await cdp.ev(`(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        region: getComputedStyle(el).webkitAppRegion,
      };
    };
    const toolbar = rect('[data-window-drag-surface]');
    const handle = rect('[data-window-drag-handle]');
    const file = rect('[data-window-control-region="file"]');
    const mode = rect('[data-window-control-region="mode"]');
    const documentControls = rect('[data-window-control-region="document"]');
    const dragGap = file && mode && documentControls
      ? Math.max(0, mode.left - file.right) + Math.max(0, documentControls.left - mode.right)
      : 0;
    return { toolbar, handle, file, mode, documentControls, dragGap };
  })()`);
  if (
    !dragRegions?.toolbar ||
    dragRegions.toolbar.region !== "drag" ||
    dragRegions.handle?.region !== "drag" ||
    dragRegions.file?.region !== "no-drag" ||
    dragRegions.mode?.region !== "no-drag" ||
    dragRegions.documentControls?.region !== "no-drag" ||
    dragRegions.dragGap < 80
  ) {
    throw new Error(`window drag region check failed: ${JSON.stringify(dragRegions)}`);
  }

  const workspaceFlow = await verifyWorkspaceFlow(cdp, homeDir);

  const light = await runForMode(cdp, "light");
  const dark = await runForMode(cdp, "dark");
  const metrics = [...light.metrics, ...dark.metrics];
  const failures = metricFailures(metrics);
  const screenshots = { ...light.screenshots, ...dark.screenshots };
  const artifact = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    artifactDir,
    screenshots,
    dragRegions,
    workspaceFlow,
    metrics,
    failures,
  };
  const artifactPath = path.join(artifactDir, "overlay-interaction.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (failures.length) {
    throw new Error(`overlay interaction check failed: ${failures.join("; ")}`);
  }

  console.log(JSON.stringify({ ok: true, artifact: artifactPath, screenshots, metrics }, null, 2));
  cdp.close();
}

try {
  await main();
} finally {
  await stopChildren();
  await Promise.allSettled(tempPaths.map((p) => rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })));
}
