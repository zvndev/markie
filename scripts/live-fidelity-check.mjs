#!/usr/bin/env node
// Two accounts edit one document live in the web app, in two real browsers,
// against a throwaway local server; the check reads the stored copy back.
//
//   1. Fidelity. The document has KaTeX inline and display math (with `\,`),
//      a right-aligned table column and a closing newline. Bob types one word.
//      The stored copy must be the original with that word added and every
//      other byte untouched. Before the fix it came back with `\\pi`, a
//      one-line display block without its `\,`, a re-padded table without
//      its alignment, and no closing newline.
//   2. Restart. Alice leaves; Bob types again and the server is stopped with
//      SIGTERM before anyone pushes (a deploy). Bob leaves. With the server
//      back, Alice opens the document: there must be no "someone saved this
//      outside the live session" conflict, and her tab pushes the room,
//      Bob's last word included.
//   3. The editor data model. A document with front matter, a multi-line
//      display formula and an aligned table. The live pane must not show the
//      front matter (no rule, no `title:` heading) and must draw the math with
//      KaTeX. Bob types into the table and edits the formula through its
//      source field; the stored copy must be the original with exactly those
//      edits: the front matter once, the formula's lines kept, every column's
//      alignment kept.
//   4. Old builds. A ticket request that says nothing about schemas (0.9.4's)
//      is refused for a room holding a formula, and a socket on the account's
//      token is shown out with 4403 before it is sent anything.
//   5. The room of a document with front matter keeps old builds out too
//      (0.9.4 would write its file without the YAML); a plain document's room
//      stays open to them.
//
// Needs Google Chrome and the web build: `npm run build:web` first.
// Usage: node scripts/live-fidelity-check.mjs [evidence-dir]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const serverDir = path.join(root, "server");
const require = createRequire(path.join(serverDir, "package.json"));
const WebSocket = require("ws");
const Database = require("better-sqlite3");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const stampDir = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const evidence = path.resolve(process.argv[2] || path.join(root, ".autoloop", "runs", `live-fixes-${stampDir}`, "e2e"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (line) => { console.log(line); log.push(line); };

const EVERYTHING = [
  "# Everything",
  "",
  "Inline math $e^{i\\pi} + 1 = 0$ in a sentence.",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "| Item | Price |",
  "| :--- | ---: |",
  "| Tea | 3 |",
  "| Cake | 12 |",
  "",
  "Last line.",
  "",
].join("\n");

const MODEL_FRONT = "---\ntitle: Model\nmarkie:\n  project: Fidelity\n---\n";
const MODEL_FORMULA = "$$\n\\int_0^1 x^2\n  \\, dx = \\frac{1}{3}\n$$";
const MODEL = [
  MODEL_FRONT + "# Model",
  "",
  "Inline $e^{i\\pi}$ here.",
  "",
  MODEL_FORMULA,
  "",
  "| Item | Price | Note |",
  "| :--- | :---: | ---: |",
  "| Tea | 3 | hot |",
  "",
  "Last line.",
  "",
].join("\n");

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function poll(label, fn, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(200);
  }
}

// ── the server ──────────────────────────────────────────────────────────────
const children = [];
let serverOutput = "";
function serverEnv(port, dbPath) {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "development",
    PORT: String(port),
    DB_PATH: dbPath,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    BETTER_AUTH_SECRET: "markie-live-fidelity-check-secret-32-plus",
    MARKIE_MAIL_LOG: "1",
    ENABLE_CRONS: "false",
  };
}
async function startServer(port, dbPath) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], { cwd: serverDir, env: serverEnv(port, dbPath), stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (c) => { output += c; serverOutput += c; });
  child.stderr.on("data", (c) => { output += c; serverOutput += c; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  await poll("server start", () => output.includes("markie-api listening") || child.exitCode !== null);
  if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
  return { child, exited };
}

// ── Chrome over the DevTools protocol ───────────────────────────────────────
async function launchChrome(name) {
  const port = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), `markie-live-${name}-`));
  const child = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  children.push(child);
  await poll(`chrome ${name}`, async () => (await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null))?.ok);
  return { port, child };
}

async function openPage(chrome, url) {
  const target = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let next = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    return result.result.value;
  };
  return {
    id: target.id,
    send,
    evaluate,
    navigate: (to) => send("Page.navigate", { url: to }),
    shot: async (file) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(evidence, file), Buffer.from(data, "base64"));
    },
    close: async () => {
      await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
      ws.terminate();
    },
  };
}

// ── the run ─────────────────────────────────────────────────────────────────
const failures = [];
const check = (label, ok, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

try {
  if (!existsSync(path.join(serverDir, "web-dist", "app.html"))) throw new Error("No web build: run `npm run build:web` first.");
  await mkdir(path.join(evidence, "exports"), { recursive: true });
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dbDir = await mkdtemp(path.join(tmpdir(), "markie-live-fidelity-"));
  const dbPath = path.join(dbDir, "markie.db");
  const migrated = spawnSync(process.execPath, ["--experimental-strip-types", "src/migrate.ts"], { cwd: serverDir, env: serverEnv(port, dbPath), encoding: "utf8" });
  if (migrated.status !== 0) throw new Error(`migrate failed:\n${migrated.stdout}${migrated.stderr}`);
  let server = await startServer(port, dbPath);
  say(`server: ${base} (DB ${dbPath})`);

  const stamp = Date.now();
  const password = "password-123";
  const accounts = {};
  for (const name of ["alice", "bob"]) {
    const email = `${name}.${stamp}@test.local`;
    const res = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "x-forwarded-for": `10.77.0.${name === "alice" ? 1 : 2}` },
      body: JSON.stringify({ name: name[0].toUpperCase() + name.slice(1), email, password }),
    });
    if (!res.ok) throw new Error(`sign-up ${email}: ${res.status} ${await res.text()}`);
    // Stands in for the emailed code (printed to the server log): the
    // address is proved the same way the server's own suites prove it.
    const db = new Database(dbPath);
    db.prepare("UPDATE user SET emailVerified = 1 WHERE email = ?").run(email);
    db.close();
    const signedIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "x-forwarded-for": `10.77.1.${name === "alice" ? 1 : 2}` },
      body: JSON.stringify({ email, password }),
    });
    accounts[name] = { email, token: signedIn.headers.get("set-auth-token") };
    if (!accounts[name].token) throw new Error(`no token for ${email}`);
  }
  const authed = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: base });
  const docId = `fidelity-${stamp}`;
  const put = await fetch(`${base}/api/docs/${docId}`, {
    method: "PUT",
    headers: authed(accounts.alice.token),
    body: JSON.stringify({ name: "Everything.md", content: EVERYTHING, hash: createHash("sha256").update(EVERYTHING, "utf8").digest("hex"), baseVersion: 0 }),
  });
  if (!put.ok) throw new Error(`create doc: ${put.status} ${await put.text()}`);
  const shared = await fetch(`${base}/api/docs/${docId}/shares`, { method: "POST", headers: authed(accounts.alice.token), body: JSON.stringify({ email: accounts.bob.email, role: "editor" }) });
  if (!shared.ok) throw new Error(`share: ${shared.status} ${await shared.text()}`);
  await writeFile(path.join(evidence, "exports", "stored-v1.md"), EVERYTHING);
  const stored = async () => {
    const res = await fetch(`${base}/api/docs/${docId}`, { headers: authed(accounts.alice.token) });
    if (!res.ok) return null;
    return (await res.json()).doc;
  };

  const chromes = { alice: await launchChrome("alice"), bob: await launchChrome("bob") };
  async function signedInPage(name) {
    const page = await openPage(chromes[name], `${base}/app`);
    await poll(`${name} page loaded`, () => page.evaluate(`location.origin === ${JSON.stringify(base)} && document.readyState === 'complete'`).catch(() => false));
    const status = await page.evaluate(`fetch('/api/auth/sign-in/email', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ email: accounts[name].email, password })}) }).then((r) => r.status)`);
    if (status !== 200) throw new Error(`${name} browser sign-in: ${status}`);
    return page;
  }
  async function openLive(page, name) {
    await page.navigate(`${base}/app/d/${docId}`);
    await poll(`${name} live and editable`, () => page.evaluate("!!(window.__markieCollab && window.__markieEditor && window.__markieEditor.isEditable)").catch(() => false), 30_000);
  }
  const bodyText = (page) => page.evaluate("document.body.innerText");
  const DIVERGED = "someone saved this document outside the live session";
  // Typed as a keyboard would, at the end of the document, then confirmed in
  // the editor: a headless window can miss focus, and a word that never
  // landed would make every later check about nothing.
  async function typeAtEnd(page, text) {
    await page.send("Page.bringToFront");
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.evaluate("window.__markieEditor.commands.focus('end')");
    await page.send("Input.insertText", { text });
    const landed = () => page.evaluate(`window.__markieEditor.getText().endsWith(${JSON.stringify(text)})`);
    const typed = await poll(`"${text}" in the editor`, landed, 2000).catch(() => false);
    if (typed) return;
    // A background headless window sometimes drops the key events. The same
    // edit as one editor transaction, which is what typing makes anyway.
    say(`  (keyboard input did not reach the window; "${text}" inserted as an editor transaction)`);
    await page.evaluate(`window.__markieEditor.chain().focus('end').insertContent({ type: 'text', text: ${JSON.stringify(text)} }).run()`);
    await poll(`"${text}" in the editor`, landed, 3000);
  }
  const diagnose = async (page, name) => {
    const info = await page.evaluate(`JSON.stringify({ text: window.__markieEditor && window.__markieEditor.getText().slice(-60), status: [...document.querySelectorAll('[role=status],[role=alert]')].map((e) => e.innerText) })`).catch((e) => String(e));
    say(`  ${name}: ${info}`);
    await page.shot(`diagnose-${name}.png`).catch(() => {});
  };

  // ── 1. fidelity through one live edit ──
  const alice = await signedInPage("alice");
  const bob = await signedInPage("bob");
  await openLive(alice, "alice");
  await openLive(bob, "bob");
  await sleep(1500);
  await alice.shot("1-alice-live.png");
  await bob.shot("1-bob-live.png");
  await typeAtEnd(bob, " Bob");
  const afterBob = await poll("stored copy updated after Bob's word", async () => {
    const doc = await stored();
    return doc && doc.version > 1 ? doc : null;
  }).catch(async (error) => {
    await diagnose(alice, "alice");
    await diagnose(bob, "bob");
    throw error;
  });
  await writeFile(path.join(evidence, "exports", "roundtrip-live.md"), afterBob.content);
  const expected1 = EVERYTHING.replace("Last line.", "Last line. Bob");
  await writeFile(path.join(evidence, "exports", "expected-live.md"), expected1);
  check("stored copy after one live word is the original plus that word, byte for byte", afterBob.content === expected1,
    afterBob.content === expected1 ? "" : JSON.stringify(afterBob.content));
  check("inline math kept: $e^{i\\pi}$, not $e^{i\\\\pi}$", afterBob.content.includes("$e^{i\\pi} + 1 = 0$"));
  check("display math kept on its own lines with \\,", afterBob.content.includes("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$"));
  check("table alignment row kept", afterBob.content.includes("| :--- | ---: |"));
  check("closing newline kept", afterBob.content.endsWith("\n"));
  await bob.shot("2-bob-after-word.png");
  await alice.shot("2-alice-after-word.png");
  check("no conflict shown to Alice or Bob", !(await bodyText(alice)).includes(DIVERGED) && !(await bodyText(bob)).includes(DIVERGED));

  // ── 2. a restart between a live edit and its push ──
  await alice.close();
  await sleep(500);
  const before = await stored();
  await typeAtEnd(bob, " again");
  await sleep(150); // the update is on the socket; the push waits 1.5 s
  server.child.kill("SIGTERM");
  const code = await server.exited;
  say(`server stopped with SIGTERM (exit ${code}) 150 ms after Bob's second word`);
  await sleep(2500);
  await bob.shot("3-bob-server-down.png");
  await bob.close();
  server = await startServer(port, dbPath);
  const afterRestart = await stored();
  check("the stored copy was not pushed before the restart (the case under test)", afterRestart.version === before.version && !afterRestart.content.includes("again"),
    `version ${before.version} -> ${afterRestart.version}`);
  const alice2 = await signedInPage("alice");
  await openLive(alice2, "alice (after restart)");
  const pushed = await poll("Alice's tab pushes the room after the restart", async () => {
    const doc = await stored();
    return doc && doc.content.includes("again") ? doc : null;
  }, 30_000).catch(() => null);
  await alice2.shot("4-alice-after-restart.png");
  const text = await bodyText(alice2);
  check("no false conflict after the restart", !text.includes(DIVERGED));
  const expected2 = EVERYTHING.replace("Last line.", "Last line. Bob again");
  await writeFile(path.join(evidence, "exports", "after-restart.md"), pushed?.content ?? "(never pushed)");
  check("the room's edit reached the stored copy after the restart, byte for byte", pushed?.content === expected2,
    pushed ? (pushed.content === expected2 ? `version ${pushed.version}` : JSON.stringify(pushed.content)) : "never pushed");
  await alice2.close();

  // ── 3. the editor data model: front matter, a multi-line formula and an aligned table, edited live ──
  const modelId = `model-${stamp}`;
  const madeModel = await fetch(`${base}/api/docs/${modelId}`, {
    method: "PUT",
    headers: authed(accounts.alice.token),
    body: JSON.stringify({ name: "Model.md", content: MODEL, hash: createHash("sha256").update(MODEL, "utf8").digest("hex"), baseVersion: 0 }),
  });
  if (!madeModel.ok) throw new Error(`create model doc: ${madeModel.status} ${await madeModel.text()}`);
  const sharedModel = await fetch(`${base}/api/docs/${modelId}/shares`, { method: "POST", headers: authed(accounts.alice.token), body: JSON.stringify({ email: accounts.bob.email, role: "editor" }) });
  if (!sharedModel.ok) throw new Error(`share model: ${sharedModel.status}`);
  await writeFile(path.join(evidence, "exports", "model-stored-v1.md"), MODEL);
  const storedModel = async () => {
    const res = await fetch(`${base}/api/docs/${modelId}`, { headers: authed(accounts.alice.token) });
    return res.ok ? (await res.json()).doc : null;
  };
  const alice3 = await signedInPage("alice");
  const bob3 = await signedInPage("bob");
  for (const [page, name] of [[alice3, "alice"], [bob3, "bob"]]) {
    await page.navigate(`${base}/app/d/${modelId}`);
    await poll(`${name} live on the model doc`, () => page.evaluate("!!(window.__markieCollab && window.__markieEditor && window.__markieEditor.isEditable)").catch(() => false), 30_000);
  }
  await poll("formulas drawn by KaTeX in Bob's pane", () => bob3.evaluate("document.querySelectorAll('.ProseMirror .markie-math .katex').length >= 2"), 10_000).catch(() => false);
  await sleep(800);
  await alice3.shot("5-alice-model-live.png");
  await bob3.shot("5-bob-model-live.png");
  const shown = await bob3.evaluate(`JSON.stringify({
    first: document.querySelector('.ProseMirror')?.firstElementChild?.tagName,
    rules: document.querySelectorAll('.ProseMirror hr').length,
    text: document.querySelector('.ProseMirror')?.innerText ?? '',
    katex: document.querySelectorAll('.ProseMirror .markie-math .katex').length,
    displayKatex: document.querySelectorAll('.ProseMirror .markie-math-block .katex-display').length,
    rawDollars: (document.querySelector('.ProseMirror')?.innerText ?? '').includes('$'),
    aligned: [...document.querySelectorAll('.ProseMirror th')].map((th) => th.style.textAlign),
  })`).then(JSON.parse);
  await writeFile(path.join(evidence, "exports", "model-bob-pane.json"), JSON.stringify(shown, null, 2));
  check("front matter is not shown in the live pane: no rule, no `title:` heading", shown.first === "H1" && shown.rules === 0 && !shown.text.includes("title: Model") && !shown.text.includes("project"), JSON.stringify({ first: shown.first, rules: shown.rules }));
  check("math is drawn by KaTeX in the live rich pane, not as raw `$…$`", shown.katex >= 2 && shown.displayKatex === 1 && !shown.rawDollars, JSON.stringify({ katex: shown.katex, displayKatex: shown.displayKatex, rawDollars: shown.rawDollars }));
  check("the table's columns are drawn aligned", JSON.stringify(shown.aligned) === JSON.stringify(["left", "center", "right"]), JSON.stringify(shown.aligned));

  // Bob types into the table, as a keyboard would.
  await bob3.send("Page.bringToFront");
  await bob3.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await bob3.evaluate(`(() => { const ed = window.__markieEditor; let at = -1; ed.state.doc.descendants((n, p) => { if (at === -1 && n.isText && n.text === 'Tea') at = p + n.nodeSize; }); ed.chain().focus().setTextSelection(at).run(); })()`);
  await bob3.send("Input.insertText", { text: " (green)" });
  const cellTyped = await poll("Bob's word in the table", () => bob3.evaluate("window.__markieEditor.getText().includes('Tea (green)')"), 2000).catch(() => false);
  if (!cellTyped) {
    say('  (keyboard input did not reach the window; " (green)" inserted as an editor transaction)');
    await bob3.evaluate(`(() => { const ed = window.__markieEditor; let at = -1; ed.state.doc.descendants((n, p) => { if (at === -1 && n.isText && n.text === 'Tea') at = p + n.nodeSize; }); ed.chain().insertContentAt(at, ' (green)').run(); })()`);
  }

  // Bob clicks the display formula, which opens its source, and adds to it.
  await bob3.evaluate("document.querySelector('.ProseMirror .markie-math-block').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))");
  const opened = await poll("the formula's source field", () => bob3.evaluate("!!document.querySelector('.ProseMirror .markie-math-block textarea.markie-math-field')"), 3000).catch(() => false);
  check("a click on a display formula opens its source", !!opened);
  const fieldValue = await bob3.evaluate("document.querySelector('.ProseMirror .markie-math-block textarea')?.value ?? ''");
  check("the source field holds the formula's lines exactly", fieldValue === MODEL_FORMULA, JSON.stringify(fieldValue));
  await bob3.evaluate(`(() => { const t = document.querySelector('.ProseMirror .markie-math-block textarea'); t.focus(); const at = t.value.indexOf('\\\\frac{1}{3}') + '\\\\frac{1}{3}'.length; t.setSelectionRange(at, at); })()`);
  await bob3.send("Input.insertText", { text: " + C" });
  const fieldTyped = await bob3.evaluate("document.querySelector('.ProseMirror .markie-math-block textarea')?.value.includes('+ C')");
  if (!fieldTyped) {
    say('  (keyboard input did not reach the field; " + C" set on the field as typing would)');
    await bob3.evaluate(`(() => { const t = document.querySelector('.ProseMirror .markie-math-block textarea'); const at = t.value.indexOf('\\\\frac{1}{3}') + '\\\\frac{1}{3}'.length; t.value = t.value.slice(0, at) + ' + C' + t.value.slice(at); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  await bob3.shot("6-bob-editing-formula-source.png");
  // Cmd+Enter keeps the change.
  await bob3.evaluate("document.querySelector('.ProseMirror .markie-math-block textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))");
  const expectedModel = MODEL
    .replace("\\frac{1}{3}\n$$", () => "\\frac{1}{3} + C\n$$")
    .replace("| Item | Price | Note |\n| :--- | :---: | ---: |\n| Tea | 3 | hot |\n", () => "| Item        | Price | Note |\n| :---------- | :---: | ---: |\n| Tea (green) | 3     | hot  |\n");
  await writeFile(path.join(evidence, "exports", "model-expected.md"), expectedModel);
  const modelAfter = await poll("the model doc's stored copy has both edits", async () => {
    const doc = await storedModel();
    return doc && doc.content.includes("+ C") && doc.content.includes("(green)") ? doc : null;
  }, 20_000).catch(() => null);
  await writeFile(path.join(evidence, "exports", "model-roundtrip-live.md"), modelAfter?.content ?? "(never pushed)");
  check("stored copy after the table and formula edits is the original plus those edits, byte for byte", modelAfter?.content === expectedModel,
    modelAfter ? (modelAfter.content === expectedModel ? `version ${modelAfter.version}` : JSON.stringify(modelAfter.content)) : "never pushed");
  check("front matter written back once, unchanged", !!modelAfter && modelAfter.content.startsWith(MODEL_FRONT) && modelAfter.content.indexOf("title: Model") === modelAfter.content.lastIndexOf("title: Model"));
  check("the multi-line formula keeps its line breaks", !!modelAfter && modelAfter.content.includes("$$\n\\int_0^1 x^2\n  \\, dx = \\frac{1}{3} + C\n$$"));
  check("the edited table keeps every column's alignment", !!modelAfter && modelAfter.content.includes("| :---------- | :---: | ---: |"));
  await poll("Alice sees Bob's formula", () => alice3.evaluate("[...document.querySelectorAll('.ProseMirror .markie-math-block')].some((el) => (el.getAttribute('data-source') || '').includes('+ C'))"), 5000).catch(() => false);
  await sleep(500);
  await alice3.shot("7-alice-after-model-edits.png");
  await bob3.shot("7-bob-after-model-edits.png");
  check("no conflict shown on the model doc", !(await bodyText(alice3)).includes(DIVERGED) && !(await bodyText(bob3)).includes(DIVERGED));

  // ── 4. a build from before math nodes is kept out of these rooms ──
  // Its ticket request says nothing about schemas, as 0.9.4's does.
  for (const [label, id] of [["the model doc", modelId], ["the first doc", docId]]) {
    const res = await fetch(`${base}/api/docs/${id}/collab-ticket`, { method: "POST", headers: authed(accounts.bob.token), body: "{}" });
    const answer = await res.json().catch(() => null);
    check(`an old build's ticket request for ${label} (a room with formulas) is refused, so it opens its own copy`, res.status === 409 && answer?.error === "room_needs_newer_markie", `${res.status} ${JSON.stringify(answer)}`);
  }
  const newTicket = await fetch(`${base}/api/docs/${modelId}/collab-ticket`, { method: "POST", headers: authed(accounts.bob.token), body: JSON.stringify({ schema: 2 }) });
  check("this build's ticket request for the same room is answered", newTicket.status === 200);
  // A build from before tickets, on its token.
  const legacyClose = await new Promise((resolve) => {
    const sock = new WebSocket(`ws://localhost:${port}/collab/${modelId}?token=${encodeURIComponent(accounts.bob.token)}`);
    const timer = setTimeout(() => { sock.terminate(); resolve("still open"); }, 5000);
    let got = 0;
    sock.on("message", () => { got += 1; });
    sock.on("close", (code) => { clearTimeout(timer); resolve({ code, messages: got }); });
    sock.on("error", () => {});
  });
  check("an old build on its token is shown out (4403) without being sent the room", typeof legacyClose === "object" && legacyClose.code === 4403 && legacyClose.messages === 0, JSON.stringify(legacyClose));

  // ── 5. which plain rooms stay open to old builds ──
  // A document with front matter and no formulas: its room holds only the
  // body, which 0.9.4's desktop would write over its file without the YAML.
  // A document with neither: open to every build.
  const docsFor5 = [
    ["notes", "Notes.md", "---\ntitle: Notes\n---\n# Notes\n\nNo formulas here.\n"],
    ["plain", "Plain.md", "# Plain\n\nNo formulas, no front matter.\n"],
  ];
  for (const [slug, name, content] of docsFor5) {
    const id = `${slug}-${stamp}`;
    const made = await fetch(`${base}/api/docs/${id}`, { method: "PUT", headers: authed(accounts.alice.token), body: JSON.stringify({ name, content, hash: createHash("sha256").update(content, "utf8").digest("hex"), baseVersion: 0 }) });
    if (!made.ok) throw new Error(`create ${name}: ${made.status}`);
    // A document is live once it is shared.
    const sharedDoc = await fetch(`${base}/api/docs/${id}/shares`, { method: "POST", headers: authed(accounts.alice.token), body: JSON.stringify({ email: accounts.bob.email, role: "editor" }) });
    if (!sharedDoc.ok) throw new Error(`share ${name}: ${sharedDoc.status}`);
    await alice3.navigate(`${base}/app/d/${id}`);
    await poll(`alice live on ${name}`, () => alice3.evaluate("!!(window.__markieCollab && window.__markieEditor && window.__markieEditor.isEditable && window.__markieCollab.ydoc.getMap('meta').get('editorModel') === 2)").catch(() => false), 30_000);
    await sleep(500);
  }
  const notesOld = await fetch(`${base}/api/docs/notes-${stamp}/collab-ticket`, { method: "POST", headers: authed(accounts.alice.token), body: "{}" });
  check("an old build is kept out of the room of a document with front matter, formulas or not", notesOld.status === 409, String(notesOld.status));
  const plainOld = await fetch(`${base}/api/docs/plain-${stamp}/collab-ticket`, { method: "POST", headers: authed(accounts.alice.token), body: "{}" });
  check("an old build still joins the room of a plain document", plainOld.status === 200, String(plainOld.status));
  await alice3.close();
  await bob3.close();
} catch (error) {
  failures.push(String(error?.stack || error));
  say(`ERROR ${error?.stack || error}`);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "result.txt"), `${log.join("\n")}\n\n${failures.length ? `FAILED: ${failures.length}` : "ALL PASSED"}\n`);
  await writeFile(path.join(evidence, "server.log"), serverOutput.replace(/\b\d{6}\b/g, "######"));
  say(failures.length ? `FAILED (${failures.length}); evidence in ${evidence}` : `ALL PASSED; evidence in ${evidence}`);
  process.exit(failures.length ? 1 : 0);
}
