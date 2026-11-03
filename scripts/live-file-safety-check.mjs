#!/usr/bin/env node
// A live rich session must not rewrite the user's own file with what the room
// can say. Alice shares three documents with Bob as an editor; Bob opens them
// in a real window against a throwaway server and profile, and the check reads
// each file back from disk.
//
//   1. A document with front matter, a raw HTML block, an HTML comment and a
//      footnote, opened live in Rich: the file must keep every byte, before
//      and after Bob types, while his typing still reaches Alice in the room.
//   2. A plain document, opened live in Rich: Bob's typing lands in the file.
//   3. The first kind of document opened live in Source, then switched to
//      Rich: Source is read-only, and neither step touches the file.
//
// Usage: MARKIE_ALLOW_E2E=1 npm run live-file-safety:check
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { endRun, launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("live-file-safety-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "live-file-safety-check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempPaths = [];
let closeWindow = async () => {};
let stopRenderer = () => {};
let stopServer = () => {};
let debugOrigin = "";

const HELD = [
  "---",
  "title: Shared plan",
  "tags: [a, b]",
  "---",
  "",
  "# Plan",
  "",
  "Body text with a note.[^1]",
  "",
  '<div align="center">',
  '  <img src="logo.png" width="80">',
  "</div>",
  "",
  "<!-- keep this comment -->",
  "",
  "[^1]: The footnote.",
  "",
].join("\n");
const PLAIN = "# Plain plan\n\nNothing here needs holding aside.\n";

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
    await sleep(150);
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
  const consoleLines = [];
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.method === "Runtime.exceptionThrown") {
      consoleLines.push(`EXCEPTION: ${JSON.stringify(msg.params.exceptionDetails).slice(0, 800)}`);
    }
    if (msg.id && pending.has(msg.id)) {
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      settle(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) => {
    const reply = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  };
  return { send, ev, consoleLines, close: () => ws.close() };
}

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push(passed);
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};

async function startServer(port, dir, webOrigin) {
  const env = {
    ...process.env,
    MARKIE_WEB_ORIGINS: webOrigin,
    DB_PATH: path.join(dir, "markie.db"),
    PORT: String(port),
    BETTER_AUTH_URL: `http://localhost:${port}`,
  };
  const serverDir = path.join(root, "server");
  const migrate = spawn(process.execPath, ["--experimental-strip-types", "src/migrate.ts"], { cwd: serverDir, env, stdio: "ignore" });
  await new Promise((res, rej) => migrate.on("exit", (code) => (code === 0 ? res() : rej(new Error(`migrate exited ${code}`)))));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  stopServer = () => child.kill("SIGTERM");
  process.on("exit", () => child.kill("SIGTERM"));
  await waitFor("server", async () => (await fetch(`http://localhost:${port}/health`).catch(() => null))?.status < 500, 30000);
  return log;
}

// A short, readable account of how a file on disk differs from what it was.
function describeDiff(before, after) {
  if (before === after) return "unchanged";
  return `now reads: ${JSON.stringify(after.slice(0, 220))}`;
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-livefile-home-")));
  const userDataDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-livefile-profile-")));
  const serverDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-livefile-server-")));
  tempPaths.push(homeDir, userDataDir, serverDir);
  await mkdir(path.join(homeDir, "Downloads"), { recursive: true });
  await mkdir(path.join(homeDir, "Documents", "Markie"), { recursive: true });

  const apiPort = await pickPort();
  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  const SERVER = `http://localhost:${apiPort}`;
  await startServer(apiPort, serverDir, devOrigin);
  const ORIGIN = { Origin: "http://localhost:3000" };
  const call = (token, method, route, body) =>
    fetch(`${SERVER}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...ORIGIN },
      body: body ? JSON.stringify(body) : undefined,
    });
  // This server and its database exist only for this run, so the address
  // proof is written straight into it, the way server/src/test-users.ts does.
  const Database = require("better-sqlite3");
  const signUp = async (name, email) => {
    let res = await call(null, "POST", "/api/auth/sign-up/email", { name, email, password: "password-123" });
    if (!res.ok) throw new Error(`sign-up ${email}: ${res.status} ${await res.text()}`);
    const db = new Database(path.join(serverDir, "markie.db"));
    db.prepare('UPDATE "user" SET emailVerified = 1 WHERE email = ?').run(email);
    db.close();
    res = await call(null, "POST", "/api/auth/sign-in/email", { email, password: "password-123" });
    if (!res.ok) throw new Error(`sign-in ${email}: ${res.status} ${await res.text()}`);
    return res.headers.get("set-auth-token");
  };
  const stamp = Date.now();
  const aliceToken = await signUp("Alice", `alice.${stamp}@test.local`);
  const bobEmail = `bob.${stamp}@test.local`;
  const bobToken = await signUp("Bob", bobEmail);
  const share = async (id, name, content) => {
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    let res = await call(aliceToken, "PUT", `/api/docs/${id}`, { name, content, hash, baseVersion: 0 });
    if (!res.ok) throw new Error(`create ${name}: ${res.status} ${await res.text()}`);
    res = await call(aliceToken, "POST", `/api/docs/${id}/shares`, { email: bobEmail, role: "editor" });
    if (!res.ok) throw new Error(`share ${name}: ${res.status} ${await res.text()}`);
  };
  const heldId = `held-${stamp}`;
  const plainId = `plain-${stamp}`;
  const sourceId = `source-${stamp}`;
  await share(heldId, "Shared plan.md", HELD);
  await share(plainId, "Plain plan.md", PLAIN);
  await share(sourceId, "Source plan.md", HELD);

  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;
  const env = { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_E2E_DOWNLOADS: path.join(homeDir, "Downloads"), MARKIE_DEV_URL: devOrigin };
  delete env.ELECTRON_RUN_AS_NODE;
  const win = await launchElectron({
    debugPort,
    args: [".", `--user-data-dir=${userDataDir}`],
    env,
    log: path.join(artifactDir, "electron.log"),
  });
  closeWindow = win.close;
  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await cdp.ev(`localStorage.setItem("markie.server.v1", ${JSON.stringify(SERVER)}); localStorage.setItem("markie.token.v1", ${JSON.stringify(bobToken)}); true`);
  await cdp.send("Page.reload");
  await sleep(1000);
  await waitFor("editor", () => cdp.ev("!!window.__markieEditor"), 40000);
  await sleep(1500);

  const open = async (cloudId, name) => {
    const opened = await cdp.ev(`window.electronAPI.docOpenShared({ cloudId: ${JSON.stringify(cloudId)}, suggestedName: ${JSON.stringify(name)} })`);
    if (!opened?.ok || !opened.path) throw new Error(`open ${name}: ${JSON.stringify(opened)}`);
    if (!opened.path.startsWith(homeDir)) throw new Error(`the document landed outside the throwaway home: ${opened.path}`);
    return opened.path;
  };
  const live = () =>
    cdp.ev(`!!(window.__markieCollab && window.__markieCollab.provider.synced && window.__markieEditor && window.__markieEditor.isEditable)`);
  const typeAtEnd = (word) =>
    cdp.ev(`(() => { const ed = window.__markieEditor; ed.commands.insertContentAt(ed.state.doc.content.size - 1, ${JSON.stringify(word)}); return ed.getText().includes(${JSON.stringify(word.trim())}); })()`);
  const banners = () => cdp.ev(`[...document.querySelectorAll('[role=status]')].map((b) => b.textContent.trim()).filter(Boolean)`);
  const shot = async (name) => {
    const s = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(artifactDir, `${name}.png`);
    await writeFile(file, Buffer.from(s.result.data, "base64"));
    return file;
  };
  const roomText = async (docId) => {
    const Y = require("yjs");
    const { WebsocketProvider } = require("y-websocket");
    const pass = await (await call(aliceToken, "POST", `/api/docs/${docId}/collab-ticket`, {})).json();
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://localhost:${apiPort}/collab`, docId, doc, { WebSocketPolyfill: WebSocket, params: { ticket: pass.ticket }, disableBc: true });
    await new Promise((resolve) => (provider.synced ? resolve() : provider.once("sync", resolve)));
    await sleep(300);
    const text = doc.getXmlFragment("default").toString();
    provider.destroy();
    return text;
  };

  // 1. Front matter and held constructs, live in Rich.
  const heldPath = await open(heldId, "Shared plan.md");
  await waitFor("the held document to go live", live, 30000);
  // The room seeds, the serializer debounce and the autosave clock all run.
  await sleep(4000);
  const heldOpened = await readFile(heldPath, "utf8");
  check("opening it live leaves the file's bytes alone", heldOpened === HELD, describeDiff(HELD, heldOpened));
  check("Bob's typing reaches his editor", await typeAtEnd(" typed-held"));
  await sleep(4000);
  const heldTyped = await readFile(heldPath, "utf8");
  check("typing in the live session leaves the file's bytes alone", heldTyped === HELD, describeDiff(HELD, heldTyped));
  const heldRoom = await roomText(heldId);
  check("Alice sees Bob's typing in the room", heldRoom.includes("typed-held"), heldRoom.slice(0, 200));
  const heldBanners = await banners();
  check("the pane says the file is not updated from the live session", heldBanners.some((b) => b.includes("isn't updated from the live session")), JSON.stringify(heldBanners));
  process.stdout.write(`       screenshot: ${await shot("held-rich")}\n`);

  // 2. A plain document still saves live edits to its file.
  const plainPath = await open(plainId, "Plain plan.md");
  await waitFor("the plain document to go live", live, 30000);
  await sleep(1500);
  await typeAtEnd(" typed-plain");
  await sleep(4000);
  const plainTyped = await readFile(plainPath, "utf8");
  check("a plain document's live edits land in its file", plainTyped.includes("typed-plain"), JSON.stringify(plainTyped));

  // 3. Opened live in Source, then switched to Rich.
  await cdp.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true })); true`);
  await waitFor("Source mode", () => cdp.ev(`!document.querySelector('[data-markie-rich-pane]') && !!document.querySelector('[data-markie-source-pane]')`), 10000);
  const sourcePath = await open(sourceId, "Source plan.md");
  await sleep(5000);
  const sourceText = () => cdp.ev(`document.querySelector('[data-markie-source-pane] .cm-content')?.textContent ?? null`);
  const sourceBefore = await sourceText();
  // CodeMirror's read-only state refuses input without changing the
  // contenteditable attribute, so the proof is that typing changes nothing.
  await cdp.ev(`(() => { const cm = document.querySelector('[data-markie-source-pane] .cm-content'); cm?.focus(); return true; })()`);
  await cdp.send("Input.insertText", { text: "typed-source" });
  await sleep(2500);
  const sourceAfter = await sourceText();
  const sourceState = await cdp.ev(`({ live: !!window.__markieCollab, banners: [...document.querySelectorAll('[role=status]')].map((b) => b.textContent.trim()).filter(Boolean) })`);
  process.stdout.write(`       source state: ${JSON.stringify(sourceState)}\n`);
  check("Source refuses typing while the document is live", !!sourceBefore && sourceAfter === sourceBefore, sourceAfter === sourceBefore ? "" : "the source pane took the typing");
  const sourceOpened = await readFile(sourcePath, "utf8");
  check("opening it live in Source leaves the file alone", sourceOpened === HELD, describeDiff(HELD, sourceOpened));
  await cdp.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Digit1", metaKey: true, bubbles: true })); true`);
  await waitFor("the source document to go live in Rich", live, 30000);
  await sleep(4000);
  const sourceRich = await readFile(sourcePath, "utf8");
  check("switching that document to Rich leaves the file alone", sourceRich === HELD, describeDiff(HELD, sourceRich));

  const errors = cdp.consoleLines.filter((l) => /EXCEPTION/.test(l));
  check("no renderer exceptions", errors.length === 0, errors.slice(0, 3).join(" | "));
  cdp.close();
}

try {
  await main();
} catch (e) {
  process.stdout.write(`check failed: ${e.stack ?? e}\n`);
  process.exitCode = 1;
} finally {
  await closeWindow();
  stopRenderer();
  stopServer();
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
  if (checks.some((c) => !c)) process.exitCode = 1;
  await endRun();
}
