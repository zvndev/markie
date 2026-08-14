#!/usr/bin/env node
// End-to-end check for find and replace, in a real Electron window.
//
// The unit tests cover the arithmetic — which characters matched, and which
// editor positions they map to. What they cannot cover is the part the user
// actually complained about: ⌘F did nothing in the pane Markie opens in. That
// is a wiring question, and it only has an answer with a real key event, a real
// editor and a real document on screen.
//
//   node scripts/find-check.mjs
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `find-check-${stamp}`);
const children = [];
const tempPaths = [];
let debugOrigin = "http://127.0.0.1:9222";

await mkdir(artifactDir, { recursive: true });
const logPath = (name) => path.join(artifactDir, `${name}.log`);

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
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
  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`
  );
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
  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools://")
  );
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
        else if (msg.result?.exceptionDetails)
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    )?.result?.value;
  return { send, ev, close: () => ws.close() };
}

// CDP modifier bits.
const ALT = 1;
const META = 4;
const SHIFT = 8;

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function keyboard(cdp) {
  // Real key events rather than calling handlers directly. Dispatching the
  // shortcut is the only way to prove the app is listening for it at all,
  // which is precisely what was missing before.
  const press = async (key, code, keyCode, modifiers = 0, pause = 120) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    if (pause) await settle(pause);
  };

  const type = async (text) => {
    for (const ch of text) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: ch,
        unmodifiedText: ch,
        key: ch,
      });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
    await settle(200);
  };

  return {
    press,
    type,
    backspace: () => press("Backspace", "Backspace", 8, 0, 0),
    findShortcut: (withReplace = false) =>
      press("f", "KeyF", 70, META | (withReplace ? ALT : 0)),
    enter: (back = false) => press("Enter", "Enter", 13, back ? SHIFT : 0),
    escape: () => press("Escape", "Escape", 27),
    mode: (n) => press(String(n), `Digit${n}`, 48 + n, META),
  };
}

const q = (s) => JSON.stringify(s);

// The document is built so that the two panes legitimately see different text:
// "A **quick** brown fox" is one phrase on screen and three tokens in markdown.
const DOC = `# Find me

The quick brown fox jumps over the lazy dog.

A **quick** brown fox returns.

Nothing else here.
`;

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "markie-find-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-find-profile-"));
  tempPaths.push(workDir, userDataDir);

  const docPath = path.join(await realpath(workDir), "find-me.md");
  await writeFile(docPath, DOC, "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start("npm", ["run", "dev", "--", "--port", String(devPort)], {
    log: logPath("next"),
  });
  await waitFor(
    "Next dev renderer",
    async () => !!(await fetch(devOrigin).catch(() => null)),
    90000
  );

  const electronBin = path.join(root, "node_modules", ".bin", "electron");
  start(
    electronBin,
    [
      ".",
      docPath,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
    ],
    {
      env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1" },
      log: logPath("electron"),
    }
  );

  const cdp = await waitFor("Electron CDP target", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor(
    "renderer boot",
    () => cdp.ev("document.readyState === 'complete' && !!document.body"),
    40000
  );
  await waitFor("preload", () => cdp.ev("!!window.electronAPI"), 30000);
  await waitFor("editor boot", () => cdp.ev("!!window.__markieEditor"), 40000);
  await waitFor(
    "document loaded",
    () => cdp.ev(`window.__markieEditor.getText().includes("lazy dog")`),
    30000
  );

  const kb = keyboard(cdp);
  const barOpen = () => cdp.ev("!!document.querySelector('[data-markie-find-bar]')");
  const hits = () => cdp.ev("document.querySelectorAll('.markie-find-hit').length");
  const current = () =>
    cdp.ev("document.querySelectorAll('.markie-find-hit--current').length");
  const label = () =>
    cdp.ev(
      "document.querySelector('[data-markie-find-bar] [aria-live]')?.textContent ?? ''"
    );
  const docText = () => cdp.ev("window.__markieEditor.getText()");
  const field = (name) =>
    `document.querySelector('[data-markie-find-bar] input[aria-label=${q(name)}]')`;
  const fieldValue = (name) => cdp.ev(`${field(name)}?.value ?? null`);

  // Types into one of the bar's inputs for real, having emptied it a keystroke
  // at a time, and then checks the field actually holds what was typed.
  //
  // An earlier version of this harness cleared with ⌘A. The select-all never
  // took, so every query was appended to the last one, and five checks failed
  // for a reason that had nothing to do with the feature. A harness that lies
  // about its own input is worse than no harness, so it asserts.
  const setField = async (name, text) => {
    await cdp.ev(`${field(name)}?.focus(), true`);
    const existing = (await fieldValue(name)) ?? "";
    for (let i = 0; i < existing.length; i += 1) await kb.backspace();
    await settle(150);
    const emptied = await fieldValue(name);
    if (emptied !== "") {
      throw new Error(`could not clear ${name}: still holds ${q(emptied)}`);
    }
    await kb.type(text);
    const got = await fieldValue(name);
    if (got !== text) {
      throw new Error(`typed ${q(text)} into ${name}, field holds ${q(got)}`);
    }
  };

  check(
    "the app starts in Rich, which is where ⌘F did nothing",
    await cdp.ev("!!document.querySelector('[data-markie-rich-pane]')")
  );
  check("the find bar is not open unasked", !(await barOpen()));

  // --- Rich pane -----------------------------------------------------------
  await kb.findShortcut();
  check("⌘F opens the find bar in the Rich pane", await barOpen());

  await setField("Find", "quick");
  const quickHits = await hits();
  check(
    "typing highlights every match in the rendered document",
    quickHits === 2,
    `highlighted ${quickHits}, expected 2`
  );
  check("exactly one match is marked current", (await current()) === 1);
  check(
    "the count says where you are",
    (await label()) === "1 of 2",
    `label was ${q(await label())}`
  );

  await kb.enter();
  check("Enter steps to the next match", (await label()) === "2 of 2");
  await kb.enter();
  check("Enter wraps back to the first", (await label()) === "1 of 2");
  await kb.enter(true);
  check("Shift-Enter steps backwards", (await label()) === "2 of 2");

  // The reason the rich pane needed its own implementation: "quick brown"
  // is one phrase on screen but two text nodes in the document, because
  // **quick** is bold. Anything searching a formatting run at a time finds
  // only the first occurrence.
  await setField("Find", "quick brown");
  const spanningLabel = await label();
  const spanTexts = await cdp.ev(
    "[...document.querySelectorAll('.markie-find-hit')].map(e => e.textContent)"
  );
  check(
    "a phrase that spans bold formatting is found",
    spanningLabel.endsWith("of 2") &&
      spanTexts.join("") === "quick brownquick brown",
    `${q(spanningLabel)}, highlighted ${JSON.stringify(spanTexts)}`
  );
  // Three highlight spans for two matches, because the second one is drawn in
  // two pieces: "quick" is bold and " brown" is not. That is the fingerprint
  // of the match genuinely crossing the boundary — a search that worked one
  // formatting run at a time would report one match in one span.
  check(
    "the crossing match is highlighted through the formatting change",
    spanTexts.length === 3,
    `${spanTexts.length} spans for 2 matches`
  );

  // The other half of the same claim: the rich pane searches what is on
  // screen, so the markdown that produced it is not there to be found.
  await setField("Find", "# Find");
  const hashInRich = await hits();
  check(
    "the rich pane does not match markdown you cannot see",
    hashInRich === 0,
    `"# Find" highlighted ${hashInRich} times in the rendered document`
  );
  await setField("Find", "quick brown");

  // --- Replace -------------------------------------------------------------
  await kb.findShortcut(true);
  check(
    "⌥⌘F opens the replace field",
    await cdp.ev(
      "!!document.querySelector('[data-markie-find-bar] input[aria-label=\"Replace with\"]')"
    )
  );
  await setField("Replace with", "slow green");

  const buttons = (name) =>
    cdp.ev(
      `[...document.querySelectorAll('[data-markie-find-bar] button')].find(b => b.textContent.trim() === ${q(name)})?.click(), true`
    );

  await buttons("Replace");
  await settle(400);
  const afterOne = await docText();
  check(
    "Replace rewrites one match and leaves the other",
    afterOne.includes("slow green") &&
      afterOne.match(/quick brown/g)?.length === 1,
    afterOne.replace(/\n+/g, " / ")
  );

  await buttons("All");
  await settle(400);
  const afterAll = await docText();
  check(
    "Replace All rewrites the rest",
    !afterAll.includes("quick brown") &&
      afterAll.match(/slow green/g)?.length === 2,
    afterAll.replace(/\n+/g, " / ")
  );

  await kb.escape();
  check("Escape closes the bar", !(await barOpen()));
  check(
    "closing clears the highlights",
    (await hits()) === 0,
    `${await hits()} left behind`
  );

  // --- Source pane ---------------------------------------------------------
  await kb.mode(2);
  await settle(600);
  await kb.findShortcut();
  check("⌘F opens the same bar in the Source pane", await barOpen());
  check(
    "CodeMirror's own search panel stays shut",
    !(await cdp.ev("!!document.querySelector('.cm-search, .cm-panel')")),
    "two search boxes at once is the bug this replaces"
  );

  await setField("Find", "slow green");
  const sourceHits = await hits();
  check(
    "the source pane finds what was just replaced",
    sourceHits === 2,
    `highlighted ${sourceHits}`
  );

  // The mirror of the rich-pane check above. "# Find" is markdown: it is real
  // text here and does not exist at all in the rendered document.
  await setField("Find", "# Find");
  const hashInSource = await hits();
  check(
    "the source pane searches the markdown, not the rendered text",
    hashInSource === 1,
    `the heading marker matched ${hashInSource} times, expected 1`
  );

  await kb.escape();
  check("Escape closes the bar in the source pane too", !(await barOpen()));

  // The menu is the other way in, and it carries the accelerator.
  check(
    "the preload bridge exposes the Find menu subscriptions",
    (await cdp.ev("typeof window.electronAPI.onMenuFind")) === "function" &&
      (await cdp.ev("typeof window.electronAPI.onMenuFindReplace")) ===
        "function"
  );

  cdp.close();
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nfatal: ${error.message}`);
} finally {
  await stopChildren();
  await Promise.all(
    tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {}))
  );
}

const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
console.log(`logs: ${artifactDir}`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
