#!/usr/bin/env node
// End-to-end check for sync-down: a real server, a real account, a real second
// writer moving the document on, and the real renderer reacting to it.
//
// Nothing is stubbed. The preload bridge is frozen and non-configurable, which
// is correct of it, so faking the server at that boundary is not possible and
// would not have proven much anyway. The failure this work exists to fix was
// never in the sync engine: "behind" was already computed correctly and simply
// never reached the screen. Only a real run can show that it now does.
//
//   node scripts/sync-down-check.mjs
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("sync-down-check", import.meta.url);


const root = path.resolve(new URL("..", import.meta.url).pathname);
const serverDir = path.join(root, "server");
const require = createRequire(path.join(serverDir, "package.json"));
const WebSocket = require("ws");
const node = process.execPath;
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `sync-down-check-${stamp}`);
const children = [];
const tempPaths = [];

const SERVER_PORT = 8791;
const SERVER = `http://localhost:${SERVER_PORT}`;
let devOrigin = "http://localhost:3000";
let debugOrigin = "http://127.0.0.1:9222";

const baseEnv = {
  ...process.env,
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? "markie-local-sync-down-verifier-secret-32",
};

await mkdir(artifactDir, { recursive: true });
const logPath = (name) => path.join(artifactDir, `${name}.log`);

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  if (options.log) {
    const stream = createWriteStream(options.log, { flags: "a" });
    child.stdout?.pipe(stream, { end: false });
    child.stderr?.pipe(stream, { end: false });
    child.on("exit", () => stream.end());
  }
  return child;
}

async function stopChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) return resolve();
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 1500);
        })
    )
  );
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  // The window boots at the default dev port, not the one this run allocated,
  // so it sits on chrome-error:// until Page.navigate moves it.
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
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
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
      ?.result?.value;
  return { send, ev, close: () => ws.close() };
}

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
}

// ── The other writer: a second client moving the document on ───────────────
const ORIGIN = { Origin: "http://localhost:3000" };
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function putDoc(token, docId, name, content, baseVersion) {
  const res = await fetch(`${SERVER}/api/docs/${docId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...ORIGIN,
    },
    body: JSON.stringify({ name, content, hash: sha(content), baseVersion }),
  });
  if (!res.ok) throw new Error(`PUT ${docId}: ${res.status} ${await res.text()}`);
  return (await res.json()).version;
}

async function signUp(name, email, password) {
  const res = await fetch(`${SERVER}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN },
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) throw new Error(`signup: ${res.status} ${await res.text()}`);
  return res.headers.get("set-auth-token");
}

const STRIP = `document.querySelector('[data-markie-update-strip]')?.innerText ?? null`;
const STRIP_BUTTON = `document.querySelector('[data-markie-update-strip] button')`;
const DIALOG = `document.querySelector('[aria-labelledby="markie-conflict-title"]')`;

async function main() {
  const dbDir = await mkdtemp(path.join(tmpdir(), "markie-syncdown-db-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-syncdown-user-"));
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-syncdown-docs-"));
  tempPaths.push(dbDir, userDataDir, workDir);
  const dbPath = path.join(dbDir, "markie.db");
  const serverEnv = { ...baseEnv, DB_PATH: dbPath, PORT: String(SERVER_PORT) };

  await new Promise((resolve, reject) => {
    const m = spawn(node, ["--experimental-strip-types", "src/migrate.ts"], {
      cwd: serverDir,
      env: serverEnv,
      stdio: "ignore",
    });
    m.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))));
  });

  start("npm", ["run", "start"], { cwd: serverDir, env: serverEnv, log: logPath("server") });
  await waitFor("server health", async () => (await fetch(`${SERVER}/health`).catch(() => null))?.ok);

  const token = await signUp("Alice", `alice.${Date.now()}@test.local`, "password-123");
  const V1 = "# Notes\n\nline one\nline two\nline three\n";
  // Written into a temp dir this run owns. An earlier version of this script
  // used docOpenShared, which writes to the OS Downloads folder; Electron
  // resolves that through the OS, not $HOME, so it left files in the real one.
  const docPath = await realpath(workDir).then((d) => path.join(d, "sync-down.md"));
  await writeFile(docPath, V1, "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    env: baseEnv,
    log: logPath("next"),
  });
  await waitFor("Next dev renderer", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  // The fixture is passed as a launch argument, which is the double-click route
  // and grants the file outright.
  start(
    electronBin,
    [".", docPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: { ...baseEnv, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: logPath("electron"),
    }
  );

  const cdp = await waitFor("Electron CDP target", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete' && !!document.body"), 40000);
  await waitFor("preload", () => cdp.ev("!!window.electronAPI"), 30000);

  await cdp.ev(`localStorage.setItem("markie.server.v1", ${JSON.stringify(SERVER)})`);
  await cdp.ev(`localStorage.setItem("markie.token.v1", ${JSON.stringify(token)})`);
  // No reload: get-initial-file hands over the launch argument once, and a
  // reload would consume it before the app could show it. getAuthToken() reads
  // localStorage on every call, so the token is live without one.
  await cdp.ev(
    `window.electronAPI.syncConfig({ token: ${JSON.stringify(token)}, serverURL: ${JSON.stringify(SERVER)} })`
  );
  await waitFor("editor boot", () => cdp.ev("!!window.__markieEditor"), 40000);

  await waitFor("document loaded", () => cdp.ev(`window.__markieEditor.getText().includes("line one")`), 30000);

  // Sync it to the account, the same way the Library's "Sync to cloud" does.
  const syncedOn = JSON.parse(
    await cdp.ev(
      `window.electronAPI.docSyncOn({ path: ${JSON.stringify(docPath)}, name: "sync-down.md", content: ${JSON.stringify(V1)} }).then(JSON.stringify)`
    )
  );
  if (!syncedOn?.ok) throw new Error(`docSyncOn failed: ${JSON.stringify(syncedOn)}`);
  const row = JSON.parse(
    await cdp.ev(`window.electronAPI.registryGet(${JSON.stringify(docPath)}).then(JSON.stringify)`)
  );
  const docId = row.cloud_doc_id;
  const v1 = syncedOn.version;
  if (!docId) throw new Error(`no cloud id after sync: ${JSON.stringify(row)}`);

  const focus = async () => {
    await cdp.ev(`window.dispatchEvent(new Event("focus"))`);
    await new Promise((r) => setTimeout(r, 900));
  };

  // Opening a file must not mark it edited. This was fixed once (3c439f7); it
  // is asserted here because the update strip's clean/dirty split now depends
  // on it, and a regression would silently route every pull through a dialog.
  check(
    "opening a document does not mark it edited",
    !(await cdp.ev(`document.title.startsWith("•")`)),
    await cdp.ev(`document.title`)
  );

  // ── Nothing newer on the server ─────────────────────────────────────────
  await focus();
  check("no strip while the local copy is current", (await cdp.ev(STRIP)) === null);

  // ── Another writer moves the document on ────────────────────────────────
  const V2 = "# Notes\n\nline one\nline two\nline three\nline four from elsewhere\n";
  const v2 = await putDoc(token, docId, "sync-down.md", V2, v1);
  await focus();
  const cleanStrip = await waitFor("update strip", () => cdp.ev(STRIP), 20000);
  check(
    "the registry calls a freshly pulled document synced",
    (await cdp.ev(`window.electronAPI.docCheckUpdates().then(r => r.updates[0]?.syncState ?? "none")`)) ===
      "synced",
    await cdp.ev(`window.electronAPI.docCheckUpdates().then(r => JSON.stringify(r.updates))`)
  );
  check("the open document says the server moved on", !!cleanStrip, JSON.stringify(cleanStrip));
  check("a clean copy gets a one-click Update", cleanStrip.includes("Update"), JSON.stringify(cleanStrip));
  check("a clean copy is not sent to a dialog", !cleanStrip.includes("Review"), JSON.stringify(cleanStrip));

  await cdp.ev(`${STRIP_BUTTON}.click()`);
  check(
    "Update brings the server's text into the open buffer",
    await waitFor("pull applied", () => cdp.ev(`window.__markieEditor.getText().includes("line four from elsewhere")`), 20000)
  );
  check(
    "the file on disk holds the pulled text",
    readFileSync(docPath, "utf-8").includes("line four from elsewhere"),
    docPath
  );
  check("the strip clears once there is nothing left to pull", (await cdp.ev(STRIP)) === null);

  // ── Both sides change: the case that used to destroy work silently ──────
  await cdp.ev(
    `window.__markieEditor.commands.setContent(${JSON.stringify(
      "# Notes\n\nline one\nline two\nline three\nline four from elsewhere\nMY OWN UNSAVED LINE\n"
    )})`
  );
  await waitFor("buffer dirty", () => cdp.ev(`document.title.startsWith("•")`), 10000);
  const V3 =
    "# Notes\n\nline one\nline two\nline three\nline four from elsewhere\nfifth from elsewhere\nsixth from elsewhere\n";
  await putDoc(token, docId, "sync-down.md", V3, v2);
  await focus();
  const dirtyStrip = await waitFor(
    "conflict strip",
    async () => {
      const t = await cdp.ev(STRIP);
      return t && t.includes("Review") ? t : null;
    },
    20000
  );
  check("local changes route through the dialog, not a one-click pull", dirtyStrip.includes("Review changes"), JSON.stringify(dirtyStrip));

  await cdp.ev(`${STRIP_BUTTON}.click()`);
  const dialogText = await waitFor(
    "diff summary",
    async () => {
      const t = await cdp.ev(`${DIALOG}?.innerText ?? null`);
      return t && !t.includes("Comparing with the server") ? t : null;
    },
    20000
  );
  check("the dialog counts the lines at stake", /\d+ lines?/.test(dialogText), JSON.stringify(dialogText));
  check(
    "it says what a pull replaces before what it brings in",
    dialogText.includes("replaces") &&
      dialogText.indexOf("replaces") < dialogText.indexOf("brings in"),
    JSON.stringify(dialogText)
  );
  check("Keep both is offered", dialogText.includes("Keep both"));
  check("Pull and overwrite is offered", dialogText.includes("Pull and overwrite"));
  check(
    "Keep both holds focus, so Return cannot overwrite anything",
    await cdp.ev(`document.activeElement?.textContent?.includes("Keep both") === true`)
  );

  const keepBoth = `[...${DIALOG}.querySelectorAll("button")].find(b => b.textContent.includes("Keep both"))`;
  await cdp.ev(`${keepBoth}.click()`);
  check(
    "the dialog closes once it has resolved",
    await waitFor("dialog closed", () => cdp.ev(`!${DIALOG}`), 20000)
  );

  const dir = path.dirname(docPath);
  const rescued = readdirSync(dir).filter((f) => f.includes("(my version)"));
  check("Keep both leaves the local version on disk under its own name", rescued.length === 1, rescued.join(", "));
  if (rescued.length === 1) {
    const kept = readFileSync(path.join(dir, rescued[0]), "utf-8");
    check("the rescued file holds the local text, not the server's", kept.includes("MY OWN UNSAVED LINE"));
  }
  check(
    "the original now holds the server's text",
    readFileSync(docPath, "utf-8").includes("sixth from elsewhere")
  );
  check(
    "the open buffer follows the original, not the rescued copy",
    await waitFor("buffer followed", () => cdp.ev(`window.__markieEditor.getText().includes("sixth from elsewhere")`), 20000)
  );
  check(
    "the buffer no longer holds the text it rescued",
    !(await cdp.ev(`window.__markieEditor.getText().includes("MY OWN UNSAVED LINE")`))
  );

  // Retry backup: the Library's only exit from "unpushed". It runs entirely in
  // the main process (grant check, read from disk, push), so nothing but a real
  // run exercises it. Last, because a successful push bumps the server version
  // and every earlier step depends on that sequence.
  const retried = JSON.parse(
    await cdp.ev(
      `window.electronAPI.docRetryPush({ path: ${JSON.stringify(docPath)} }).then(JSON.stringify)`
    )
  );
  check(
    "Retry backup pushes a tracked file the renderer never opened for it",
    retried?.ok === true,
    JSON.stringify(retried)
  );

  cdp.close();
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`\nrun failed: ${error.message}\n`);
} finally {
  await stopChildren();
  for (const p of tempPaths) await rm(p, { recursive: true, force: true });
}

const bad = checks.filter((c) => !c.passed);
process.stdout.write(`\n${checks.length - bad.length}/${checks.length} checks passed\n`);
if (bad.length || failed || !checks.length) {
  process.stdout.write(`logs: ${artifactDir}\n`);
  process.exit(1);
}
if (existsSync(artifactDir)) await rm(artifactDir, { recursive: true, force: true });
