#!/usr/bin/env node
// Drives first run and the sign-in surfaces in a real window.
//
// Unit tests prove the pieces; this proves the app. It boots Markie against a
// throwaway user-data directory so "first run" is genuinely first, then asks
// the questions a new user's first two minutes actually answer: what do I see,
// what is Markie asking me for, and can I get out of the beta channel I just
// joined.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "onboarding-check");
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

// detached gives each child its own process group, so killing -pid takes the
// whole tree down with it rather than orphaning `next dev`.
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

// Click by visible text: these surfaces are prose and buttons, and asserting on
// the words the user reads is the point.
const clickText = (text, scope = "document") => `(() => {
  const el = [...${scope}.querySelectorAll('button, a')]
    .find((b) => b.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if (!el) return false;
  el.click();
  return true;
})()`;

const bodyHas = (text) =>
  `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

async function main() {
  // Evidence, not decoration: these surfaces are prose and layout, and a check
  // that only asserts strings cannot see a form that renders broken.
  const shoot = async (cdp, name) => {
    // Overlays fade and rise in over 160ms (markie-panel-in). Shooting straight
    // after the click catches a half-faded panel and libels it as a washed-out,
    // disabled-looking modal, so wait past the animation before believing the
    // pixels.
    await cdp.ev(`document.getAnimations().length`);
    await new Promise((r) => setTimeout(r, 450));
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  };

  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-onboarding-profile-"));
  tempPaths.push(userDataDir);

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start("npm", ["run", "dev", "--", "--port", String(devPort)], {
    log: path.join(artifactDir, "next.log"),
  });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  // No file argument: this is the cold Dock launch, the only one onboarding
  // is allowed to touch.
  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1" },
      log: path.join(artifactDir, "electron.log"),
    }
  );

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("first paint", () => cdp.ev(bodyHas("markie")), 40000);

  // ── First run ──────────────────────────────────────────────────────────
  check("first run opens the welcome document", await cdp.ev(bodyHas("Welcome to Markie")));
  check(
    "the welcome document states the local-first promise",
    await cdp.ev(bodyHas("do not need an account"))
  );
  check(
    "first run never shows the old fictional sprint brief",
    !(await cdp.ev(bodyHas("Northstar Sprint Brief")))
  );
  check(
    "first run does not demand an account",
    !(await cdp.ev(bodyHas("sign in to continue")))
  );
  check(
    "the welcome document renders a real table",
    await cdp.ev("!!document.querySelector('.markdown-body table')")
  );
  check(
    "the welcome document renders highlighted code",
    await cdp.ev("!!document.querySelector('.markdown-body pre')")
  );
  check(
    "the welcome document renders real checkboxes",
    await cdp.ev("document.querySelectorAll('.markdown-body input[type=checkbox]').length >= 2")
  );

  await shoot(cdp, "01-first-run");

  // The rail is the one always-visible auth affordance, and it must read as an
  // offer rather than a demand.
  check(
    "the activity bar offers sign-in without insisting",
    await cdp.ev(`!!document.querySelector('[aria-label="Sign in"]')`)
  );

  // ── The sign-in surface ────────────────────────────────────────────────
  await cdp.ev(`document.querySelector('[aria-label="Sign in"]').click(), true`);
  await waitFor("settings", () => cdp.ev(bodyHas("Settings")), 10000);
  await waitFor("sign-in form", () => cdp.ev(bodyHas("Sign in to Markie")), 10000);

  check(
    "signing in says what it is for",
    await cdp.ev(bodyHas("syncing and sharing across your devices"))
  );
  check(
    "the sign-in surface repeats the local-first promise",
    await cdp.ev(bodyHas("stay on this Mac"))
  );
  check("Google is offered first", await cdp.ev(bodyHas("Continue with Google")));
  check("an emailed code is offered", await cdp.ev(bodyHas("Email me a code")));
  check(
    "a code is enough to make an account",
    await cdp.ev(bodyHas("No account yet? A code makes one."))
  );
  check(
    "Google sits above the email code in the form",
    await cdp.ev(`(() => {
      const t = document.body.innerText;
      return t.indexOf("Continue with Google") < t.indexOf("Email me a code");
    })()`)
  );
  check("password is demoted to a link", await cdp.ev(bodyHas("Use a password instead")));
  await shoot(cdp, "02-sign-in");

  // ── Forgot password ────────────────────────────────────────────────────
  check("the password form is reachable", await cdp.ev(clickText("Use a password instead")));
  await waitFor("password view", () => cdp.ev(bodyHas("Forgot?")), 10000);
  check("a forgotten password has a way out", await cdp.ev(bodyHas("Forgot?")));
  check("the reset flow opens", await cdp.ev(clickText("Forgot?")));
  await waitFor("reset view", () => cdp.ev(bodyHas("Send reset code")), 10000);
  check(
    "reset is done by code, with no hosted page to visit",
    await cdp.ev(bodyHas("email you a code to set a new password"))
  );

  // ── Beta channel ───────────────────────────────────────────────────────
  check("Advanced settings open", await cdp.ev(clickText("Advanced")));
  await waitFor("advanced", () => cdp.ev(bodyHas("Receive beta updates")), 10000);
  check("the beta channel is offered inside the app", await cdp.ev(bodyHas("Receive beta updates")));
  await shoot(cdp, "03-beta-channel");
  check(
    "leaving beta is described before joining it",
    await cdp.ev(bodyHas("moves you back to the current stable build"))
  );

  const betaBefore = await cdp.ev("window.electronAPI.updateChannelGet().then((s) => s.optedIn)");
  check("beta is off unless asked for", betaBefore === false, `optedIn=${betaBefore}`);

  await cdp.ev("window.electronAPI.updateChannelSet(true)");
  const betaAfter = await cdp.ev("window.electronAPI.updateChannelGet().then((s) => s.optedIn)");
  check("opting in persists", betaAfter === true, `optedIn=${betaAfter}`);

  await cdp.ev("window.electronAPI.updateChannelSet(false)");
  const betaOut = await cdp.ev("window.electronAPI.updateChannelGet().then((s) => s.optedIn)");
  check("opting back out persists", betaOut === false, `optedIn=${betaOut}`);

  // ── Second run ─────────────────────────────────────────────────────────
  // Same origin and same user-data directory, so the seen flag is the real one.
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("reboot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("second paint", () => cdp.ev(bodyHas("markie")), 40000);
  check(
    "the welcome document does not return on the next launch",
    !(await cdp.ev(bodyHas("Welcome to Markie")))
  );

  await shoot(cdp, "04-second-run");

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  }
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stderr.write(`onboarding-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
