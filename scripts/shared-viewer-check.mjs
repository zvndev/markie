#!/usr/bin/env node
// A viewer opens a document that was shared before anyone opened it live.
//
// Alice uploads a document through the REST API (an agent, the phone or the
// Cloud page all do the same) and shares it with Bob as a viewer. Nobody has
// opened it in a live session, so its collaboration room is empty. Bob opens
// it from his Cloud list in a real window, and the check asserts he reads the
// document, not a blank pane. Runs its own throwaway server and profile.
//
// Usage: MARKIE_ALLOW_E2E=1 npm run shared-viewer:check
// DEBUG_LIVE=1 also prints the registry row and what the renderer's own share
// client sees, which is how a session that never goes live gets explained.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { endRun, launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("shared-viewer-check", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "shared-viewer-check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempPaths = [];
let closeWindow = async () => {};
let stopRenderer = () => {};
let debugOrigin = "";

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
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLines.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
    }
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


let stopServer = () => {};
const checks = [];
const check = (name, passed, detail = "") => {
  checks.push(passed);
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};

const TRANSCRIPT = [
  "Meeting Title: Monday Meeting\\",
  "Transcript:\\",
  "Them: A 150 means you sold you know, $6.\\",
  ...Array.from({ length: 40 }, (_, i) => `Me: line ${i} of the conversation.\\`),
  "Them: You took a $100 worth of lemons.",
  "",
].join("\n");

async function startServer(port, dir, webOrigin) {
  const env = {
    ...process.env,
    // The dev window is served from a port picked for this run, and the
    // server answers credentialed CORS only for origins it was told about.
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

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-viewer-home-")));
  const userDataDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-viewer-profile-")));
  const serverDir = await realpath(await mkdtemp(path.join(tmpdir(), "markie-viewer-server-")));
  tempPaths.push(homeDir, userDataDir, serverDir);
  await mkdir(path.join(homeDir, "Downloads"), { recursive: true });
  await mkdir(path.join(homeDir, "Documents", "Markie"), { recursive: true });

  const apiPort = await pickPort();
  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  const SERVER = `http://localhost:${apiPort}`;
  const serverLog = await startServer(apiPort, serverDir, devOrigin);
  const ORIGIN = { Origin: "http://localhost:3000" };
  const call = async (token, method, route, body) => {
    const res = await fetch(`${SERVER}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...ORIGIN },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  };
  // Accounts prove their address before they can sign in. This server and its
  // database exist only for this run, so the proof is written straight into it,
  // the way server/src/test-users.ts does.
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
  const docId = `viewer-${stamp}`;
  const hash = createHash("sha256").update(TRANSCRIPT, "utf8").digest("hex");
  let res = await call(aliceToken, "PUT", `/api/docs/${docId}`, { name: "Monday Meeting.md", content: TRANSCRIPT, hash, baseVersion: 0 });
  if (!res.ok) throw new Error(`create: ${res.status} ${await res.text()}`);
  res = await call(aliceToken, "POST", `/api/docs/${docId}/shares`, { email: bobEmail, role: "viewer" });
  if (!res.ok) throw new Error(`share: ${res.status} ${await res.text()}`);

  // A second document Alice has already opened live, so its room holds the
  // text. Bob's app has to join it with a live-editing pass and show the room.
  const liveId = `live-${stamp}`;
  const liveText = "# Live doc\n\nWritten in the room.\n";
  res = await call(aliceToken, "PUT", `/api/docs/${liveId}`, { name: "Live doc.md", content: liveText, hash: createHash("sha256").update(liveText, "utf8").digest("hex"), baseVersion: 0 });
  if (!res.ok) throw new Error(`create live doc: ${res.status} ${await res.text()}`);
  res = await call(aliceToken, "POST", `/api/docs/${liveId}/shares`, { email: bobEmail, role: "viewer" });
  if (!res.ok) throw new Error(`share live doc: ${res.status} ${await res.text()}`);
  const Y = require("yjs");
  const { WebsocketProvider } = require("y-websocket");
  const WS = require("ws");
  const pass = await (await call(aliceToken, "POST", `/api/docs/${liveId}/collab-ticket`, {})).json();
  const aliceDoc = new Y.Doc();
  const aliceLive = new WebsocketProvider(`ws://localhost:${apiPort}/collab`, liveId, aliceDoc, { WebSocketPolyfill: WS, params: { ticket: pass.ticket }, disableBc: true });
  await new Promise((resolve) => (aliceLive.synced ? resolve() : aliceLive.once("sync", resolve)));
  aliceDoc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Only the live room has this line.")]);
    aliceDoc.getXmlFragment("default").insert(0, [paragraph]);
  });
  await sleep(500);

  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;
  const win = await launchElectron({
    debugPort,
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_E2E_DOWNLOADS: path.join(homeDir, "Downloads"), MARKIE_DEV_URL: devOrigin },
    log: path.join(artifactDir, "electron.log"),
  });
  closeWindow = win.close;
  let cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await cdp.ev(`localStorage.setItem("markie.server.v1", ${JSON.stringify(SERVER)}); localStorage.setItem("markie.token.v1", ${JSON.stringify(bobToken)}); true`);
  await cdp.send("Page.reload");
  await sleep(1000);
  await waitFor("editor", () => cdp.ev("!!window.__markieEditor"), 40000);
  await sleep(1500);

  const opened = await cdp.ev(`window.electronAPI.docOpenShared({ cloudId: ${JSON.stringify(docId)}, suggestedName: "Monday Meeting.md" })`);
  check("the shared document downloads and opens", !!opened?.ok, JSON.stringify(opened));
  if (opened?.path && !opened.path.startsWith(homeDir)) {
    throw new Error(`the document landed outside the throwaway home: ${opened.path}`);
  }
  await waitFor("title", () => cdp.ev(`document.title.startsWith("Monday Meeting")`), 20000).catch(() => {});
  // Long enough for the role check, the live session, its first sync and the
  // settle delay, with room to spare. Sampled along the way, because a pane
  // that is blank only while live is exactly what this is looking for.
  const timeline = [];
  for (let i = 0; i < 12; i += 1) {
    await sleep(500);
    timeline.push(await cdp.ev(`(() => { const pm = document.querySelector('[data-markie-rich-pane] .ProseMirror'); return (window.__markieCollab ? 'L' : 's') + (pm?.textContent?.length ?? -1); })()`));
  }
  process.stdout.write(`       timeline (L=live s=solo, then text length): ${timeline.join(" ")}\n`);
  if (process.env.DEBUG_LIVE) {
    const row = await cdp.ev(`window.electronAPI.registryGet(${JSON.stringify(opened.path)})`);
    process.stdout.write(`       registry row: ${JSON.stringify(row)}\n`);
    const probe = await cdp.ev(`(async () => {
      const m = await import('/src/lib/auth-client.ts');
      const store = await import('/src/lib/auth-store.ts');
      const me = (await store.authStore.ready()).user;
      const cid = ${JSON.stringify(docId)};
      const [access, members] = await Promise.all([m.sharesClient.access(cid).catch((e) => 'ERR ' + e), m.sharesClient.list(cid).catch((e) => 'ERR ' + e)]);
      return JSON.stringify({ me: me && { id: me.id, email: me.email }, access, members, server: m.getServerURL() });
    })()`);
    process.stdout.write(`       renderer view: ${probe}\n`);
  }
  const state = await cdp.ev(`(() => {
    const pm = document.querySelector('[data-markie-rich-pane] .ProseMirror');
    return {
      title: document.title,
      text: pm?.textContent ?? null,
      editable: pm?.getAttribute('contenteditable') ?? null,
      live: !!window.__markieCollab,
      banners: [...document.querySelectorAll('[role=status]')].map((b) => b.textContent.trim()).filter(Boolean),
    };
  })()`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, "viewer.png");
  await writeFile(shotPath, Buffer.from(shot.result.data, "base64"));
  process.stdout.write(`       screenshot: ${shotPath}\n       state: ${JSON.stringify({ ...state, text: state.text?.slice(0, 80) })}\n`);
  check("the viewer reads the document, not a blank pane", !!state.text && state.text.includes("You took a $100 worth of lemons."), `text length ${state.text?.length ?? "none"}`);
  check("the pane stays read-only for a viewer", state.editable === "false", `contenteditable=${state.editable}`);
  const errors = cdp.consoleLines.filter((l) => /EXCEPTION|error:/i.test(l) && !/Security Warning|DevTools/.test(l));
  check("no renderer exceptions", errors.length === 0, errors.slice(0, 5).join(" | "));

  // The live document: Bob joins Alice's room through a pass.
  const openedLive = await cdp.ev(`window.electronAPI.docOpenShared({ cloudId: ${JSON.stringify(liveId)}, suggestedName: "Live doc.md" })`);
  check("the live document downloads and opens", !!openedLive?.ok, JSON.stringify(openedLive));
  let liveState = null;
  for (let i = 0; i < 24; i += 1) {
    await sleep(500);
    liveState = await cdp.ev(`(() => { const pm = document.querySelector('[data-markie-rich-pane] .ProseMirror'); return { live: !!window.__markieCollab, text: pm?.textContent ?? '' }; })()`);
    if (liveState.live && liveState.text.includes("Only the live room has this line.")) break;
  }
  check("Bob joins Alice's live room and reads what is in it", !!liveState?.live && liveState.text.includes("Only the live room has this line."), JSON.stringify(liveState));
  const asked = serverLog.join("").includes("collab: legacy token connection");
  check("the app joined with a pass, never the session token", !asked, asked ? "the server logged a legacy token connection" : "");
  aliceLive.destroy();
  if (process.env.SHOW_SERVER_LOG) process.stdout.write(serverLog.join(""));
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
