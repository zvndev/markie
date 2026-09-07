#!/usr/bin/env node
// The Skills panel in a real window: both tabs, a real install, and the detail
// pane rendering a real SKILL.md through the document renderer.
//
// The component tests drive the panel against the mock bridge, which proves the
// wiring but not that the panel and the main process agree once a real catalog
// is on the other side of the preload boundary. This one downloads
// anthropics/skills for real, installs a skill into a throwaway HOME, and then
// looks at the panel the way a person would.
//
// Nothing here may touch the developer's own ~/.claude, ~/.agents or ~/.codex,
// which is why HOME is a fresh temp directory and the app runs with its own
// profile.
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
  check("and says when it was last checked", /checked .* ago|checked just now/.test(listText),
    (listText.match(/checked[^A-Z]{0,24}/) || [""])[0]);
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
  check(
    "and Add to… is offered rather than an Add that says nothing",
    await cdp.ev(`!!${PANEL}.querySelector('button')`) && /Add skill|Update/.test(detailText)
  );
  const detailShot = await shoot(cdp, "detail");
  check("detail screenshot written", true, detailShot);

  // The Add to… block sits under the file list, so it takes a scroll to see.
  await cdp.ev(
    `(() => { const el = ${PANEL}.querySelector('[data-skills-preview]').closest('.overflow-y-auto'); el.scrollTop = el.scrollHeight; return true; })()`
  );
  const addShot = await shoot(cdp, "detail-add-to");
  check("Add to… screenshot written", true, addShot);

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
