// Electron Markie under the 7.9 large-document bench (docs/rust-port/PERF.md).
//
//   ELECTRON_RUN_AS_NODE unset; <Electron.app>/Contents/MacOS/Electron main.cjs \
//     --user-data-dir=<scratch> <fixture copy>
//   BENCH_ESRC  a copy of the Electron checkout (preload.js, electron/*.js)
//   BENCH_OUT   that checkout's renderer, built with vite into a scratch folder
//
// The real renderer, the real preload and main's own read and save modules
// (doc-tiers, disk-memory, history, atomic-write) in a window that is never
// shown: offscreen rendering, and an accessory app with no Dock icon that
// never activates. Input goes through webContents.sendInputEvent, Chromium's
// own input path. Every other IPC channel answers null. Prints
// `markie-electron-bench {json}` lines and quits.
"use strict";
const { app, BrowserWindow, ipcMain, session, contentTracing } = require("electron");
const fs = require("fs");
const path = require("path");

const ESRC = process.env.BENCH_ESRC;
const OUT = process.env.BENCH_OUT;
const file = path.resolve(process.argv[process.argv.length - 1]);
const userData = (process.argv.find((a) => a.startsWith("--user-data-dir=")) || "").split("=")[1];
if (!ESRC || !OUT || !userData) {
  console.error("markie-electron-bench needs BENCH_ESRC, BENCH_OUT and --user-data-dir");
  process.exit(2);
}
app.setPath("userData", userData);
if (app.dock) app.dock.hide();

const docTiers = require(path.join(ESRC, "electron/doc-tiers"));
const { createDiskMemory } = require(path.join(ESRC, "electron/disk-memory"));
const { writeFileAtomic } = require(path.join(ESRC, "electron/atomic-write"));
const { createHistory } = require(path.join(ESRC, "electron/history"));
const { saveConflictAction } = require(path.join(ESRC, "electron/save-conflict"));
const diskMemory = createDiskMemory();
const history = createHistory({ dir: userData });

const log = (event, fields) => console.log(`markie-electron-bench ${JSON.stringify({ event, t: Date.now(), ...fields })}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every channel the preload invokes answers null, except the two timed here.
const preload = fs.readFileSync(path.join(ESRC, "electron/preload.js"), "utf8");
const channels = new Set([...preload.matchAll(/invoke\("([^"]+)"/g)].map((m) => m[1]));
let requested = 0;
ipcMain.handle("get-initial-file", () => {
  requested = Date.now();
  const doc = docTiers.readDocumentTiered(file);
  if (doc.tooLarge) {
    log("read", { ms: Date.now() - requested, tooLarge: true });
    return { tooLarge: true, size: doc.size, name: path.basename(file), path: file };
  }
  diskMemory.remember(file, doc.content);
  log("read", { ms: Date.now() - requested, size: doc.size, large: doc.large });
  return { name: path.basename(file), content: doc.content, path: file, size: doc.size, large: doc.large };
});
let saved = null;
let autosaves = 0;
ipcMain.handle("save-file", async (_e, { filePath, content, force = false, autosave = false }) => {
  const t = Date.now();
  // As main.js: the conflict check, the snapshot, the atomic write, then remember.
  const newer = force ? null : diskMemory.changedSince(filePath);
  const action = saveConflictAction({ autosave, force, changed: newer?.content ?? null });
  if (action !== "proceed") {
    log("save-refused", { action });
    return { success: false, canceled: true };
  }
  history.capture(filePath, content, { author: "user" });
  writeFileAtomic(filePath, content);
  diskMemory.remember(filePath, content, { ownWrite: true });
  if (autosave) autosaves++;
  saved = { at: Date.now(), mainMs: Date.now() - t, bytes: Buffer.byteLength(content), autosave };
  return { success: true, path: filePath };
});
// The native document channels answer "nothing queued" in their own envelope.
for (const ch of channels) {
  if (ch === "get-initial-file" || ch === "save-file") continue;
  ipcMain.handle(ch, () => (ch.startsWith("document-files:") ? { ok: true, value: null } : null));
}
ipcMain.on("attach-file-path", (e) => (e.returnValue = null));
ipcMain.on("grant-file-path", (e) => (e.returnValue = null));

let ready;
const editorReady = new Promise((r) => (ready = r));
ipcMain.on("bench-editor-ready", () => ready(Date.now()));

function key(wc, keyCode, modifiers = []) {
  wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  if (!modifiers.includes("meta") && keyCode.length === 1) wc.sendInputEvent({ type: "char", keyCode, modifiers });
  wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}
const read = (wc, js) => wc.executeJavaScript(js, true);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length || 1;
  return {
    mean: xs.reduce((a, b) => a + b, 0) / n,
    median: s[Math.floor(n / 2)] ?? 0,
    p95: s[Math.floor((n * 95) / 100)] ?? 0,
    max: s[n - 1] ?? 0,
    over16: xs.filter((x) => x > 1000 / 60).length,
    n: xs.length,
  };
};

async function typeKeys(wc, count) {
  const before = JSON.parse((await read(wc, "document.documentElement.dataset.benchKeys || '[]'")) || "[]").length;
  for (let i = 0; i < count; i++) {
    key(wc, i % 6 === 5 ? " " : "e");
    // One at a time: wait for the probe to time this one.
    for (let k = 0; k < 400; k++) {
      const n = JSON.parse(await read(wc, "document.documentElement.dataset.benchKeys || '[]'")).length;
      if (n > before + i) break;
      await sleep(2);
    }
  }
  const all = JSON.parse(await read(wc, "document.documentElement.dataset.benchKeys || '[]'"));
  const work = JSON.parse(await read(wc, "document.documentElement.dataset.benchWork || '[]'"));
  return { frame: all.slice(before), work: work.slice(before) };
}

// Chromium's own trace of the typing, for the renderer's busy time per key
// (large-docs.py reads it). Written next to the log when BENCH_TRACE_DIR is set.
async function traced(label, fn) {
  const dir = process.env.BENCH_TRACE_DIR;
  if (!dir) return fn();
  await contentTracing.startRecording({ included_categories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "input"] });
  const out = await fn();
  fs.renameSync(await contentTracing.stopRecording(), path.join(dir, `trace-type-${label}.json`));
  return out;
}

async function run(win) {
  const wc = win.webContents;
  const readyAt = await editorReady;
  key(wc, "x");
  for (let i = 0; i < 2000; i++) {
    if (await read(wc, "document.documentElement.dataset.benchEditable || ''")) break;
    await sleep(5);
  }
  const firstPaint = Number(await read(wc, "document.documentElement.dataset.benchFirstPaint"));
  const editable = Number(await read(wc, "document.documentElement.dataset.benchEditable || 0"));
  if (process.env.BENCH_SHOT) fs.writeFileSync(process.env.BENCH_SHOT, (await wc.capturePage()).toPNG());
  log("open", { requested, first_paint_ms: firstPaint - requested, editable_ms: editable ? editable - requested : null, ready_ms: readyAt - requested });
  await sleep(400);
  // Typing at the start (the cursor is after the x), then at the end.
  const docLen = () => read(wc, "window.__benchLen ? window.__benchLen() : null");
  let typed = await traced("start", () => typeKeys(wc, 30));
  log("type_start", { frame: stats(typed.frame), work: stats(typed.work) });
  await sleep(400);
  key(wc, "Down", ["meta"]);
  await sleep(600);
  typed = await traced("end", () => typeKeys(wc, 30));
  log("type_end", { frame: stats(typed.frame), work: stats(typed.work) });
  if (process.env.BENCH_SHOT) fs.writeFileSync(process.env.BENCH_SHOT.replace(/\.png$/, "-end.png"), (await wc.capturePage()).toPNG());
  await sleep(400);
  // Scroll: 600 frames that sweep the document top to bottom. Each step
  // sets the scroller's offset and hands CodeMirror the scroll event it
  // would get, then forces style and layout: main-thread cost to a laid-out
  // frame, without paint. rAF intervals are kept too.
  const sweep = await read(
    wc,
    `(async () => {
      let sc = document.querySelector(".cm-scroller");
      for (let el = sc; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { sc = el; break; }
      }
      const which = sc.className.slice(0, 40);
      sc.scrollTop = 0; sc.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(r));
      const costs = [], gaps = [];
      let last = performance.now();
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const t = performance.now();
        gaps.push(t - last); last = t;
        const max = sc.scrollHeight - sc.clientHeight;
        sc.scrollTop = (max * (i + 1)) / 600;
        sc.dispatchEvent(new Event("scroll"));
        sc.getBoundingClientRect(); void document.documentElement.offsetHeight;
        costs.push(performance.now() - t);
      }
      const lines = document.querySelectorAll(".cm-line");
      return { costs, gaps, which, height: sc.scrollHeight, top: sc.scrollTop, last: lines[lines.length - 1]?.textContent.slice(-30) };
    })()`
  );
  log("scroll_sweep", { ...stats(sweep.costs), which: sweep.which, height: sweep.height, reached: sweep.top, last: sweep.last });
  log("scroll_sweep_gaps", stats(sweep.gaps.slice(1)));
  await sleep(400);
  // Save: the menu's ⌘S, through the page's own save, IPC and main's write.
  const len = await read(wc, `document.querySelector(".cm-content").textContent.length`);
  saved = null;
  const t = Date.now();
  wc.send("menu-save");
  for (let i = 0; i < 6000 && !saved; i++) await sleep(5);
  log("save", saved ? { ms: saved.at - t, main_ms: saved.mainMs, bytes: saved.bytes, on_disk: fs.statSync(file).size, autosave: saved.autosave, autosaves } : { failed: true });
}

app.whenReady().then(async () => {
  session.defaultSession.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "probe.cjs") });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(ESRC, "electron/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(Number(process.env.BENCH_FPS || 60));
  win.webContents.on("console-message", (e) => {
    const level = e.level ?? "";
    if (level === "error" || level === 3) console.error(`renderer: ${e.message}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => {
    log("renderer-gone", d);
    app.exit(3);
  });
  const timeout = setTimeout(() => { log("timeout", {}); app.exit(4); }, Number(process.env.BENCH_TIMEOUT_MS || 300000));
  await win.loadFile(path.join(OUT, "index.html"));
  try {
    await run(win);
  } catch (err) {
    log("error", { message: String(err && err.stack || err) });
  }
  clearTimeout(timeout);
  log("done", {});
  app.exit(0);
});
