#!/usr/bin/env node
// Focused visual/layout check for the editor and document canvas. It launches
// Markie locally, drives the real renderer through CDP, captures screenshots,
// and fails on obvious overlap, clipping, or split-pane sizing regressions.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("document-canvas-layout-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `document-layout-check-${stamp}`);
const screenshotsDir = path.join(artifactDir, "screenshots");
const children = [];
const tempPaths = [];
let devOrigin = "http://localhost:3000";
let debugOrigin = "http://127.0.0.1:9222";

const fixture = `# A very long planning heading that should wrap cleanly inside the Markie document canvas without clipping or pushing split mode sideways even when the desktop window is compact

Markie should feel calm with common Markdown: **bold text**, [links](https://markie.app), inline \`code\`, and paragraphs that use normal reading width instead of stretching edge to edge.

## Split mode balance

This paragraph intentionally includes a long-unbroken-token-for-layout-verification-abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789 so the rich canvas and source editor prove they wrap or scroll internally instead of overlapping nearby UI.

| Column | Status | Notes |
| --- | --- | --- |
| Reading width | Done | The canvas stays centered and bounded. |
| Split mode | Done | Source and rich panes keep usable widths. |

\`\`\`ts
const message = "code blocks scroll horizontally when needed without breaking the canvas";
console.log(message);
\`\`\`

- [x] Preserve common Markdown examples
- [ ] Keep empty editor affordances readable
`;

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

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function clickMode(cdp, label) {
  await cdp.ev(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.getAttribute('aria-label') || node.textContent || '').includes(${JSON.stringify(label)}));
    button?.click();
    return !!button;
  })()`);
}

async function collectMetrics(cdp, label) {
  return cdp.ev(`(() => {
    const rectOf = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom)
      };
    };
    const area = document.querySelector('[data-markie-document-area]');
    const source = document.querySelector('[data-markie-source-pane]');
    const rich = document.querySelector('[data-markie-rich-pane]');
    const canvas = document.querySelector('[data-markie-rich-canvas]');
    const heading = document.querySelector('[data-markie-rich-canvas] h1');
    const sourceContent = document.querySelector('.cm-content');
    const placeholder = document.querySelector('.ProseMirror p.is-editor-empty:first-child');
    const nodes = [...document.querySelectorAll('[data-markie-document-area], [data-markie-source-pane], [data-markie-rich-pane], [data-markie-rich-canvas], .cm-content, .markdown-body h1, .markdown-body pre, .markdown-body table')];
    const viewportWidth = window.innerWidth;
    const overflows = nodes
      .map((node) => ({ tag: node.tagName, className: node.className, text: (node.textContent || '').trim().slice(0, 80), rect: rectOf(node) }))
      .filter((item) => item.rect && (item.rect.x < -1 || item.rect.right > viewportWidth + 1));
    const areaRect = rectOf(area);
    const sourceRect = rectOf(source);
    const richRect = rectOf(rich);
    const overlap = sourceRect && richRect
      ? !(sourceRect.right <= richRect.x + 1 || richRect.right <= sourceRect.x + 1 || sourceRect.bottom <= richRect.y + 1 || richRect.bottom <= sourceRect.y + 1)
      : false;
    const splitGap = sourceRect && richRect ? Math.abs(sourceRect.right - richRect.x) : null;
    const canvasRect = rectOf(canvas);
    return {
      label: ${JSON.stringify(label)},
      viewport: { width: window.innerWidth, height: window.innerHeight },
      area: areaRect,
      source: sourceRect,
      rich: richRect,
      canvas: canvasRect,
      heading: rectOf(heading),
      sourceContent: rectOf(sourceContent),
      placeholder: rectOf(placeholder),
      overflows,
      overlap,
      splitGap,
      canvasWithinRich: !canvasRect || !richRect || (canvasRect.x >= richRect.x - 1 && canvasRect.right <= richRect.right + 1),
      canvasReasonableWidth: !canvasRect || canvasRect.width <= Math.min(820, Math.max(320, window.innerWidth - 96)),
      singlePaneFillsArea: !areaRect || !!(sourceRect && richRect) || (
        sourceRect
          ? Math.abs(sourceRect.width - areaRect.width) <= 2
          : richRect
            ? Math.abs(richRect.width - areaRect.width) <= 2
            : true
      ),
      sourceUsableWidth: !sourceRect || sourceRect.width >= 260,
      richUsableWidth: !richRect || richRect.width >= 300
    };
  })()`);
}

async function main() {
  const devPort = await pickPort();
  const debugPort = await pickPort();
  devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-document-layout-"));
  tempPaths.push(userDataDir);

  start("npm", ["run", "dev", "--", "--port", String(devPort)], { log: logPath("next") });
  await waitFor("Next dev renderer", async () => {
    const res = await fetch(devOrigin).catch(() => null);
    return !!res;
  }, 60000);

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  start(electronBin, [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`], {
    env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1" },
    log: logPath("electron"),
  });

  const cdp = await waitFor("Electron CDP app target", cdpConnect, 30000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete' && !!document.body"), 30000);
  await waitFor("editor boot", () => cdp.ev("!!window.__markieEditor && !!document.querySelector('[data-markie-rich-canvas]')"), 30000);

  await cdp.ev(`window.__markieEditor.commands.setContent(${JSON.stringify(fixture)})`);
  await waitFor("fixture heading", () => cdp.ev("document.querySelector('[data-markie-rich-canvas] h1')?.textContent.includes('very long planning heading')"));

  const screenshots = {};
  const metrics = [];

  await setViewport(cdp, 1180, 760);
  screenshots.previewNormal = await capture(cdp, "01-preview-normal");
  metrics.push(await collectMetrics(cdp, "preview normal"));

  await clickMode(cdp, "Split mode");
  await waitFor("split mode", () => cdp.ev("!!document.querySelector('[data-markie-source-pane]') && !!document.querySelector('[data-markie-rich-pane]')"));
  screenshots.splitNormal = await capture(cdp, "02-split-normal");
  metrics.push(await collectMetrics(cdp, "split normal"));

  await setViewport(cdp, 760, 720);
  screenshots.splitCompact = await capture(cdp, "03-split-compact");
  metrics.push(await collectMetrics(cdp, "split compact"));

  await clickMode(cdp, "Edit mode");
  await waitFor("edit mode", () => cdp.ev("!!document.querySelector('[data-markie-source-pane]') && !document.querySelector('[data-markie-rich-pane]')"));
  screenshots.editCompact = await capture(cdp, "04-edit-compact");
  metrics.push(await collectMetrics(cdp, "edit compact"));

  await clickMode(cdp, "View");
  await waitFor("view mode", () => cdp.ev("!!document.querySelector('[data-markie-rich-pane]') && !document.querySelector('[data-markie-source-pane]')"));
  await cdp.ev("window.__markieEditor.commands.clearContent()");
  await waitFor("empty placeholder", () => cdp.ev("!!document.querySelector('.ProseMirror p.is-editor-empty:first-child')"));
  screenshots.emptyCompact = await capture(cdp, "05-empty-compact");
  metrics.push(await collectMetrics(cdp, "empty compact"));

  const failures = metrics.flatMap((metric) => {
    const issues = [];
    if (metric.overflows.length) issues.push(`${metric.label}: ${metric.overflows.length} document nodes overflow the viewport`);
    if (metric.overlap) issues.push(`${metric.label}: source and rich panes overlap`);
    if (metric.splitGap !== null && metric.splitGap > 2) issues.push(`${metric.label}: split panes have a ${metric.splitGap}px gap`);
    if (!metric.singlePaneFillsArea) issues.push(`${metric.label}: single document pane does not fill the document area`);
    if (!metric.canvasWithinRich) issues.push(`${metric.label}: rich canvas escapes its pane`);
    if (!metric.canvasReasonableWidth) issues.push(`${metric.label}: rich canvas width is not bounded`);
    if (metric.source && metric.rich && !metric.sourceUsableWidth) issues.push(`${metric.label}: source pane is below usable width`);
    if (metric.source && metric.rich && !metric.richUsableWidth) issues.push(`${metric.label}: rich pane is below usable width`);
    return issues;
  });

  const artifact = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    artifactDir,
    screenshots,
    metrics,
    failures,
  };
  const artifactPath = path.join(artifactDir, "document-layout.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (failures.length) {
    throw new Error(`document layout check failed: ${failures.join("; ")}`);
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
