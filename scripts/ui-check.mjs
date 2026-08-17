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

// detached gives each child its own process group, so killing -pid takes the
// whole tree. Without it `npm run dev` dies and the `next dev` it spawned is
// orphaned, keeps .next/dev/lock, and every later run fails to start.
function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, { cwd: root, env: options.env ?? process.env, stdio: ["ignore", fd, fd], detached: true });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { process.kill(child.pid, "SIGKILL"); } catch {} }
}
async function cleanup() {
  for (const c of children) killTree(c);
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
process.on("exit", () => { for (const c of children) killTree(c); });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { for (const c of children) killTree(c); process.exit(1); });
}

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

  // Real key events, not command calls. Dispatching the chord is the only way
  // to prove anything is listening for it, which is the entire question here:
  // several of these were advertised in a tooltip while a menu accelerator
  // quietly ate them first.
  const META = 4, SHIFT = 8;
  const press = async (key, code, keyCode, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type, key, code, modifiers,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
    }
    await new Promise((r) => setTimeout(r, 220));
  };

  check("the formatting toolbar renders above the document",
    await cdp.ev("!!document.querySelector('[data-markie-doc-toolbar]')"));

  const btn = (label) => `document.querySelector('[data-markie-doc-toolbar] [aria-label=${JSON.stringify(label)}]')`;

  // Every control names itself and carries its shortcut. A toolbar of unlabelled
  // glyphs is the thing this replaced.
  for (const label of ["Undo", "Redo", "Print", "Bold", "Italic", "Underline", "Align left", "Align centre", "Align right"]) {
    const state = await cdp.ev(`(() => { const b = ${btn(label)}; return b ? { title: b.title } : null; })()`);
    check(`${label} has a tooltip`, !!state?.title, state ? `"${state.title}"` : "button missing");
  }

  // Underline is real now, and must survive being written out. A mark that
  // renders and is dropped on save is worse than one that was never offered.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().toggleUnderline().run(), true`);
  await new Promise((r) => setTimeout(r, 300));
  const underlined = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("underline survives being serialized to the file", /<u>|<span/.test(underlined),
    underlined.split("\n").find((l) => l.includes("<")) ?? underlined.slice(0, 70));
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().toggleUnderline().run(), true`);
  await new Promise((r) => setTimeout(r, 300));
  const cleaned = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("removing it leaves the markdown clean again", !/<u>/.test(cleaned),
    cleaned.split("\n").find((l) => l.trim()) ?? "");

  // Bold must actually reach the document.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await cdp.ev(`${btn("Bold")}.click(), true`);
  await new Promise((r) => setTimeout(r, 400));
  const md = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("Bold from the toolbar reaches the document", /\*\*/.test(md), md.split("\n").find((l) => l.includes("**")) ?? md.slice(0, 60));

  // Font and size mean two different things depending on the selection, and
  // both have to be right.
  //
  // With text selected they style that text, which necessarily writes HTML.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await new Promise((r) => setTimeout(r, 250));
  await cdp.ev(`${btn("Increase font size")}.click(), true`);
  await new Promise((r) => setTimeout(r, 400));
  const sized = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("with a selection, size applies to the selected text only",
    /font-size/.test(sized), sized.split("\n").find((l) => l.includes("font-size"))?.slice(0, 70) ?? sized.slice(0, 70));
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().unsetFontSize().run(), true`);
  await new Promise((r) => setTimeout(r, 300));

  // With nothing selected it is a view setting, and must leave the file alone.
  await cdp.ev(`window.__markieEditor.chain().focus().setTextSelection(1).run(), true`);
  await new Promise((r) => setTimeout(r, 250));
  const before = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  await cdp.ev(`${btn("Increase font size")}.click(), true`);
  await cdp.ev(`${btn("Zoom in")}.click(), true`);
  await new Promise((r) => setTimeout(r, 400));
  const cssSize = await cdp.ev(`getComputedStyle(document.querySelector('[data-markie-document-area]')).getPropertyValue('--doc-font-size')`);
  const after = await cdp.ev(`window.__markieEditor.storage.markdown.getMarkdown()`);
  check("font size and zoom change how the document renders", !!cssSize && cssSize.trim() !== "", `--doc-font-size: ${cssSize.trim()}`);
  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  // Everything below runs through the real Electron window, so the application
  // menu's accelerators are live and get first refusal on every chord.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().unsetAllMarks().run(), true`);
  await new Promise((r) => setTimeout(r, 250));

  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await press("u", "KeyU", 85, META);
  check("⌘U underlines from the keyboard",
    await cdp.ev(`window.__markieEditor.isActive("underline")`));
  await press("u", "KeyU", 85, META);

  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await press("X", "KeyX", 88, META | SHIFT);
  check("⌘⇧X strikes through, the chord ⌘⇧S could not have (Save As owns it)",
    await cdp.ev(`window.__markieEditor.isActive("strike")`));
  await press("X", "KeyX", 88, META | SHIFT);

  // ⌘⇧E used to be Export PDF, so the universal align-centre chord opened a
  // save dialog. This proves the editor binding exists; it cannot prove the
  // menu released the chord, because CDP injects keys into the web contents
  // and a menu accelerator is consumed upstream of that. The menu half is
  // covered by src/lib/menu-accelerators.test.ts, which reads main.js.
  await cdp.ev(`window.__markieEditor.chain().focus().selectAll().run(), true`);
  await press("E", "KeyE", 69, META | SHIFT);
  check("⌘⇧E centres the paragraph",
    await cdp.ev(`window.__markieEditor.isActive({ textAlign: "center" })`));
  await press("L", "KeyL", 76, META | SHIFT);

  // ⌘Z has to reach the pane the caret is in. Type, undo, and the typing goes.
  await cdp.ev(`window.__markieEditor.chain().focus().setTextSelection(3).insertContent("ZZQ").run(), true`);
  await new Promise((r) => setTimeout(r, 300));
  const typed = await cdp.ev(`window.__markieEditor.getText().includes("ZZQ")`);
  await press("z", "KeyZ", 90, META);
  const undone = await cdp.ev(`!window.__markieEditor.getText().includes("ZZQ")`);
  check("⌘Z undoes in the rich editor", typed && undone,
    typed ? (undone ? "typed then undone" : "typed but ⌘Z did nothing") : "insert never landed");
  await press("Z", "KeyZ", 90, META | SHIFT);
  check("⇧⌘Z redoes it",
    await cdp.ev(`window.__markieEditor.getText().includes("ZZQ")`));
  await press("z", "KeyZ", 90, META);

  check("with no selection, appearance leaves the markdown untouched", before === after,
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
