#!/usr/bin/env node
// The document size tiers in a real window (electron/doc-tiers.js).
//
// Opens a generated 4.4 MB document and asserts the renderer keeps answering
// (a trivial evaluate inside 200 ms, once a second, for ten seconds) while it
// opens in Source view with Rich unavailable; switches back to a small
// document and asserts that completes inside a second; asks for a file over
// the cap and asserts it is refused with the message. It also opens a document
// just under the large line and reports how long that took to land in the rich
// pane, which is the number that decides whether the line is in the right
// place.
//
// Usage: MARKIE_ALLOW_E2E=1 npm run large-doc:check
import { mkdir, mkdtemp, open as openFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { endRun, launchElectron } from "./lib/electron-window.mjs";
import { generateMarkdown } from "./lib/markdown-fixture.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("large-doc-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "large-doc-check");
let stopRenderer = () => {};
let closeWindow = async () => {};
const tempPaths = [];
let debugOrigin = "";

const LARGE_BYTES = 4_400_000;
const ALMOST_BYTES = 950_000;
const SMALL_BYTES = 30_000;
const HUGE_BYTES = 101_000_000;
const SAMPLE_DEADLINE_MS = 200;
const SAMPLE_SECONDS = 10;

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};
const note = (line) => process.stdout.write(`       ${line}\n`);

async function cleanup() {
  await closeWindow();
  stopRenderer();
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
// A run killed outright cannot ask the window to quit, but each helper signals
// what it spawned from its own exit handler, which a bare signal would skip.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs = 40000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await sleep(100);
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

// A CDP client whose requests carry deadlines and never reject: a renderer
// that does not answer is a measurement here, not a failure of the harness.
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
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      settle(msg);
    }
  });
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve) => {
      const id = nextId++;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        resolve({ ok: false, timedOut: true });
      }, timeoutMs);
      pending.set(id, (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (msg.error) resolve({ ok: false, error: JSON.stringify(msg.error) });
        else resolve({ ok: true, result: msg.result });
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  // Throws on a harness-side failure, returns the value otherwise. Use `probe`
  // when a timeout is itself the answer.
  const ev = async (expr, timeoutMs = 30000) => {
    const reply = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (!reply.ok) throw new Error(reply.timedOut ? `evaluate timed out after ${timeoutMs} ms` : reply.error);
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  };
  const probe = async (expr, timeoutMs) => {
    const reply = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, timeoutMs);
    return reply.ok ? { ok: true, value: reply.result?.result?.value } : { ok: false };
  };
  return { send, ev, probe, close: () => ws.close() };
}

const rowClick = (docPath) =>
  `(() => { const s = document.querySelector('span[title=' + ${JSON.stringify(JSON.stringify(docPath))} + ']');` +
  ` const row = s && s.closest('div.group'); if (!row) return false; row.click(); return true; })()`;
const titled = (name) => `document.title.startsWith(${JSON.stringify(name)})`;
const RICH_PANE = `!!document.querySelector('[data-markie-rich-pane]')`;
const SOURCE_PANE = `!!document.querySelector('.cm-editor')`;
const LARGE_STRIP = `document.querySelector('[data-markie-large-doc-strip]')?.textContent ?? ""`;
const REFUSAL_STRIP = `document.querySelector('[data-markie-too-large-strip]')?.textContent ?? ""`;
const RICH_BUTTON = `(() => { const b = [...document.querySelectorAll('button')].find((x) => /rich mode/i.test(x.getAttribute('aria-label') || '')); return b ? { disabled: b.disabled, title: b.title } : null; })()`;

// Once a second for `seconds`, does the renderer answer inside the deadline?
// The sample reads the document's title and the rich editor's size rather than
// evaluating 1+1: both are trivially cheap, and carrying them on the sample
// means the moment a document was first seen costs no request of its own. A
// separate poller would leave its abandoned evaluations queued behind the
// samples and measure itself; see scripts/perf-baseline.mjs for the long form.
const SAMPLE_EXPR = `(() => { let size = 0; try { size = window.__markieEditor?.state?.doc?.content?.size ?? 0; } catch {} return { title: document.title, size }; })()`;
async function sampleResponsiveness(cdp, seconds, since = Date.now()) {
  const samples = [];
  for (let i = 0; i < seconds; i += 1) {
    const due = since + i * 1000;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    const asked = Date.now();
    const reply = await cdp.probe(SAMPLE_EXPR, SAMPLE_DEADLINE_MS);
    samples.push({ ok: reply.ok, atMs: asked - since, roundTripMs: Date.now() - asked, value: reply.ok ? reply.value : null });
  }
  return samples;
}
const answered = (samples) => samples.filter((s) => s.ok).length;
const pattern = (samples) => samples.map((s) => (s.ok ? "y" : "n")).join("");
const firstSeen = (samples, test) => samples.find((s) => s.ok && s.value && test(s.value))?.atMs ?? null;

// Three quick answers in a row: the document is open in the sense a person
// means, not merely reported. Returns the moment it settled, or null.
async function settled(cdp, sinceMs, capMs) {
  const deadline = sinceMs + capMs;
  while (Date.now() < deadline) {
    let streak = 0;
    for (let i = 0; i < 3; i += 1) {
      const beat = await cdp.probe("1+1", SAMPLE_DEADLINE_MS);
      if (!beat.ok) break;
      streak += 1;
      if (streak < 3) await sleep(SAMPLE_DEADLINE_MS);
    }
    if (streak === 3) return Date.now() - sinceMs;
    await sleep(150);
  }
  return null;
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  // realpath: /var/folders is a symlink to /private/var/folders on macOS, and
  // the registry stores the canonical spelling, which is what a Library row's
  // title carries.
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-large-home-")));
  const userDataDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-large-profile-")));
  tempPaths.push(homeDir, userDataDir);
  const workspaceDir = path.join(homeDir, "Documents", "Markie");
  await mkdir(workspaceDir, { recursive: true });

  const small = generateMarkdown(SMALL_BYTES, "Small document");
  const large = generateMarkdown(LARGE_BYTES, "Large document");
  const almost = generateMarkdown(ALMOST_BYTES, "Almost large");
  const smallPath = path.join(workspaceDir, "small.md");
  const largePath = path.join(workspaceDir, "big.md");
  const almostPath = path.join(workspaceDir, "almost.md");
  const hugePath = path.join(workspaceDir, "huge.md");
  await writeFile(smallPath, small.text, "utf8");
  await writeFile(largePath, large.text, "utf8");
  await writeFile(almostPath, almost.text, "utf8");
  // Over the cap without writing 101 MB: a sparse file has the size and none
  // of the bytes, and the size is all main is allowed to look at.
  const huge = await openFile(hugePath, "w");
  await huge.truncate(HUGE_BYTES);
  await huge.close();
  note(`fixtures: small ${(small.bytes / 1024).toFixed(0)} KB, large ${(large.bytes / 1e6).toFixed(2)} MB / ${large.blocks} blocks, almost ${(almost.bytes / 1e3).toFixed(0)} KB / ${almost.blocks} blocks, huge ${(HUGE_BYTES / 1e6).toFixed(0)} MB (sparse)`);

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;

  const win = await launchElectron({
    debugPort,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
    log: path.join(artifactDir, "electron.log"),
  });
  closeWindow = win.close;

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("editor", () => cdp.ev("!!window.__markieEditor"), 40000);

  // Register the throwaway home's Documents/Markie as a workspace root, which
  // is what makes the fixtures readable and listable without a dialog.
  await cdp.ev("window.electronAPI.wsCreateDefault()");
  for (const p of [smallPath, largePath, almostPath, hugePath]) {
    await cdp.ev(`window.electronAPI.registryTrack({ path: ${JSON.stringify(p)}, name: ${JSON.stringify(path.basename(p))}, content: null })`);
  }
  await cdp.ev(`(() => { const b = document.querySelector('[aria-label^="Library"]'); if (!b) return false; b.click(); return true; })()`);
  await waitFor("library rows", () => cdp.ev(`!!document.querySelector('span[title=' + ${JSON.stringify(JSON.stringify(largePath))} + ']')`), 30000);

  // 1. The 4.4 MB document: stays responsive, opens in Source view.
  const largeClick = Date.now();
  if (!(await cdp.ev(rowClick(largePath), 5000))) throw new Error("could not click the large document's row");
  const samples = await sampleResponsiveness(cdp, SAMPLE_SECONDS, largeClick);
  check(
    `renderer answers within ${SAMPLE_DEADLINE_MS} ms every second for ${SAMPLE_SECONDS} s after opening 4.4 MB`,
    answered(samples) === SAMPLE_SECONDS,
    `${answered(samples)}/${SAMPLE_SECONDS} samples answered: ${pattern(samples)}`
  );
  await waitFor("large document named", () => cdp.ev(titled("big.md"), 2000), 30000);
  const largeNamedMs = firstSeen(samples, (v) => String(v.title).startsWith("big.md"));
  note(`4.4 MB named in the toolbar by the ${largeNamedMs === null ? "end of the samples" : `${largeNamedMs} ms sample`} (one-second granularity)`);
  const strip = await cdp.ev(LARGE_STRIP);
  check("large document strip explains Source view", /Large document \(4\.4 MB\)\. Opened in source view; rich editing and live collaboration are off for files over 1\.0 MB\./.test(strip), JSON.stringify(strip));
  check("large document shows the source pane and no rich pane", (await cdp.ev(SOURCE_PANE)) === true && (await cdp.ev(RICH_PANE)) === false);
  const richButton = await cdp.ev(RICH_BUTTON);
  check("Rich mode button is disabled with the reason", richButton?.disabled === true && richButton?.title === "Too large for rich view", JSON.stringify(richButton));
  const sourceHolds = await cdp.ev(`(() => { const cm = document.querySelector('.cm-content'); return !!cm && cm.textContent.includes('Large document'); })()`, 5000);
  check("source pane holds the document", sourceHolds === true);

  // 2. Switching back to a small document completes inside a second.
  const switchClick = Date.now();
  if (!(await cdp.ev(rowClick(smallPath), 5000))) throw new Error("could not click the small document's row");
  await waitFor("small document named and rich pane back", async () => (await cdp.ev(titled("small.md"), 2000)) && (await cdp.ev(RICH_PANE, 2000)), 30000);
  const switchMs = Date.now() - switchClick;
  check("switching from the large document to a small one completes under 1 s", switchMs < 1000, `${switchMs} ms`);
  check("large document strip is gone after the switch", (await cdp.ev(LARGE_STRIP)) === "");
  const richAgain = await cdp.ev(RICH_BUTTON);
  check("Rich mode button is available again", richAgain?.disabled === false, JSON.stringify(richAgain));

  // 3. A file over the cap is refused with the message, and nothing changes.
  if (!(await cdp.ev(rowClick(hugePath), 5000))) throw new Error("could not click the huge file's row");
  const refusal = await waitFor("refusal strip", () => cdp.ev(REFUSAL_STRIP, 2000), 15000);
  check("a file over the cap is refused with the message", /huge\.md was not opened\. Markie opens markdown files up to 100 MB\. This one is 101 MB\./.test(refusal), JSON.stringify(refusal));
  check("the open document is untouched by the refusal", (await cdp.ev(titled("small.md"))) === true && (await cdp.ev(RICH_PANE)) === true);

  // 4. Just under the line: how long does the rich pane take to land it? Not
  // asserted; reported, because it is the number that decides the line.
  const almostClick = Date.now();
  if (!(await cdp.ev(rowClick(almostPath), 5000))) throw new Error("could not click the almost-large document's row");
  const almostSamples = await sampleResponsiveness(cdp, SAMPLE_SECONDS, almostClick);
  // The almost-large fixture parses to a few hundred thousand nodes' worth of
  // content; the small one to far fewer, so the size alone tells them apart.
  const stateSeen = firstSeen(almostSamples, (v) => v.size > 200000);
  const settledMs = await settled(cdp, almostClick, 120000);
  const slow = almostSamples.filter((s) => !s.ok).map((s) => `${(s.atMs / 1000).toFixed(0)}s`).join(",");
  note(`950 KB in rich view: responsive ${answered(almostSamples)}/${SAMPLE_SECONDS} s (${pattern(almostSamples)}${slow ? `, missed at ${slow}` : ""}), state seen by the ${stateSeen === null ? "end of the samples" : `${stateSeen} ms sample`}, settled ${settledMs ?? "never"} ms${settledMs !== null && settledMs <= SAMPLE_SECONDS * 1000 ? " (a ceiling: settling is only checked after the samples)" : ""}`);
  check("the almost-large document lands in the rich pane inside the cap", settledMs !== null, `${settledMs ?? ">120000"} ms`);

  cdp.close();
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`\nfatal: ${e.message}`);
} finally {
  await cleanup();
}
const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
await endRun();
