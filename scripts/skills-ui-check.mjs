#!/usr/bin/env node
// The Skills panel in a real window: both tabs, a real install, and the detail
// pane rendering a real SKILL.md through the document renderer.
//
// The component tests drive the panel against the mock bridge, which proves the
// wiring but not that the panel and the main process agree once a real catalog
// is on the other side of the preload boundary. This one downloads
// anthropics/skills for real, installs a skill into a throwaway HOME, looks at
// the panel the way a person would, and installs a second copy from the detail
// pane itself so the button's enabled, working and done states are real ones.
//
// Nothing here may touch the developer's own ~/.claude, ~/.agents or ~/.codex,
// which is why HOME is a fresh temp directory and the app runs with its own
// profile.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { endRun, launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("skills-ui-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "skills-ui-check");
let stopRenderer = () => {};
let closeWindow = async () => {};
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

async function cleanup() {
  await closeWindow();
  stopRenderer();
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(1));
}

async function waitFor(label, fn, timeoutMs = 40000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

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

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
      ?.result?.value;
  return { send, ev, close: () => ws.close() };
}

async function shoot(cdp, name) {
  await new Promise((r) => setTimeout(r, 500));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(artifactDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
}

// The panel's own DOM, addressed the way the panel labels itself.
const PANEL = `document.querySelector('.markie-side-panel')`;
const tab = (id) => `${PANEL}.querySelector('[data-skills-tab=${JSON.stringify(id)}]')`;
const text = (selector) => `(${selector})?.textContent ?? ""`;

async function main() {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-skills-ui-home-")));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-skills-ui-profile-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-skills-ui-work-"));
  tempPaths.push(homeDir, userDataDir, workDir);
  const docPath = path.join(await realpath(workDir), "notes.md");
  await writeFile(docPath, "# Skills panel check\n", "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;

  const win = await launchElectron({
    debugPort,
    args: [".", docPath, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_ENV: "development",
      MARKIE_E2E: "1",
      MARKIE_DEV_URL: devOrigin,
    },
    log: path.join(artifactDir, "electron.log"),
  });
  closeWindow = win.close;

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("bridge", () => cdp.ev("!!window.electronAPI?.skillsCatalogList"), 40000);

  // One real skill on disk before the panel is ever opened, so the Installed
  // tab has something with a source, a description and a Remove to draw.
  const catalog = await cdp.ev(`window.electronAPI.skillsCatalogRefresh("anthropics/skills")`);
  const skills = (catalog?.skills || []).filter((s) => s.source === "anthropics/skills");
  const pdf = skills.find((s) => s.name === "pdf") || skills[0];
  check("the catalog downloads for real", Boolean(pdf), pdf ? `${skills.length} skills` : "none");
  if (!pdf) return cdp.close();
  const install = await cdp.ev(
    `window.electronAPI.skillsInstall(${JSON.stringify(pdf.id)}, ["claude"])`
  );
  check("a skill installs into the throwaway home", install?.installed?.length === 1,
    JSON.stringify(install?.errors ?? []));

  // ── Installed ────────────────────────────────────────────────────────────
  await cdp.ev(
    `document.querySelector('.markie-activity-bar [aria-label="Skills & agent files"]').click(), true`
  );
  await waitFor("the panel", () => cdp.ev(`!!${PANEL}`), 20000);
  await waitFor("the tabs", () => cdp.ev(`!!${tab("installed")}`), 20000);

  check(
    "the panel opens on Installed",
    (await cdp.ev(`${tab("installed")}.getAttribute("aria-pressed")`)) === "true"
  );

  const row = `${PANEL}.querySelector('[data-skills-installed]')`;
  await waitFor("the installed skill", () => cdp.ev(`!!${row}`), 20000);
  const rowText = await cdp.ev(text(row));
  check("the skill Markie installed is on the Installed tab", rowText.includes(pdf.name), rowText.trim().slice(0, 80));
  check("its row says where it came from", rowText.includes("from anthropics/skills"));
  check(
    "its row offers Remove, which only a folder Markie wrote may have",
    await cdp.ev(`!!${PANEL}.querySelector('[aria-label=${JSON.stringify(`Remove ${pdf.name}`)}]')`)
  );
  check(
    "Claude is a group heading, and the tools it never used to show are available to be",
    (await cdp.ev(`!!${PANEL}.querySelector('[data-skills-group="claude"]')`))
  );
  const installedShot = await shoot(cdp, "installed");
  check("Installed screenshot written", true, installedShot);

  // ── Discover ─────────────────────────────────────────────────────────────
  await cdp.ev(`${tab("discover")}.click(), true`);
  await waitFor("the catalog list", () => cdp.ev(`!!${PANEL}.querySelector('[data-skills-row]')`), 30000);
  const listText = await cdp.ev(text(`${PANEL}`));
  check("Discover lists the catalog, with its sources named", listText.includes("anthropics/skills"));
  check("and says when the catalog was last updated", /Catalog updated .* ago|Catalog updated just now/.test(listText),
    (listText.match(/Catalog updated[^A-Z]{0,24}/) || [""])[0]);
  const discoverShot = await shoot(cdp, "discover");
  check("Discover screenshot written", true, discoverShot);

  // ── One skill, in full ───────────────────────────────────────────────────
  await cdp.ev(
    `${PANEL}.querySelector('[data-skills-row=${JSON.stringify(pdf.id)}]').click(), true`
  );
  await waitFor("the detail pane", () => cdp.ev(`!!${PANEL}.querySelector('[data-skills-preview]')`), 20000);
  await waitFor(
    "the SKILL.md body",
    () => cdp.ev(`${text(`${PANEL}.querySelector('[data-skills-preview]')`)}.length > 200`),
    30000
  );
  const detailText = await cdp.ev(text(PANEL));
  check("the detail pane renders the SKILL.md body", detailText.length > 400, `${detailText.length} characters`);
  check("with the targets it can be added to", detailText.includes("Claude Code") && detailText.includes("Universal"));

  // The pane is three parts: the identity pinned at the top, the document in
  // the middle, and the install controls pinned at the bottom. The first and
  // the last stay put; only the middle scrolls.
  const IDENTITY = `${PANEL}.querySelector('[data-skills-identity]')`;
  const INSTALL = `${PANEL}.querySelector('[data-skills-install]')`;
  const SCROLLER = `${PANEL}.querySelector('[data-skills-preview]').closest('.overflow-y-auto')`;
  const BUTTON = `${INSTALL}.querySelector('button')`;
  const box = (label) => `${INSTALL}.querySelector('input[aria-label=${JSON.stringify(label)}]')`;
  // Fully inside the panel's own box, so it is on screen without any scrolling.
  const inView = (selector) =>
    `(() => { const el = ${selector}; if (!el) return false; const r = el.getBoundingClientRect(); const p = ${PANEL}.getBoundingClientRect(); return r.height > 0 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1; })()`;

  check(
    "the install button is in view before the document is scrolled",
    (await cdp.ev(`${SCROLLER}.scrollTop`)) === 0 && (await cdp.ev(inView(BUTTON)))
  );
  check(
    "the target Markie already installed to reads as Installed, not as a choice",
    (await cdp.ev(`(() => { const b = ${box("Claude Code")}; return !!b && b.disabled && b.checked; })()`)) &&
      (await cdp.ev(text(INSTALL))).includes("Installed")
  );
  check(
    "and with nothing new ticked, the button waits and says why",
    (await cdp.ev(`${BUTTON}.disabled`)) &&
      (await cdp.ev(text(INSTALL))).includes("already has the current copy")
  );
  const detailShot = await shoot(cdp, "detail");
  check("detail screenshot written", true, detailShot);

  await cdp.ev(`(() => { const el = ${SCROLLER}; el.scrollTop = el.scrollHeight; return true; })()`);
  check(
    "the skill's name stays in view when the document scrolls",
    (await cdp.ev(inView(IDENTITY))) && (await cdp.ev(text(IDENTITY))).includes(pdf.name)
  );

  // Ticking a target the skill is not in yet makes the button say where it is
  // about to go, and lights it.
  await cdp.ev(`${box("Codex")}.click(), true`);
  await waitFor("the button to name Codex", () => cdp.ev(`${text(BUTTON)}.includes("Add to Codex")`), 10000);
  check("ticking Codex makes the button say so, and enables it", !(await cdp.ev(`${BUTTON}.disabled`)));
  const addShot = await shoot(cdp, "detail-add-to");
  check("Add to Codex screenshot written", true, addShot);

  // A real install from the pane, into the throwaway home.
  await cdp.ev(`${BUTTON}.click(), true`);
  await waitFor("the install to report", () => cdp.ev(`${text(INSTALL)}.includes("Added to")`), 30000);
  const rows = await cdp.ev(`window.electronAPI.skillsInstalled()`);
  const codexRow = (rows || []).find((r) => r.target === "codex" && r.name === pdf.name);
  check(
    "a skill installs from the pane, and the folder is where the registry says",
    Boolean(codexRow) && existsSync(path.join(codexRow.path, "SKILL.md")),
    codexRow?.path ?? "no registry row"
  );
  const codexSettled = await waitFor(
    "Codex to read as Installed",
    () => cdp.ev(`(() => { const b = ${box("Codex")}; return !!b && b.disabled && b.checked; })()`),
    20000
  ).catch(() => false);
  check("and Codex now reads as Installed", Boolean(codexSettled));
  const addedShot = await shoot(cdp, "detail-added");
  check("added screenshot written", true, addedShot);

  // Back is a way out, not a dead end.
  await cdp.ev(
    `[...${PANEL}.querySelectorAll('button')].find((b) => b.textContent.includes("Back to skills")).click(), true`
  );
  await waitFor("the list again", () => cdp.ev(`!!${PANEL}.querySelector('[data-skills-row]')`), 20000);
  check("Back returns to the catalog", true);

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
