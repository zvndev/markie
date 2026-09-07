#!/usr/bin/env node
// The skill catalog against the real internet, in a real window.
//
// Everything else about skills is unit tested against a tarball built in the
// test, which proves the reader and the install rules but not the two things
// that only the network can answer: that codeload still hands back a tarball
// Markie's ustar reader can open, and that anthropics/skills still writes the
// front matter the catalog needs. So this one fetches for real.
//
// It installs into a throwaway HOME. Nothing here may touch the developer's own
// ~/.claude, ~/.agents or ~/.codex, which is also why the app runs with its own
// profile directory.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { endRun, launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("skills-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "skills-check");
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
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

async function main() {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-skills-home-")));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-skills-profile-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-skills-work-"));
  tempPaths.push(homeDir, userDataDir, workDir);
  const docPath = path.join(await realpath(workDir), "notes.md");
  await writeFile(docPath, "# Skills check\n", "utf-8");

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

  // ── Fetch ────────────────────────────────────────────────────────────────
  const catalog = await cdp.ev(
    `window.electronAPI.skillsCatalogRefresh("anthropics/skills")`
  );
  const source = catalog?.sources?.find((s) => s.id === "anthropics/skills");
  check(
    "anthropics/skills downloads and is read as a catalog",
    Boolean(source?.fetchedAt) && !source?.error,
    source?.error || `ref ${source?.ref}, commit ${String(source?.commit).slice(0, 12)}`
  );
  const skills = (catalog?.skills || []).filter((s) => s.source === "anthropics/skills");
  check("it holds skills with a name and a description", skills.length > 0, `${skills.length} found`);
  check(
    "every skill has a description and a folder hash",
    skills.length > 0 && skills.every((s) => s.description && /^[0-9a-f]{64}$/.test(s.folderHash))
  );

  const pdf = skills.find((s) => s.name === "pdf") || skills[0];
  check("a skill Markie can name a folder for is on offer", Boolean(pdf), pdf ? pdf.id : "none");
  if (!pdf) return cdp.close();

  const read = await cdp.ev(`window.electronAPI.skillsRead(${JSON.stringify(pdf.id)})`);
  check(
    "its SKILL.md reads back out of the cache without its front matter",
    Boolean(read?.body?.length) && !read.body.startsWith("---"),
    `${read?.body?.length ?? 0} characters, ${read?.files?.length ?? 0} files`
  );

  // ── Install ──────────────────────────────────────────────────────────────
  const result = await cdp.ev(
    `window.electronAPI.skillsInstall(${JSON.stringify(pdf.id)}, ["claude"])`
  );
  const dest = path.join(homeDir, ".claude", "skills", pdf.name);
  check(
    "installing to Claude Code answers with the folder it wrote",
    result?.installed?.[0]?.path === dest,
    JSON.stringify(result?.errors ?? [])
  );
  check("the skill's files are on disk in the throwaway home", existsSync(path.join(dest, "SKILL.md")));
  const script = (pdf.files || []).find((f) => f.path.startsWith("scripts/") && f.executable);
  if (script) {
    check(
      "a script keeps its executable bit through the copy",
      Boolean(statSync(path.join(dest, script.path)).mode & 0o111),
      script.path
    );
  }

  const installed = await cdp.ev(`window.electronAPI.skillsInstalled()`);
  const row = (installed || []).find((s) => s.path === dest);
  check(
    "the registry remembers the install, with its source and description",
    Boolean(row) && row.source === "anthropics/skills" && Boolean(row.description),
    row ? `${row.name} from ${row.source}` : "no row"
  );
  check("nothing claims an update is waiting straight after an install", row?.updateAvailable === false);

  const lockPath = path.join(homeDir, ".agents", ".skill-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf-8"));
  check(
    "the lock file the Vercel CLI reads carries the same entry",
    lock?.version === 3 &&
      lock?.skills?.[pdf.name]?.source === "anthropics/skills" &&
      lock.skills[pdf.name].sourceType === "github" &&
      lock.skills[pdf.name].skillFolderHash === pdf.folderHash,
    JSON.stringify(lock?.skills?.[pdf.name] ?? null).slice(0, 160)
  );

  // Installing again is Update: Markie wrote this folder, so it may replace it.
  const again = await cdp.ev(
    `window.electronAPI.skillsInstall(${JSON.stringify(pdf.id)}, ["claude"])`
  );
  check("installing the same skill again updates rather than refusing", again?.errors?.length === 0,
    JSON.stringify(again?.errors ?? []));

  // A folder Markie did not write is never replaced.
  const stranger = skills.find((s) => s.name !== pdf.name && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name));
  if (stranger) {
    const strangerDir = path.join(homeDir, ".claude", "skills", stranger.name);
    await mkdir(strangerDir, { recursive: true });
    await writeFile(path.join(strangerDir, "SKILL.md"), "mine, hand written\n", "utf-8");
    const refused = await cdp.ev(
      `window.electronAPI.skillsInstall(${JSON.stringify(stranger.id)}, ["claude"])`
    );
    const kept = await readFile(path.join(strangerDir, "SKILL.md"), "utf-8");
    check(
      "a folder Markie did not install is refused, not overwritten",
      refused?.errors?.[0]?.error === "exists" && kept === "mine, hand written\n",
      JSON.stringify(refused?.errors ?? [])
    );
    const wontRemove = await cdp.ev(
      `window.electronAPI.skillsRemove("claude", ${JSON.stringify(stranger.name)})`
    );
    check(
      "and it will not be removed either",
      wontRemove?.ok === false && existsSync(path.join(strangerDir, "SKILL.md")),
      wontRemove?.error ?? ""
    );
  }

  // ── Remove ───────────────────────────────────────────────────────────────
  const removed = await cdp.ev(
    `window.electronAPI.skillsRemove("claude", ${JSON.stringify(pdf.name)})`
  );
  const lockAfter = JSON.parse(await readFile(lockPath, "utf-8"));
  check(
    "removing takes the folder, the row and the lock entry with it",
    removed?.ok === true && !existsSync(dest) && !lockAfter?.skills?.[pdf.name],
    removed?.error ?? ""
  );
  const installedAfter = await cdp.ev(`window.electronAPI.skillsInstalled()`);
  check("and the installed list is empty again", (installedAfter || []).every((s) => s.path !== dest));

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
