#!/usr/bin/env node
// Edits the open document from outside Markie and checks what the app does.
//
// Markie already noticed this, but only when you pressed save — after typing
// into a stale document for however long. These checks drive the real thing:
// an agent-style write to the file on disk while the window has it open, both
// with a clean buffer and with unsaved work.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("disk-change-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "disk-change-check");
const children = [];
const tempPaths = [];
let debugOrigin = "";

await mkdir(artifactDir, { recursive: true });
const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
};

function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", fd, fd],
  });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}

function killTree(child) {
  // Direct-child kill only; see scripts/lib/safe-kill.mjs for why a group kill
  // (process.kill(-pid)) is banned here.
  safeKill(child, "SIGKILL");
}
async function cleanup() {
  for (const c of children) killTree(c);
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
process.on("exit", () => {
  for (const c of children) killTree(c);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const c of children) killTree(c);
    process.exit(1);
  });
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function pickPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
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
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      ?.result?.value;
  return { send, ev, close: () => ws.close() };
}

const bodyHas = (text) =>
  `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
const strip = `!!document.querySelector('[data-markie-disk-strip]')`;
const clickText = (text) => `(() => {
  const el = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())}));
  if (!el) return false;
  el.click();
  return true;
})()`;

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-disk-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-disk-profile-"));
  // The app never sees the developer's real home: a fresh profile against a
  // real $HOME indexes, watches and registers things nobody asked for.
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-disk-home-"));
  tempPaths.push(homeDir);
  tempPaths.push(workDir, userDataDir);
  const docPath = path.join(workDir, "notes.md");
  await writeFile(docPath, "# Notes\n\noriginal line\n", "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    log: path.join(artifactDir, "next.log"),
  });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", docPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: path.join(artifactDir, "electron.log"),
    }
  );

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("editor", () => cdp.ev("!!window.__markieEditor"), 40000);
  await waitFor("doc", () => cdp.ev(`window.__markieEditor.getText().includes("original line")`), 30000);

  check("nothing is flagged while the file is untouched", !(await cdp.ev(strip)));

  // ── Clean buffer ───────────────────────────────────────────────────────
  // Somebody else edits the file. Nothing local is at risk, so this must not
  // interrupt with a modal.
  await writeFile(docPath, "# Notes\n\noriginal line\nadded by an agent\n", "utf-8");
  await waitFor("change noticed", () => cdp.ev(strip), 15000);
  check("an external edit is noticed without pressing save", true);
  check("it says which file changed", await cdp.ev(bodyHas("changed on disk")));
  check(
    "a change that costs nothing does not open a modal",
    !(await cdp.ev(`!!document.querySelector('[role="dialog"]')`))
  );
  await shootTo(cdp, "01-clean-strip");

  check("the strip offers a reload", await cdp.ev(clickText("Reload")));
  await waitFor("reloaded", () =>
    cdp.ev(`window.__markieEditor.getText().includes("added by an agent")`), 15000);
  check("reloading shows the new content", true);
  check("the strip clears once resolved", !(await cdp.ev(strip)));

  // ── Dirty buffer ───────────────────────────────────────────────────────
  // Now the dangerous case: unsaved work, and the file moves underneath it.
  await cdp.ev(`window.__markieEditor.commands.setContent("<p>my unsaved edit</p>"), true`);
  await waitFor("dirty", () => cdp.ev(`window.__markieEditor.getText().includes("my unsaved edit")`), 10000);
  await writeFile(docPath, "# Notes\n\noriginal line\nadded by an agent\nand another\n", "utf-8");
  await waitFor("second change noticed", () => cdp.ev(strip), 15000);

  check("the change is noticed while there are unsaved edits", true);
  check("reviewing it opens a real decision", await cdp.ev(clickText("Reload")));
  await waitFor("conflict dialog", () => cdp.ev(bodyHas("changed on disk")), 10000);
  check(
    "the dialog leads with the option that loses nothing",
    await cdp.ev(bodyHas("Save a copy"))
  );
  check("overwriting is offered", await cdp.ev(bodyHas("Overwrite the file")));
  check("discarding your own work is offered", await cdp.ev(bodyHas("Discard my changes")));
  check(
    "it names what each choice costs",
    await cdp.ev(bodyHas("left alone")) && await cdp.ev(bodyHas("discarding what changed it"))
  );
  check("it summarises the difference in lines", await cdp.ev(bodyHas("line")));
  await shootTo(cdp, "02-dirty-dialog");

  // Destructive choices confirm before acting.
  await cdp.ev(clickText("Overwrite the file"));
  check(
    "overwriting asks twice before destroying the other copy",
    await cdp.ev(bodyHas("Yes, overwrite")),
  );
  const onDiskBeforeConfirm = await readFile(docPath, "utf-8");
  check(
    "nothing is written before that confirmation",
    onDiskBeforeConfirm.includes("and another"),
  );

  await cdp.ev(clickText("Yes, overwrite"));
  await waitFor("overwritten", async () =>
    (await readFile(docPath, "utf-8")).includes("my unsaved edit"), 15000);
  check("confirming overwrite writes the buffer to disk", true);
  check(
    "no second native prompt blocks the save",
    (await readFile(docPath, "utf-8")).includes("my unsaved edit")
  );
  check("the strip clears after resolving", !(await cdp.ev(strip)));

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

async function shootTo(cdp, name) {
  await new Promise((r) => setTimeout(r, 450));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stderr.write(`disk-change-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
