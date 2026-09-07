#!/usr/bin/env node
// Cold-launch, memory and large-document baseline for a packaged Markie build.
//
// This is the "before" number for the 0.6 performance work. It launches the
// packaged app the way scripts/desktop-launch-smoke.mjs does — a throwaway HOME
// and a throwaway --user-data-dir, MARKIE_E2E=1 so the run can never take (or be
// handed) the single-instance lock of a Markie the developer has open with their
// own documents — and measures four things per run:
//
//   a. cold launch: spawn -> load event, plus the renderer's own navigation and
//      paint timings
//   b. resident memory per helper process after 5s idle
//   c. the same table with a 200 KB document open
//   d. what a 4.4 MB document does to responsiveness, how long it takes to land,
//      and how long the app then takes to switch back to the small one
//
// With --inspect-main (the default) it also reads the main process's own
// process.memoryUsage() over its inspector port, because RSS alone cannot tell
// a shared framework page from something the app is holding.
//
// Every run gets its own profile, so every run is a cold launch. Nothing here
// asserts a budget: bad numbers are the point of a baseline, so a slow number
// exits 0. A run that could not be measured exits non-zero, with whatever it did
// manage to record still written to the artifact.
//
// Usage:
//   MARKIE_ALLOW_E2E=1 node scripts/perf-baseline.mjs \
//     --app dist/mac-arm64/Markie.app --runs 3 --out docs/perf/baseline.json
//
// Node 22 built-ins only (fetch, WebSocket, node:*). No dependencies: the
// release preflight fails the build if `dependencies` changes.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("perf-baseline", import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IDLE_SETTLE_MS = 5000;
const SAMPLE_COUNT = 20;
const SAMPLE_INTERVAL_MS = 1000;
const SAMPLE_DEADLINE_MS = 200;
const SWITCH_CAP_MS = 30000;
const OPEN_CAP_MS = 60000;
// How long the 4.4 MB document is given to land before the switch back is even
// asked for. On 0.5.4 it takes about a minute from the click.
const LARGE_LAND_CAP_MS = 120000;
const BOOT_TIMEOUT_MS = 60000;
const SMALL_DOC_BYTES = 200 * 1024;
const LARGE_DOC_BYTES = 4.4 * 1024 * 1024;

// ── children we started, and nothing else ────────────────────────────────────
// safeKill signals only the direct child; a group kill once took Finder down.
// See scripts/lib/safe-kill.mjs.
const spawned = new Set();
function stopAll() {
  for (const child of spawned) safeKill(child, "SIGKILL");
  spawned.clear();
}
process.on("exit", stopAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(1);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(label, fn, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

// ── document generator ───────────────────────────────────────────────────────
// Shaped like something a person would actually have open: headings, prose with
// inline marks, lists, fenced code and the occasional table. A file of one
// repeated paragraph would let a parser cache its way to a flattering number.
const FENCE = "```";
const WORDS = [
  "render", "buffer", "document", "cursor", "selection", "markdown", "parser",
  "throughput", "latency", "cache", "registry", "workspace", "snapshot",
  "conflict", "revision", "index", "outline", "paragraph", "heading", "table",
];

function sentence(seed, length) {
  const parts = [];
  for (let i = 0; i < length; i += 1) parts.push(WORDS[(seed * 7 + i * 13) % WORDS.length]);
  return `${parts.join(" ")}.`;
}

// One cycle of top-level blocks. Returns an array; each entry is one top-level
// block, which is what the count in the artifact means.
function blockCycle(n) {
  const blocks = [
    `## Section ${n}`,
    `${sentence(n, 9)} This paragraph carries **bold**, *italic* and \`inline code\`, plus a [link](https://example.com/${n}) so the inline parser has real work. ${sentence(n + 1, 8)}`,
    `${sentence(n + 2, 12)} ${sentence(n + 3, 10)}`,
    `- ${sentence(n + 4, 5)}\n- ${sentence(n + 5, 6)}\n- ${sentence(n + 6, 4)}`,
    `${FENCE}js\nconst step${n} = ${n};\nexport function run${n}(input) {\n  return input.map((v) => v * step${n});\n}\n${FENCE}`,
    `> ${sentence(n + 7, 11)}`,
  ];
  if (n % 5 === 0) {
    blocks.push(
      [
        "| Field | Value | Notes |",
        "| --- | --- | --- |",
        `| rows | ${n * 3} | counted at parse |`,
        `| bytes | ${n * 137} | approximate |`,
        `| owner | ${WORDS[n % WORDS.length]} | assigned |`,
      ].join("\n")
    );
  }
  return blocks;
}

export function generateMarkdown(targetBytes, title) {
  const out = [`# ${title}`, "", `Generated for the Markie performance baseline. Target ${Math.round(targetBytes / 1024)} KB.`, ""];
  let blocks = 2; // the title and the intro paragraph
  let bytes = out.join("\n").length;
  let n = 1;
  while (bytes < targetBytes) {
    for (const block of blockCycle(n)) {
      out.push(block, "");
      blocks += 1;
      bytes += block.length + 2;
    }
    n += 1;
  }
  const text = `${out.join("\n")}\n`;
  return { text, blocks, bytes: Buffer.byteLength(text) };
}

// ── ps: only rows whose command names the bundle we launched ─────────────────
function roleOf(command) {
  if (command.includes("chrome_crashpad_handler")) return "crashpad";
  const type = /--type=([a-zA-Z-]+)/.exec(command);
  if (!type) return "main";
  if (type[1] === "gpu-process") return "gpu";
  return type[1];
}

function roleDetail(command) {
  const sub = /--utility-sub-type=([^\s]+)/.exec(command);
  return sub ? sub[1] : null;
}

// Every process of one run of one bundle, and nothing else.
//
// Three filters, narrowest first. argv[0] must be inside the bundle that was
// launched, which keeps out an installed Markie at another path and keeps out
// this script's own shell and node (their command lines carry the bundle path
// as an argument, which an `includes` test once counted as a 110 MB "main"
// process). Then the row must belong to *this* run: either its command line
// carries this run's throwaway profile directory, which Chromium propagates to
// every helper (and which crashpad carries as its --database path), or the
// process descends from the one we spawned. Without that second filter a
// concurrent smoke run of the same dist build would land in these totals.
export function selectRunProcesses(psOutput, { bundlePath, userDataDir, rootPid } = {}) {
  const rows = [];
  const parentOf = new Map();
  for (const line of String(psOutput).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4],
    };
    parentOf.set(row.pid, row.ppid);
    rows.push(row);
  }
  const descendsFromRoot = (pid) => {
    if (!rootPid) return false;
    let cursor = pid;
    for (let hops = 0; hops < 64; hops += 1) {
      if (cursor === rootPid) return true;
      const parent = parentOf.get(cursor);
      if (parent === undefined || parent <= 1) return false;
      cursor = parent;
    }
    return false;
  };
  // The profile directory's basename is unique per run and survives the
  // /var vs /private/var spelling difference between the argument we passed and
  // the one Chromium hands its helpers.
  const profileMark = userDataDir ? path.basename(userDataDir) : null;

  const processes = [];
  for (const row of rows) {
    const command = row.command;
    if (!command.startsWith(`${bundlePath}/`)) continue;
    const byProfile = !!profileMark && command.includes(profileMark);
    const byDescent = !byProfile && descendsFromRoot(row.pid);
    if (profileMark && !byProfile && !byDescent) continue;
    const detail = roleDetail(command);
    processes.push({
      pid: row.pid,
      role: roleOf(command),
      ...(detail ? { detail } : {}),
      matchedBy: byProfile ? "user-data-dir" : byDescent ? "descendant" : "bundle-path",
      rssMb: Number((row.rssKb / 1024).toFixed(1)),
    });
  }
  const byRole = {};
  for (const proc of processes) {
    byRole[proc.role] = Number(((byRole[proc.role] || 0) + proc.rssMb).toFixed(1));
  }
  const totalMb = Number(processes.reduce((sum, p) => sum + p.rssMb, 0).toFixed(1));
  return { processes, byRole, totalMb, count: processes.length };
}

function rssTable(bundlePath, scope = {}) {
  const raw = execFileSync("ps", ["-Awwo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return selectRunProcesses(raw, { bundlePath, ...scope });
}

// ── CDP over the built-in WebSocket, with a deadline on every request ────────
async function openCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error("Node 22 WebSocket support is required for perf-baseline");
  }
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const settle = pending.get(message.id);
      pending.delete(message.id);
      settle(message);
      return;
    }
    if (message.method && listeners.has(message.method)) {
      for (const fn of listeners.get(message.method)) fn(message.params);
    }
  });

  // Never rejects. A frozen renderer is a result, not an exception.
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
      timer.unref?.();
      pending.set(id, (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (message.error) resolve({ ok: false, error: JSON.stringify(message.error) });
        else resolve({ ok: true, result: message.result });
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: String(error) });
      }
    });

  const evaluate = async (expression, timeoutMs = 30000) => {
    const reply = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs
    );
    if (!reply.ok) return reply;
    if (reply.result?.exceptionDetails) {
      return { ok: false, error: JSON.stringify(reply.result.exceptionDetails) };
    }
    return { ok: true, value: reply.result?.result?.value };
  };

  return {
    send,
    evaluate,
    on: (method, fn) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

// The packaged build honours --inspect (Electron's EnableNodeCliInspectArguments
// fuse is left at its default), which puts a Node inspector on the main process
// with a single target. Note that the default evaluation context there is
// Electron's bootstrap context, where `require` is undefined; `process` is not,
// which is all this needs, and `process.mainModule.require` is the way to reach
// modules if more is ever wanted.
async function readMainMemory(inspectOrigin) {
  const targets = await (await fetch(`${inspectOrigin}/json`)).json();
  const target = targets.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error("no main-process inspector target");
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const reply = await cdp.evaluate("JSON.stringify(process.memoryUsage())", 10000);
    if (!reply.ok || typeof reply.value !== "string") {
      throw new Error(`main process memoryUsage failed: ${JSON.stringify(reply)}`);
    }
    const usage = JSON.parse(reply.value);
    const mb = (bytes) => Number((bytes / 1048576).toFixed(1));
    return {
      rssMb: mb(usage.rss),
      heapTotalMb: mb(usage.heapTotal),
      heapUsedMb: mb(usage.heapUsed),
      externalMb: mb(usage.external),
      arrayBuffersMb: mb(usage.arrayBuffers),
      bytes: usage,
    };
  } finally {
    cdp.close();
  }
}

async function findPageTarget(debugOrigin) {
  const response = await fetch(`${debugOrigin}/json`);
  if (!response.ok) return null;
  const targets = await response.json();
  return (
    targets.find(
      (t) => t.type === "page" && !String(t.url || "").startsWith("devtools://") && t.webSocketDebuggerUrl
    ) || null
  );
}

// ── the run ─────────────────────────────────────────────────────────────────
const NAME_SELECTOR = `document.querySelector('[title="Click to rename"]')`;
const rowClick = (docPath) =>
  `(() => { const s = document.querySelector('span[title=' + ${JSON.stringify(JSON.stringify(docPath))} + ']');` +
  ` const row = s && s.closest('div.group'); if (!row) return false; row.click(); return true; })()`;

// The rail's Library button. A fresh profile boots with the panel closed, so
// one click opens it.
async function openLibrary(cdp) {
  return cdp.evaluate(
    `(() => { const b = document.querySelector('[aria-label^="Library"]'); if (!b) return false; b.click(); return true; })()`,
    10000
  );
}

const EDITOR_SIZE_EXPR =
  `(() => { try { return window.__markieEditor?.state?.doc?.content?.size ?? 0; } catch { return 0; } })()`;
const EDITOR_READY_SIZE = 100000;
// The 200 KB fixture parses to about 194,000; the 4.4 MB one to millions. Any
// threshold between the two separates "the small document is loaded" from "the
// large one is", which is what makes a switch back provable.
const LARGE_EDITOR_MIN = 1000000;

// Wait until the rich editor holds a document of at least `size` nodes' worth
// of content. `since` lets the clock start at the click rather than here.
async function waitForEditorSize(cdp, min, capMs, since = Date.now(), max = Infinity) {
  const deadline = since + capMs;
  while (Date.now() < deadline) {
    const reply = await cdp.evaluate(EDITOR_SIZE_EXPR, 1000);
    if (reply.ok && typeof reply.value === "number" && reply.value >= min && reply.value <= max) {
      return Date.now() - since;
    }
    await sleep(100);
  }
  return null;
}

// Wait until the toolbar names the document. Each poll carries its own deadline
// so a frozen renderer costs a poll, not the run.
async function waitForToolbarName(cdp, name, capMs, since = Date.now()) {
  const deadline = since + capMs;
  while (Date.now() < deadline) {
    const reply = await cdp.evaluate(`(${NAME_SELECTOR}?.textContent || "").trim()`, 1000);
    if (reply.ok && typeof reply.value === "string" && reply.value.startsWith(name)) {
      return Date.now() - since;
    }
    await sleep(100);
  }
  return null;
}

async function runOnce({ appPath, executable, appDir, runIndex, docs, inspectMain }) {
  // realpath: /var/folders/... is a symlink to /private/var/folders/... on
  // macOS, and the registry stores the canonical spelling. Selecting a Library
  // row by its path fails against the other one.
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-perf-home-")));
  const userDataDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-perf-profile-")));
  const workspaceDir = path.join(homeDir, "Documents", "Markie");
  await mkdir(workspaceDir, { recursive: true });
  const smallPath = path.join(workspaceDir, "perf-200kb.md");
  const largePath = path.join(workspaceDir, "perf-4400kb.md");
  await writeFile(smallPath, docs.small.text, "utf8");
  await writeFile(largePath, docs.large.text, "utf8");

  const debugPort = await pickPort();
  const debugOrigin = `http://127.0.0.1:${debugPort}`;
  const inspectPort = inspectMain ? await pickPort() : null;
  const inspectOrigin = inspectPort ? `http://127.0.0.1:${inspectPort}` : null;

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    // The window is hidden under MARKIE_E2E=1 (it never steals focus from the
    // developer). Hidden pages are otherwise throttled, which would flatter
    // every number below.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  if (inspectPort) args.push(`--inspect=${inspectPort}`);

  const result = {
    run: runIndex,
    startedAt: new Date().toISOString(),
    debugPort,
    inspectPort,
    homeDir,
    userDataDir,
    errors: [],
  };

  const spawnAt = Date.now();
  const child = spawn(executable, args, {
    cwd: appDir,
    env: { ...process.env, HOME: homeDir, MARKIE_E2E: "1" },
    stdio: "ignore",
    windowsHide: true,
  });
  spawned.add(child);
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  let cdp;
  try {
    const target = await waitFor(
      "packaged renderer CDP target",
      async () => {
        if (exited) throw new Error(`Markie exited before CDP was available: ${JSON.stringify(exited)}`);
        return findPageTarget(debugOrigin).catch(() => null);
      },
      BOOT_TIMEOUT_MS
    );
    cdp = await openCdp(target.webSocketDebuggerUrl);
    let loadEventFiredAt = null;
    cdp.on("Page.loadEventFired", () => {
      if (loadEventFiredAt === null) loadEventFiredAt = Date.now();
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // a. cold launch
    const timing = await waitFor(
      "navigation timing",
      async () => {
        const reply = await cdp.evaluate(
          `(() => {
            const nav = performance.getEntriesByType("navigation")[0];
            if (!nav || !nav.loadEventEnd) return null;
            const paints = performance.getEntriesByType("paint");
            const paint = paints.find((e) => e.name === "first-contentful-paint");
            const firstPaint = paints.find((e) => e.name === "first-paint");
            return JSON.stringify({
              timeOrigin: performance.timeOrigin,
              domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
              loadEventEnd: nav.loadEventEnd,
              firstContentfulPaint: paint ? paint.startTime : null,
              firstPaint: firstPaint ? firstPaint.startTime : null,
              paintEntries: paints.map((e) => e.name),
              hidden: document.hidden,
            });
          })()`,
          5000
        );
        return reply.ok && reply.value ? JSON.parse(reply.value) : null;
      },
      BOOT_TIMEOUT_MS
    );
    result.launch = {
      spawnToLoadEventFiredMs: loadEventFiredAt === null ? null : loadEventFiredAt - spawnAt,
      // Independent of whether the CDP connection was open early enough to see
      // the event: the renderer's own clock is an epoch, so this is exact.
      spawnToLoadEventEndMs: Math.round(timing.timeOrigin + timing.loadEventEnd - spawnAt),
      domContentLoadedEventEndMs: Number(timing.domContentLoadedEventEnd.toFixed(1)),
      loadEventEndMs: Number(timing.loadEventEnd.toFixed(1)),
      firstContentfulPaintMs:
        timing.firstContentfulPaint === null ? null : Number(timing.firstContentfulPaint.toFixed(1)),
      firstPaintMs: timing.firstPaint === null ? null : Number(timing.firstPaint.toFixed(1)),
      // On this build the timeline holds first-paint but no
      // first-contentful-paint: MARKIE_E2E=1 keeps the window unshown, so the
      // compositor never presents a frame with content in it.
      paintEntries: timing.paintEntries,
      documentHidden: timing.hidden,
    };

    await waitFor("preload bridge", async () => (await cdp.evaluate("!!window.electronAPI", 5000)).value, 30000);
    await waitFor(
      "toolbar",
      async () => (await cdp.evaluate(`!!document.querySelector('[aria-label^="Library"]')`, 5000)).value,
      30000
    );

    // b. idle memory
    await sleep(IDLE_SETTLE_MS);
    const scope = { userDataDir, rootPid: child.pid };
    result.rssIdle = rssTable(appPath, scope);
    if (inspectOrigin) {
      result.mainMemory = { idle: await readMainMemory(inspectOrigin) };
    }

    // Register the throwaway home's Documents/Markie as a workspace root, which
    // is what makes the two fixtures readable and listable without a dialog.
    await cdp.evaluate("window.electronAPI.wsCreateDefault()", 15000);
    for (const [p, name] of [
      [smallPath, path.basename(smallPath)],
      [largePath, path.basename(largePath)],
    ]) {
      await cdp.evaluate(
        `window.electronAPI.registryTrack({ path: ${JSON.stringify(p)}, name: ${JSON.stringify(name)}, content: null })`,
        15000
      );
    }
    await openLibrary(cdp);
    await waitFor(
      "library rows",
      async () =>
        (
          await cdp.evaluate(
            `!!document.querySelector('span[title=' + ${JSON.stringify(JSON.stringify(smallPath))} + ']')`,
            5000
          )
        ).value,
      30000
    );

    // c. 200 KB document
    const smallStart = Date.now();
    const smallClick = await cdp.evaluate(rowClick(smallPath), 15000);
    if (!smallClick.ok || smallClick.value !== true) {
      throw new Error(`could not click the 200 KB library row: ${JSON.stringify(smallClick)}`);
    }
    // Both clocks start at the click, not at the moment the click's CDP reply
    // came back, so any delay the renderer took to dispatch it is inside the
    // number rather than outside it.
    const smallNamedMs = await waitForToolbarName(cdp, path.basename(smallPath), OPEN_CAP_MS, smallStart);
    // The toolbar name lands as soon as the document state is set, which is well
    // before the text is on screen. The editor's own document size is what says
    // the document actually arrived.
    const smallReadyMs = await waitForEditorSize(cdp, EDITOR_READY_SIZE, OPEN_CAP_MS, smallStart);
    result.smallDoc = {
      path: smallPath,
      bytes: docs.small.bytes,
      blocks: docs.small.blocks,
      toolbarNamedMs: smallNamedMs,
      editorReadyMs: smallReadyMs,
      openTimedOut: smallNamedMs === null || smallReadyMs === null,
    };
    await sleep(IDLE_SETTLE_MS);
    result.rssDoc = rssTable(appPath, scope);
    if (inspectOrigin) {
      result.mainMemory.withSmallDoc = await readMainMemory(inspectOrigin);
    }
    result.editorSizeWithSmallDoc = (await cdp.evaluate(EDITOR_SIZE_EXPR, 5000)).value ?? null;

    // d. 4.4 MB document
    const largeStart = Date.now();
    // Deliberately not awaited before the sampling starts: on a frozen renderer
    // this reply is the last thing to arrive, and the clock has to start at the
    // moment the click was asked for.
    const largeClickState = { accepted: null };
    const largeClickPromise = cdp
      .evaluate(rowClick(largePath), SWITCH_CAP_MS + OPEN_CAP_MS)
      .then((reply) => {
        largeClickState.accepted = reply.ok === true && reply.value === true;
        return reply;
      });
    // Nothing awaits this before the samples run; keep a rejection from
    // reaching the process as an unhandled one.
    largeClickPromise.catch(() => {});
    const samples = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const dueAt = largeStart + (i + 1) * SAMPLE_INTERVAL_MS;
      const wait = dueAt - Date.now();
      if (wait > 0) await sleep(wait);
      const askedAt = Date.now();
      const reply = await cdp.send(
        "Runtime.evaluate",
        { expression: "1+1", returnByValue: true },
        SAMPLE_DEADLINE_MS
      );
      samples.push({
        second: i + 1,
        atMsAfterOpen: askedAt - largeStart,
        responded: reply.ok === true,
        roundTripMs: Date.now() - askedAt,
      });
    }
    const responsive = samples.filter((s) => s.responded);
    const firstResponsive = responsive[0] || null;
    let longestStall = 0;
    let stall = 0;
    for (const sample of samples) {
      if (sample.responded) stall = 0;
      else {
        stall += 1;
        if (stall > longestStall) longestStall = stall;
      }
    }
    // The sampling window is over; now wait for the 4.4 MB document to actually
    // land. The switch back cannot be timed until it has: until React commits
    // the large document the toolbar is still naming the small one, and a
    // toolbar reading a click later would then "prove" a switch that never
    // happened. Landing is the toolbar naming the large document, confirmed by
    // the editor holding a document of its size.
    const largeNamedMs = await waitForToolbarName(
      cdp,
      path.basename(largePath),
      LARGE_LAND_CAP_MS,
      largeStart
    );
    const largeEditorMs =
      largeNamedMs === null
        ? null
        : await waitForEditorSize(cdp, LARGE_EDITOR_MIN, LARGE_LAND_CAP_MS, largeStart);
    const largeLanded = largeNamedMs !== null && largeEditorMs !== null;
    result.largeDoc = {
      path: largePath,
      bytes: docs.large.bytes,
      blocks: docs.large.blocks,
      clickAccepted: largeClickState.accepted,
      samples,
      responsiveSeconds: responsive.length,
      unresponsiveSeconds: SAMPLE_COUNT - responsive.length,
      sampleSeconds: SAMPLE_COUNT,
      firstResponsiveAfterOpenMs: firstResponsive ? firstResponsive.atMsAfterOpen : null,
      firstResponseCapMs: SAMPLE_COUNT * SAMPLE_INTERVAL_MS,
      longestUnresponsiveStretchSeconds: longestStall,
      toolbarNamedMs: largeNamedMs,
      editorReadyMs: largeEditorMs,
      landCapMs: LARGE_LAND_CAP_MS,
      landed: largeLanded,
      ...(largeLanded ? {} : { note: "large document never landed within the cap" }),
    };
    result.editorSizeWithLargeDoc = (await cdp.evaluate(EDITOR_SIZE_EXPR, 5000)).value ?? null;

    // and back to the small document. The end marker is the editor holding a
    // document of the small one's size again, not the toolbar text: after the
    // large document landed the editor is holding millions of nodes, so falling
    // back into the small band is proof that a new load completed.
    if (!largeLanded) {
      result.switchBack = {
        ms: null,
        timedOut: true,
        skipped: true,
        capMs: SWITCH_CAP_MS,
        note: "not attempted: the 4.4 MB document never landed, so a switch back could not be told from no switch at all",
      };
    } else {
      const switchStart = Date.now();
      const switchState = { executedMs: null, executionTimedOut: false, accepted: null };
      const switchClick = cdp.evaluate(rowClick(smallPath), SWITCH_CAP_MS).then((reply) => {
        // A timed-out request never ran in the page: record that as "never
        // executed", not as a 30000ms execution.
        switchState.executedMs = reply.timedOut ? null : Date.now() - switchStart;
        switchState.executionTimedOut = reply.timedOut === true;
        switchState.accepted = reply.ok === true && reply.value === true;
        return reply;
      });
      switchClick.catch(() => {});
      const switchReadyMs = await waitForEditorSize(
        cdp,
        EDITOR_READY_SIZE,
        SWITCH_CAP_MS,
        switchStart,
        LARGE_EDITOR_MIN - 1
      );
      const switchNamedMs =
        switchReadyMs === null
          ? null
          : await waitForToolbarName(cdp, path.basename(smallPath), SWITCH_CAP_MS, switchStart);
      await switchClick;
      result.switchBack = {
        ms: switchReadyMs,
        timedOut: switchReadyMs === null,
        capMs: SWITCH_CAP_MS,
        toolbarNamedMs: switchNamedMs,
        // How long the app took merely to accept the click.
        clickExecutedMs: switchState.executedMs,
        clickExecutionTimedOut: switchState.executionTimedOut,
        clickAccepted: switchState.accepted,
        elapsedMs: Date.now() - switchStart,
      };
    }
  } catch (error) {
    result.errors.push(String(error?.message || error));
  } finally {
    cdp?.close();
    safeKill(child, "SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(4000)]);
    safeKill(child, "SIGKILL");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(2000)]);
    spawned.delete(child);
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

// ── aggregation ─────────────────────────────────────────────────────────────
//
// Some of these metrics can time out, and dropping a timeout leaves the slowest
// runs out of the summary entirely: a first response of [never, 9001, never]
// would otherwise report a median of 9,001 ms, which reads as "it answers in
// nine seconds" when two runs in three never answered at all. A metric declared
// censored substitutes its cap for a timeout, so the median is at least as bad
// as the truth, and carries the completion ratio alongside.
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Number(value.toFixed(1));
}
function minimum(values) {
  return values.length ? Number(Math.min(...values).toFixed(1)) : null;
}

const plain = (pick) => ({ pick });
// `attempted` says the run reached the point where this metric applies, so a
// null there is a timeout rather than a run that never got that far.
const censored = (pick, capMs, attempted) => ({ pick, capMs, attempted });

const METRICS = {
  launchMs: plain((r) => r.launch?.spawnToLoadEventFiredMs ?? r.launch?.spawnToLoadEventEndMs),
  spawnToLoadEventEndMs: plain((r) => r.launch?.spawnToLoadEventEndMs),
  domContentLoadedEventEndMs: plain((r) => r.launch?.domContentLoadedEventEndMs),
  loadEventEndMs: plain((r) => r.launch?.loadEventEndMs),
  firstContentfulPaintMs: plain((r) => r.launch?.firstContentfulPaintMs),
  firstPaintMs: plain((r) => r.launch?.firstPaintMs),
  rssIdleTotalMb: plain((r) => r.rssIdle?.totalMb),
  rssIdleMainMb: plain((r) => r.rssIdle?.byRole?.main),
  rssIdleRendererMb: plain((r) => r.rssIdle?.byRole?.renderer),
  rssIdleGpuMb: plain((r) => r.rssIdle?.byRole?.gpu),
  rssDocTotalMb: plain((r) => r.rssDoc?.totalMb),
  rssDocMainMb: plain((r) => r.rssDoc?.byRole?.main),
  rssDocRendererMb: plain((r) => r.rssDoc?.byRole?.renderer),
  mainHeapUsedIdleMb: plain((r) => r.mainMemory?.idle?.heapUsedMb),
  mainHeapTotalIdleMb: plain((r) => r.mainMemory?.idle?.heapTotalMb),
  mainExternalIdleMb: plain((r) => r.mainMemory?.idle?.externalMb),
  mainRssIdleMb: plain((r) => r.mainMemory?.idle?.rssMb),
  mainHeapUsedDocMb: plain((r) => r.mainMemory?.withSmallDoc?.heapUsedMb),
  mainRssDocMb: plain((r) => r.mainMemory?.withSmallDoc?.rssMb),
  smallDocToolbarNamedMs: censored((r) => r.smallDoc?.toolbarNamedMs, OPEN_CAP_MS, (r) => !!r.smallDoc),
  smallDocEditorReadyMs: censored((r) => r.smallDoc?.editorReadyMs, OPEN_CAP_MS, (r) => !!r.smallDoc),
  largeDocResponsiveSeconds: plain((r) => r.largeDoc?.responsiveSeconds),
  largeDocFirstResponseMs: censored(
    (r) => r.largeDoc?.firstResponsiveAfterOpenMs,
    SAMPLE_COUNT * SAMPLE_INTERVAL_MS,
    (r) => !!r.largeDoc
  ),
  largeDocLongestStallSeconds: plain((r) => r.largeDoc?.longestUnresponsiveStretchSeconds),
  largeDocLandedMs: censored((r) => r.largeDoc?.editorReadyMs, LARGE_LAND_CAP_MS, (r) => !!r.largeDoc),
  switchBackMs: censored((r) => r.switchBack?.ms, SWITCH_CAP_MS, (r) => !!r.switchBack),
  switchBackClickExecutedMs: censored(
    (r) => r.switchBack?.clickExecutedMs,
    SWITCH_CAP_MS,
    (r) => !!r.switchBack && !r.switchBack.skipped
  ),
};

export function summarize(runs) {
  const medians = {};
  const minimums = {};
  const samples = {};
  const censoredSummary = {};
  for (const [key, metric] of Object.entries(METRICS)) {
    const completed = [];
    let attempted = 0;
    let timedOut = 0;
    for (const run of runs) {
      const value = metric.pick(run);
      if (typeof value === "number" && Number.isFinite(value)) {
        completed.push(value);
        attempted += 1;
        continue;
      }
      if (metric.capMs && metric.attempted?.(run)) {
        attempted += 1;
        timedOut += 1;
      }
    }
    const aggregated = metric.capMs
      ? [...completed, ...Array(timedOut).fill(metric.capMs)]
      : completed;
    medians[key] = median(aggregated);
    minimums[key] = minimum(aggregated);
    samples[key] = completed.length;
    if (metric.capMs && attempted) {
      censoredSummary[key] = {
        capMs: metric.capMs,
        attemptedRuns: attempted,
        completedRuns: completed.length,
        timedOutRuns: timedOut,
        medianAtOrAboveCap: medians[key] !== null && medians[key] >= metric.capMs,
        medianOfCompletedMs: median(completed),
      };
    }
  }
  return { medians, minimums, samples, censored: censoredSummary };
}

// "3/3 runs, 9.0s" when everything completed; "1/3 runs, 9.0s when it did" when
// some run hit the cap; "0/3 runs (>20s)" when none did.
export function censoredText(summary, key, unit = "s") {
  const info = summary.censored?.[key];
  if (!info) {
    const value = summary.medians[key];
    return value === null ? "n/a" : `${(value / 1000).toFixed(1)}${unit}`;
  }
  const cap = `>${Math.round(info.capMs / 1000)}${unit}`;
  const ratio = `${info.completedRuns}/${info.attemptedRuns} runs`;
  if (info.completedRuns === 0) return `${ratio} (${cap})`;
  const best = `${(info.medianOfCompletedMs / 1000).toFixed(1)}${unit}`;
  return info.timedOutRuns ? `${ratio}, ${best} when it did` : `${ratio}, ${best}`;
}

export function oneLine(runs, summary) {
  const m = summary.medians;
  return [
    `launch ${m.launchMs === null ? "n/a" : Math.round(m.launchMs) + "ms"}`,
    `rss idle ${m.rssIdleTotalMb === null ? "n/a" : Math.round(m.rssIdleTotalMb) + "MB"}`,
    `rss doc ${m.rssDocTotalMb === null ? "n/a" : Math.round(m.rssDocTotalMb) + "MB"}`,
    `4.4MB: responsive ${m.largeDocResponsiveSeconds === null ? "n/a" : Math.round(m.largeDocResponsiveSeconds)}/${SAMPLE_COUNT}s, ` +
      `first response ${censoredText(summary, "largeDocFirstResponseMs")}`,
    `landed ${censoredText(summary, "largeDocLandedMs")}`,
    `switch ${censoredText(summary, "switchBackMs")}`,
  ].join(" · ");
}

// ── cli ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // The main process's own process.memoryUsage() is part of the baseline, and
  // the only way to it without adding an IPC to the app is its inspector port,
  // so --inspect-main is on unless it is turned off.
  const options = { runs: 3, app: "dist/mac-arm64/Markie.app", out: null, inspectMain: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app") options.app = argv[++i];
    else if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--inspect-main") options.inspectMain = true;
    else if (arg === "--no-inspect-main") options.inspectMain = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: MARKIE_ALLOW_E2E=1 node scripts/perf-baseline.mjs --app <path-to-.app> --runs 3 --out <json path>",
    "",
    "Measures cold launch, per-process RSS, main-process heap, and large-document",
    "responsiveness of a packaged Markie build. Every run uses a fresh throwaway",
    "HOME and profile.",
    "",
    "  --no-inspect-main   skip --inspect and the main process memoryUsage reading",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${options.runs}`);
  }

  const appPath = path.resolve(rootDir, options.app);
  if (!existsSync(appPath)) throw new Error(`no app bundle at ${appPath}`);
  const productName = path.basename(appPath).replace(/\.app$/, "");
  const executable = path.join(appPath, "Contents", "MacOS", productName);
  if (!existsSync(executable)) throw new Error(`no executable at ${executable}`);
  if (appPath.startsWith("/Applications/")) {
    throw new Error(`refusing to measure ${appPath}: that is the installed app, not a build artifact`);
  }

  const docs = {
    small: generateMarkdown(SMALL_DOC_BYTES, "Two hundred kilobytes"),
    large: generateMarkdown(LARGE_DOC_BYTES, "Four point four megabytes"),
  };
  console.log(
    `[perf:baseline] fixtures: ${(docs.small.bytes / 1024).toFixed(0)} KB / ${docs.small.blocks} blocks, ` +
      `${(docs.large.bytes / 1024 / 1024).toFixed(2)} MB / ${docs.large.blocks} blocks`
  );

  const runs = [];
  for (let i = 1; i <= options.runs; i += 1) {
    console.log(`[perf:baseline] run ${i}/${options.runs}`);
    const run = await runOnce({
      appPath,
      executable,
      appDir: appPath,
      runIndex: i,
      docs,
      inspectMain: options.inspectMain,
    });
    runs.push(run);
    if (run.errors.length) console.log(`[perf:baseline]   errors: ${run.errors.join("; ")}`);
    console.log(
      `[perf:baseline]   launch ${run.launch?.spawnToLoadEventFiredMs ?? run.launch?.spawnToLoadEventEndMs ?? "n/a"}ms, ` +
        `idle ${run.rssIdle?.totalMb ?? "n/a"}MB, doc ${run.rssDoc?.totalMb ?? "n/a"}MB, ` +
        `small doc ready ${run.smallDoc?.editorReadyMs ?? "n/a"}ms, ` +
        `responsive ${run.largeDoc?.responsiveSeconds ?? "n/a"}/${SAMPLE_COUNT}s, ` +
        `landed ${run.largeDoc?.landed ? run.largeDoc.editorReadyMs + "ms" : "never"}, ` +
        `switch ${run.switchBack?.timedOut ? "timed out" : (run.switchBack?.ms ?? "n/a") + "ms"}` +
        `${run.mainMemory?.idle ? `, main heap ${run.mainMemory.idle.heapUsedMb}MB` : ""}`
    );
  }

  const summary = summarize(runs);
  const artifact = {
    tool: "scripts/perf-baseline.mjs",
    generatedAt: new Date().toISOString(),
    app: appPath,
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      cpus: (() => {
        try {
          return execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim();
        } catch {
          return null;
        }
      })(),
    },
    settings: {
      runs: options.runs,
      idleSettleMs: IDLE_SETTLE_MS,
      sampleCount: SAMPLE_COUNT,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      sampleDeadlineMs: SAMPLE_DEADLINE_MS,
      switchCapMs: SWITCH_CAP_MS,
    },
    fixtures: {
      small: { bytes: docs.small.bytes, blocks: docs.small.blocks },
      large: { bytes: docs.large.bytes, blocks: docs.large.blocks },
    },
    runs,
    summary,
  };
  artifact.summary.line = oneLine(runs, summary);

  const failed = runs.filter((run) => run.errors.length);
  artifact.ok = failed.length === 0;

  if (options.out) {
    const outPath = path.resolve(rootDir, options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`[perf:baseline] wrote ${outPath}`);
  }
  console.log(artifact.summary.line);

  // A slow number is a result and exits 0. A run that could not be measured is
  // this script failing, so it exits non-zero even though the partial artifact
  // was written: a capture with a hole in it must not pass for a capture.
  if (failed.length) {
    console.error(
      `[perf:baseline] ${failed.length}/${runs.length} run(s) could not be measured: ` +
        failed.map((run) => `run ${run.run}: ${run.errors.join("; ")}`).join(" | ")
    );
    return 1;
  }
  return 0;
}

// Only when this file is the process entry point, so the helpers above can be
// imported and exercised without launching anything.
const isEntryPoint =
  !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  main()
    .then((code) => {
      stopAll();
      process.exitCode = code;
    })
    .catch((error) => {
      // A slow number is a result. Only a measurement that could not be taken,
      // or a broken invocation, is a failure.
      console.error(`[perf:baseline] failed: ${error?.stack || error}`);
      stopAll();
      process.exitCode = 1;
    });
}
