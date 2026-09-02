#!/usr/bin/env node
// Drives the Projects panel in a real window.
//
// Projects used to be a full-width page behind an unlabelled rail icon. It is
// a tab in the Library panel now, and these checks are here because the last
// two things wrong with this feature (a tooltip that would not go away, a page
// nobody wanted) were both found by using the app, not by a unit test. jsdom
// cannot tell you whether the rail still has a door to a page that no longer
// exists.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("projects-panel-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "projects-panel-check");
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

// `next dev` leaves a `next-server` behind after the run: safe-kill signals
// only the direct child, on purpose (see scripts/lib/safe-kill.mjs, and the
// afternoon a group kill took Finder down), and the survivor keeps holding
// .next/dev/lock so the next run cannot start. Clear it here, and only it:
// the pid has to be both the holder of this exact lock file and a next-server,
// or nothing is signalled.
function releaseStaleDevLock() {
  const lock = path.join(root, ".next", "dev", "lock");
  let holders = "";
  try {
    holders = execFileSync("lsof", ["-t", lock], { encoding: "utf-8" });
  } catch {
    return; // lsof exits non-zero when nobody holds it, which is the good case
  }
  for (const line of holders.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    } catch {
      continue;
    }
    if (!command.includes("next-server")) continue;
    try {
      process.kill(pid, "SIGKILL");
      process.stdout.write(`  ..   cleared a leftover next-server holding the dev lock (pid ${pid})\n`);
    } catch {
      /* already gone */
    }
  }
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


// ── Reading the rail and the panel ─────────────────────────────────────────
const railButton = (prefix) => `(() => {
  const b = [...document.querySelectorAll('.markie-activity-bar button')]
    .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)}));
  return b ? b.getAttribute('aria-label') : null;
})()`;

const clickRail = (prefix) => `(() => {
  const b = [...document.querySelectorAll('.markie-activity-bar button')]
    .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(prefix)}));
  if (!b) return false;
  b.click();
  return true;
})()`;

const tabNames = `(() => {
  const g = document.querySelector('[role="group"][aria-label="Library sections"]');
  return g ? [...g.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
})()`;

const clickText = (text) => `(() => {
  const el = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
  if (!el) return false;
  el.click();
  return true;
})()`;

// Project rows are the ones that expand; file rows are the ones with a title.
const projectRows = `(() => [...document.querySelectorAll('button[aria-expanded]')]
  .map((b) => b.textContent.replace(/\\u25b6/g, '').trim()))()`;

const fileRows = `(() => [...document.querySelectorAll('button[title$=".md"]')]
  .map((b) => b.getAttribute('title')))()`;

const typeSearch = (text) => `(() => {
  const input = document.querySelector('input[aria-label="Search projects and files"]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(text)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-projects-profile-"));
  // Never the developer's real home: a fresh profile against it indexes and
  // watches things nobody asked for.
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-projects-home-"));
  tempPaths.push(userDataDir, homeDir);

  // Two obvious projects and one stray, which is the shape the panel is for.
  // The projects are declared in front matter rather than left to clustering:
  // a temp home has no git repositories and no editing history, so inferring
  // them would put everything in Unfiled and the check would be about the
  // clustering engine instead of about the panel.
  const write = async (rel, body) => {
    const full = path.join(homeDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf-8");
    return full;
  };
  const declare = (project, title, body) =>
    `---\nmarkie:\n  project: ${project}\n---\n\n# ${title}\n\n${body}\n`;
  await write("code/beacon/README.md", declare("Beacon", "Beacon", "the beacon readme"));
  await write("code/beacon/plan.md", declare("Beacon", "Beacon plan", "what we are building"));
  await write("code/beacon/spec.md", declare("Beacon", "Beacon spec", "how it works"));
  await write("Documents/thesis/chapter-one.md", declare("Thesis", "Chapter one", "the opening"));
  await write("Documents/thesis/chapter-two.md", declare("Thesis", "Chapter two", "the middle"));
  const strayPath = await write("scratchpad.md", "# Scratch\n\nloose note\n");

  releaseStaleDevLock();

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
    [".", strayPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
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
  await waitFor("rail", () => cdp.ev(railButton("Library")), 40000);

  // ── The rail ─────────────────────────────────────────────────────────────
  check(
    "the rail has no Projects icon of its own",
    (await cdp.ev(railButton("Projects"))) === null
  );
  check(
    "the Library button says Projects is in there",
    /projects/i.test((await cdp.ev(railButton("Library"))) ?? "")
  );

  // ── The panel ────────────────────────────────────────────────────────────
  await cdp.ev(clickRail("Library"));
  await waitFor("library panel", () => cdp.ev(tabNames), 15000);
  const tabs = await cdp.ev(tabNames);
  check("the Library has exactly Recent and Projects", JSON.stringify(tabs) === '["Recent","Projects"]', String(tabs));

  check("the Projects tab is there to click", await cdp.ev(clickText("Projects")));
  await waitFor(
    "projects listed",
    async () => (await cdp.ev(projectRows))?.length > 0,
    60000
  );
  const rows = await cdp.ev(projectRows);
  check(
    "it lists the projects it found",
    rows.some((r) => r.startsWith("Beacon")) && rows.some((r) => r.startsWith("Thesis")),
    rows.join(" | ")
  );
  check(
    "the pile Markie could not place sorts last, not first",
    rows.findIndex((r) => r.startsWith("Unfiled")) === rows.length - 1,
    rows.join(" | ")
  );
  check(
    "a project opens collapsed, so the panel is a list and not a wall",
    (await cdp.ev(fileRows)).length === 0
  );
  check("clicking a project shows its files", await cdp.ev(`(() => {
    const b = [...document.querySelectorAll('button[aria-expanded]')]
      .find((x) => x.textContent.includes('Beacon'));
    if (!b) return false;
    b.click();
    return true;
  })()`));
  await waitFor("expanded", async () => (await cdp.ev(fileRows))?.length === 3, 10000);
  check("it shows every file in that project", true, (await cdp.ev(fileRows)).join(" | "));
  check(
    "the document is still on screen beside it, not replaced by a page",
    await cdp.ev(`!!document.querySelector('[data-markie-document-area]')`)
  );
  await shootTo(cdp, "01-projects-panel");

  // ── Search ───────────────────────────────────────────────────────────────
  check("there is one search field over projects and files", await cdp.ev(typeSearch("beacon")));
  await waitFor("filtered by project name", async () => {
    const r = await cdp.ev(projectRows);
    return r?.length === 1 && r[0].startsWith("Beacon");
  }, 10000);
  check("a project name narrows the list to that project", true, (await cdp.ev(projectRows)).join(" | "));

  await cdp.ev(typeSearch("chapter-two"));
  await waitFor("filtered by file name", async () => {
    const f = await cdp.ev(fileRows);
    return f?.length === 1 && f[0].endsWith("chapter-two.md");
  }, 10000);
  check("a file name finds the file inside its project without naming the project", true);
  check(
    "a match is already open, so the hit is visible without another click",
    (await cdp.ev(fileRows)).length === 1
  );
  await shootTo(cdp, "02-search");

  await cdp.ev(typeSearch("zzzznothing"));
  await waitFor("empty search", () => cdp.ev(`document.body.innerText.includes("Nothing matches that.")`), 10000);
  check("it says so when nothing matches", true);

  // ── Opening a file ───────────────────────────────────────────────────────
  await cdp.ev(typeSearch("chapter-one"));
  await waitFor("one hit", async () => (await cdp.ev(fileRows))?.length === 1, 10000);
  await cdp.ev(`document.querySelector('button[title$="chapter-one.md"]').click()`);
  await waitFor(
    "opened",
    () => cdp.ev(`document.body.innerText.includes("Chapter one")`),
    20000
  );
  check("clicking a file opens it in the document beside the panel", true);
  check("the panel stays open after opening a file", (await cdp.ev(tabNames)) !== null);
  check(
    "the project holding the open file is expanded, and the file is marked",
    await cdp.ev(`(() => {
      const row = document.querySelector('button[title$="chapter-one.md"]');
      const group = [...document.querySelectorAll('button[aria-expanded]')]
        .find((b) => b.textContent.includes('Thesis'));
      return !!row && row.className.includes('bg-accent')
        && group?.getAttribute('aria-expanded') === 'true';
    })()`)
  );
  await shootTo(cdp, "03-opened");

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
  process.stderr.write(`projects-panel-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
