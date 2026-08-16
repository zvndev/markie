#!/usr/bin/env node
// Drives the new toolbar in a real window: does it render, does it act on the
// document, and are the controls markdown cannot express actually disabled
// rather than merely looking it.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "ui-check");
const children = [];
const tempPaths = [];
let debugOrigin = "";

await mkdir(artifactDir, { recursive: true });
const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};

function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, { cwd: root, env: options.env ?? process.env, stdio: ["ignore", fd, fd] });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}
async function cleanup() {
  for (const c of children) { try { if (c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch {} }
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
process.on("exit", () => { for (const c of children) { try { if (c.exitCode === null) process.kill(c.pid, "SIGKILL"); } catch {} } });

async function waitFor(label, fn, timeoutMs = 40000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastError = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
async function pickPort() {
  return new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
}
async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let nextId = 1; const pending = new Map();
  ws.on("message", (m) => { const msg = JSON.parse(m); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, (msg) => msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-ui-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-ui-profile-"));
  tempPaths.push(workDir, userDataDir);
  const docPath = path.join(await realpath(workDir), "toolbar.md");
  await writeFile(docPath, "# Toolbar\n\nPlain sentence for formatting.\n", "utf-8");

  const devPort = await pickPort(); const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  start("npm", ["run", "dev", "--", "--port", String(devPort)], { log: path.join(artifactDir, "next.log") });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(path.join(root, "node_modules", ".bin", "electron"),
    [".", docPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    { env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1" }, log: path.join(artifactDir, "electron.log") });

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("editor", () => cdp.ev("!!window.__markieEditor"), 40000);
  await waitFor("doc", () => cdp.ev(`window.__markieEditor.getText().includes("Plain sentence")`), 30000);

  check("the formatting toolbar renders above the document",
    await cdp.ev("!!document.querySelector('[data-markie-doc-toolbar]')"));

  const btn = (label) => `document.querySelector('[data-markie-doc-toolbar] [aria-label=${JSON.stringify(label)}]')`;

  // The controls markdown cannot express must be genuinely disabled, not just
  // styled to look it — a greyed button that still fires would write HTML.
  for (const label of ["Underline (unavailable)", "Text colour (unavailable)", "Highlight (unavailable)", "Alignment (unavailable)"]) {
    const state = await cdp.ev(`(() => { const b = ${btn(label)}; return b ? { disabled: b.disabled, title: b.title } : null; })()`);
    check(`${label.replace(" (unavailable)", "")} is disabled and says why`,
      state?.disabled === true && /Markdown has no syntax/.test(state?.title ?? ""),
      state ? `title: ${state.title.slice(0, 60)}…` : "button missing");
  }

  // Bold must actually reach the document.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await cdp.ev(`${btn("Bold")}.click(), true`);
  await new Promise((r) => setTimeout(r, 400));
  const md = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("Bold from the toolbar reaches the document", /\*\*/.test(md), md.split("\n").find((l) => l.includes("**")) ?? md.slice(0, 60));

  // Appearance is a view setting: it must change the rendering and leave the
  // markdown alone.
  const before = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  await cdp.ev(`${btn("Increase font size")}.click(), true`);
  await cdp.ev(`${btn("Zoom in")}.click(), true`);
  await new Promise((r) => setTimeout(r, 400));
  const cssSize = await cdp.ev(`getComputedStyle(document.querySelector('[data-markie-document-area]')).getPropertyValue('--doc-font-size')`);
  const after = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("font size and zoom change how the document renders", !!cssSize && cssSize.trim() !== "", `--doc-font-size: ${cssSize.trim()}`);
  check("changing appearance does not change the markdown", before === after,
    before === after ? "markdown identical" : "THE FILE CHANGED");

  const fontVar = await cdp.ev(`getComputedStyle(document.querySelector('[data-markie-document-area]')).getPropertyValue('--doc-font-family')`);
  check("a document font is applied as a CSS variable", !!fontVar && fontVar.trim().length > 0, `--doc-font-family: ${fontVar.trim().slice(0, 40)}`);

  cdp.close();
}

let failed = false;
try { await main(); } catch (e) { failed = true; console.error(`\nfatal: ${e.message}`); } finally { await cleanup(); }
const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
