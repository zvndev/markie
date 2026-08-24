#!/usr/bin/env node
// Proves the crash screen and the crash log in a real window.
//
// The crash screen is the one surface normal use never exercises, so it is the
// one most likely to be broken when it finally matters. This deliberately
// breaks the app three ways — a render error, a thrown error outside render,
// and an unhandled promise rejection — and checks that each is both shown to
// the user (where it blanks the window) and written down.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "crash-check");
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
    detached: true,
  });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}

function killTree(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  }
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
    await new Promise((r) => setTimeout(r, 300));
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

const bodyHas = (text) =>
  `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

const crashLog = `window.electronAPI.crashLogRead().then((r) => JSON.stringify(r))`;

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-crash-profile-"));
  tempPaths.push(userDataDir);

  // Stand in for Sentry's ingest endpoint, so "what actually leaves the
  // machine" is something this check can read rather than assume.
  const ingest = [];
  const ingestPort = await pickPort();
  const ingestServer = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      ingest.push({ url: req.url, auth: req.headers["x-sentry-auth"], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => ingestServer.listen(ingestPort, "127.0.0.1", r));
  children.push({ pid: -1, exitCode: null, kill: () => ingestServer.close() });
  const dsn = `http://testkey@127.0.0.1:${ingestPort}/4242`;

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start("npm", ["run", "dev", "--", "--port", String(devPort)], {
    log: path.join(artifactDir, "next.log"),
  });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: {
        ...process.env,
        NODE_ENV: "development",
        MARKIE_E2E: "1",
        MARKIE_SENTRY_DSN: dsn,
      },
      log: path.join(artifactDir, "electron.log"),
    }
  );

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("first paint", () => cdp.ev(bodyHas("markie")), 40000);

  check("the crash log starts empty", (await cdp.ev(crashLog)) === "[]");

  // ── Errors outside render ──────────────────────────────────────────────
  // Neither of these blanks the window, which is exactly why they used to
  // disappear without a trace.
  await cdp.ev(`window.dispatchEvent(new ErrorEvent("error", {
    error: new Error("probe: window error"), message: "probe: window error" })), true`);
  await cdp.ev(`window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", {
    promise: Promise.resolve(), reason: new Error("probe: rejected promise") })), true`);
  await new Promise((r) => setTimeout(r, 500));

  const afterGlobals = JSON.parse((await cdp.ev(crashLog)) || "[]");
  check(
    "a thrown error outside render is written down",
    afterGlobals.some((r) => r.source === "window-error" && /window error/.test(r.message)),
    `sources: ${afterGlobals.map((r) => r.source).join(", ") || "none"}`
  );
  check(
    "an unhandled promise rejection is written down",
    afterGlobals.some((r) => r.source === "unhandled-rejection" && /rejected promise/.test(r.message))
  );

  // ── A real render error ────────────────────────────────────────────────
  // This is the one that blanked the window: a component throws during render,
  // React unmounts the tree, and without a boundary the user sees nothing.
  await cdp.ev(`window.dispatchEvent(new Event("markie:crash-probe")), true`);
  await waitFor("crash screen", () => cdp.ev(bodyHas("Markie hit an error")), 10000);

  check("a render error shows a message instead of a blank window", true);
  check(
    "the crash screen says what happened to the user's work",
    await cdp.ev(bodyHas("files on disk are untouched"))
  );
  check("the crash screen offers a way back", await cdp.ev(bodyHas("Reload Markie")));
  check("the crash screen offers the details", await cdp.ev(bodyHas("Copy details")));
  check(
    "the crash screen is honest that nothing was sent anywhere",
    await cdp.ev(bodyHas("Nothing was sent anywhere"))
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(artifactDir, "crash-screen.png"), Buffer.from(shot.data, "base64"));

  const afterRender = JSON.parse((await cdp.ev(crashLog)) || "[]");
  const rendered = afterRender.find((r) => r.source === "render");
  check("the render error reached the crash log", !!rendered);
  check(
    "the report names the component that threw",
    !!rendered?.componentStack && /CrashProbe/.test(rendered.componentStack),
    rendered?.componentStack?.split("\n")[1]?.trim() ?? "no component stack"
  );
  check("the report carries a stack", !!rendered?.stack && rendered.stack.length > 0);
  check(
    "the report records the build it happened on",
    !!rendered?.version && !!rendered?.platform,
    `${rendered?.version} / ${rendered?.platform}`
  );
  check(
    "the crash log holds no document content",
    !/documentContent|\\"content\\":/.test(JSON.stringify(afterRender))
  );

  // ── Opt-in reporting ───────────────────────────────────────────────────
  // The whole privacy posture rests on the default. Everything above already
  // crashed the app several times; none of it may have left the machine.
  check(
    "nothing is sent anywhere while reporting is off",
    ingest.length === 0,
    `${ingest.length} request(s) to the ingest endpoint`
  );
  const consent = await cdp.ev(`window.electronAPI.crashConsentGet().then(JSON.stringify)`);
  check("reporting is off by default", JSON.parse(consent).enabled === false, consent);
  check("a configured build offers the setting", JSON.parse(consent).available === true);

  await cdp.ev(`window.electronAPI.crashConsentSet(true)`);
  const afterOptIn = await cdp.ev(`window.electronAPI.crashConsentGet().then(JSON.stringify)`);
  check("opting in persists", JSON.parse(afterOptIn).enabled === true);

  // Crash again, this time with the user's real home directory in the message,
  // which is what a filesystem error actually looks like.
  await cdp.ev(`window.dispatchEvent(new ErrorEvent("error", {
    error: new Error("ENOENT: " + ${JSON.stringify(process.env.HOME)} + "/Desktop/Q3 salary review.md"),
    message: "probe with a path" })), true`);
  await waitFor("upload", () => ingest.length > 0, 10000);

  check("an opted-in crash reaches the endpoint", ingest.length > 0);
  const sent = ingest[ingest.length - 1];
  check("it posts to the project's envelope route", sent.url === "/api/4242/envelope/", sent.url);
  check("it authenticates with the DSN public key", /sentry_key=testkey/.test(sent.auth ?? ""));

  check(
    "the user's home directory never leaves the machine",
    !sent.body.includes(process.env.HOME ?? "__no_home__"),
  );
  check(
    "the document's folder never leaves the machine",
    !sent.body.includes("Desktop"),
  );
  const event = JSON.parse(sent.body.trim().split("\n")[2]);
  check("the report names the build", !!event.release, `release=${event.release}`);
  check("the report carries frames Sentry can group on", Array.isArray(event.exception?.values?.[0]?.stacktrace?.frames));

  // And turning it back off must actually stop it.
  await cdp.ev(`window.electronAPI.crashConsentSet(false)`);
  const before = ingest.length;
  await cdp.ev(`window.dispatchEvent(new ErrorEvent("error", {
    error: new Error("probe: after opting out"), message: "after opting out" })), true`);
  await new Promise((r) => setTimeout(r, 1500));
  check("opting back out stops the sending", ingest.length === before, `${ingest.length - before} extra`);

  // ── Recovery ───────────────────────────────────────────────────────────
  await cdp.ev(clickReload());
  await waitFor("recovered", () => cdp.ev(bodyHas("markie")), 40000);
  check(
    "reloading from the crash screen brings the app back",
    !(await cdp.ev(bodyHas("Markie hit an error")))
  );

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

const clickReload = () => `(() => {
  const b = [...document.querySelectorAll('button')]
    .find((x) => x.textContent.trim() === "Reload Markie");
  if (!b) return false;
  b.click();
  return true;
})()`;

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stderr.write(`crash-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
