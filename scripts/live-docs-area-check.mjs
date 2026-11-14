#!/usr/bin/env node
// Live Docs M3 in a real window: open a real Darkmown project in the Live Docs
// area, edit and save a .wd, a .skin and a .js in it, and see an edit made
// outside Markie show up in the open tab and the tree.
//
// The unit tests cover every rule. They cannot say whether CodeMirror takes
// typing and ⌘S inside the area, whether the native menu's Save and Undo reach
// it through main, or whether a real recursive fs.watch on this Mac delivers
// an outside edit to the window. Only a window can.
//
// The project is a scratch copy: a real site's package.json, site/ and api/
// copied into a temp folder. The source project is only read, and the script
// checks it is byte for byte unchanged at the end.
//
// No browser opens. The launched app's main process has shell.openExternal
// replaced, through Electron's own inspector, by a stub that only records the
// URL, and nothing is clicked until the stub is proved to be in place. The
// folder picker is replaced the same way, answering the scratch folder. Both
// replacements live only in that test process: the app has no switch that
// changes either, and must never get one.
//
// Run: MARKIE_ALLOW_E2E=1 node scripts/live-docs-area-check.mjs [source-project]
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("live-docs-area-check", import.meta.url);
// Started from inside another Electron app (an editor, an agent host), this
// variable is inherited and turns the launched Markie into plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `live-docs-area-check-${stamp}`);
const sourceProject = path.resolve(process.argv[2] ?? path.join(root, "..", "darkmown-7thst"));
const tempPaths = [];
let stopRenderer = () => {};
let closeWindow = async () => {};

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed: !!passed });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(1));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, fn, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function cdpConnect(debugOrigin) {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, ev, close: () => ws.close() };
}

// The main process, over the Node inspector the launch enabled with --inspect.
// openExternal and the folder picker are replaced before anything is clicked,
// and every click below checks first that both replacements still hold.
const LOAD = `(process.mainModule ? process.mainModule.require.bind(process.mainModule) : process.getBuiltinModule("module").createRequire(process.cwd() + "/"))`;
const stubSource = (folder) => `(() => {
  const { shell, dialog } = ${LOAD}("electron");
  globalThis.__m3Opened = [];
  globalThis.__m3Dialogs = [];
  const open = async (url) => { globalThis.__m3Opened.push(String(url)); };
  open.__m3Stub = true;
  shell.openExternal = open;
  const pick = async (...args) => {
    const options = args.find((arg) => arg && typeof arg === "object" && Array.isArray(arg.properties)) ?? {};
    globalThis.__m3Dialogs.push({ title: options.title ?? null, properties: options.properties ?? [] });
    return { canceled: false, filePaths: [${JSON.stringify(folder)}] };
  };
  pick.__m3Stub = true;
  dialog.showOpenDialog = pick;
  return shell.openExternal === open && dialog.showOpenDialog === pick;
})()`;
const STUBS_HOLD = `(() => { const { shell, dialog } = ${LOAD}("electron"); return shell.openExternal.__m3Stub === true && dialog.showOpenDialog.__m3Stub === true; })()`;
async function connectMain(inspectPort, folder, devOrigin) {
  const targets = await waitFor("the main-process inspector", async () => {
    const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
    return Array.isArray(list) && list.length ? list : null;
  }, 30000);
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (raw) => { const message = JSON.parse(raw); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => {
      const result = message.result;
      if (message.error || result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? result.exceptionDetails)));
      else resolve(result.result?.value);
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if ((await evaluate(stubSource(folder))) !== true || (await evaluate(STUBS_HOLD)) !== true) throw new Error("openExternal and the folder picker could not be stubbed; refusing to click anything");
  return {
    opened: () => evaluate("globalThis.__m3Opened.slice()"),
    dialogs: () => evaluate("globalThis.__m3Dialogs.slice()"),
    assertHolds: async () => { if ((await evaluate(STUBS_HOLD)) !== true) throw new Error("the main-process stubs no longer hold; refusing to click"); },
    // What the native menu's Save and Undo items do when clicked.
    menu: (channel) => evaluate(`(() => {
      const { BrowserWindow } = ${LOAD}("electron");
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().startsWith(${JSON.stringify(devOrigin)}));
      if (!win) return false;
      win.webContents.send(${JSON.stringify(channel)});
      return true;
    })()`),
    close: () => ws.close(),
  };
}

async function shoot(cdp, name) {
  await sleep(400);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}
async function dump(cdp, name) {
  try {
    await shoot(cdp, name);
    process.stderr.write(`window text at ${name}: ${JSON.stringify(String(await cdp.ev("document.body.innerText")).slice(0, 800))}\n`);
  } catch { /* the window may already be gone */ }
}

const js = (value) => JSON.stringify(value);
const treeButton = (filePath) => `document.querySelector('nav[aria-label="Project files"] button[title=${js(filePath)}]')`;
const editorOf = (filePath) => `document.querySelector('[data-live-docs-editor=${js(filePath)}] .cm-content')`;
const buttonByText = (text) => `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === ${js(text)} && !button.closest("[inert]"))`;

async function typeAtEnd(cdp, filePath, text) {
  await cdp.ev(`${editorOf(filePath)}.focus()`);
  // ⌘↓ is "end of document" in CodeMirror on macOS.
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 4, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await cdp.send("Input.insertText", { text });
}
async function pressSave(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 4, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 });
}
async function openInArea(cdp, main, filePath) {
  await main.assertHolds();
  await waitFor(`${filePath} in the tree`, () => cdp.ev(`!!${treeButton(filePath)}`), 10000);
  await cdp.ev(`${treeButton(filePath)}.click()`);
  await waitFor(`${filePath} in an editor tab`, () => cdp.ev(`!!${editorOf(filePath)} && !${editorOf(filePath)}.closest("[hidden]")`), 15000);
}
const editorText = (cdp, filePath) => cdp.ev(`${editorOf(filePath)}?.innerText ?? null`);

async function main() {
  if (!existsSync(path.join(sourceProject, "site", "pages"))) throw new Error(`${sourceProject} has no site/pages; pass a Darkmown project to copy`);
  await mkdir(artifactDir, { recursive: true });
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-m3-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-m3-home-"));
  tempPaths.push(userDataDir, homeDir);

  // The scratch project: a real site's own files, nothing written back.
  const sourceIndex = path.join(sourceProject, "site", "pages", "index.wd");
  const sourceBefore = sha(await readFile(sourceIndex));
  const project = path.join(homeDir, "corner-project");
  await mkdir(project, { recursive: true });
  await cp(path.join(sourceProject, "package.json"), path.join(project, "package.json"));
  await cp(path.join(sourceProject, "site"), path.join(project, "site"), { recursive: true });
  if (existsSync(path.join(sourceProject, "api"))) await cp(path.join(sourceProject, "api"), path.join(project, "api"), { recursive: true });
  // What the area must hide, refuse or not follow.
  await mkdir(path.join(project, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(project, ".git", "config"), "[core]\n");
  await mkdir(path.join(project, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(project, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  await mkdir(path.join(homeDir, "outside"), { recursive: true });
  await writeFile(path.join(homeDir, "outside", "secret.txt"), "secret\n");
  await symlink(path.join(homeDir, "outside"), path.join(project, "site", "escape"));
  await writeFile(path.join(project, "site", "pages", "big.json"), "x".repeat(3 * 1024 * 1024));
  await writeFile(path.join(project, "site", "pages", "pixel.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  const jsFile = existsSync(path.join(project, "api", "lead.js")) ? "api/lead.js" : "site/pages/m3-page.js";
  if (!existsSync(path.join(project, jsFile))) await writeFile(path.join(project, jsFile), "export const page = 1;\n");

  const devPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;
  const env = { HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin };

  const debugPort = await pickPort(), inspectPort = await pickPort();
  const win = await launchElectron({ debugPort, args: [".", `--user-data-dir=${userDataDir}`, `--inspect=127.0.0.1:${inspectPort}`], env, log: path.join(artifactDir, "electron.log") });
  closeWindow = win.close;
  const mainProcess = await connectMain(inspectPort, project, devOrigin);
  check("openExternal and the folder picker are stubbed in main before any click", true);
  const cdp = await waitFor("CDP", () => cdpConnect(`http://127.0.0.1:${debugPort}`), 40000);
  const booted = () => cdp.ev("document.readyState === 'complete' && !!document.querySelector('#root')?.childElementCount && !!document.querySelector('.markie-activity-bar')");
  await waitFor("boot", booted, 40000);
  // The dev build's nightly switch is read when the page mounts.
  await cdp.ev(`localStorage.setItem("markie.nightly", "1")`);
  await cdp.send("Page.reload");
  await sleep(500);
  await waitFor("boot after reload", booted, 40000);
  await waitFor("the Live Docs rail button", () => cdp.ev(`!!document.querySelector('[aria-label="Live Docs: Darkmown projects"]')`), 20000)
    .catch(async (error) => { await dump(cdp, "00-no-rail-button"); throw error; });

  // ── The area's home, and adding the project through main's picker ───────
  await mainProcess.assertHolds();
  await cdp.ev(`document.querySelector('[aria-label="Live Docs: Darkmown projects"]').click()`);
  await waitFor("the Live Docs home", () => cdp.ev(`!!document.querySelector('[data-markie-live-docs="home"]')`), 15000);
  await mainProcess.assertHolds();
  await cdp.ev(`${buttonByText("Add Project…")}.click()`);
  await waitFor("the project in the list", () => cdp.ev(`!!document.querySelector('[aria-label="Open corner-project"]')`), 15000)
    .catch(async (error) => { await dump(cdp, "01-no-project"); throw error; });
  const dialogs = await mainProcess.dialogs();
  check("Add Project asks main's folder picker for a folder", dialogs.length === 1 && dialogs[0].properties.includes("openDirectory"), js(dialogs));
  const listed = await cdp.ev(`document.querySelector('[data-markie-live-docs="home"]').innerText`);
  check("the list shows the project and where it is, with home shortened", listed.includes("corner-project") && listed.includes("~/corner-project"), js(listed.slice(0, 200)));
  await shoot(cdp, "01-home");

  // ── Opening it: every project file, nothing from .git or node_modules ──
  await mainProcess.assertHolds();
  await cdp.ev(`document.querySelector('[aria-label="Open corner-project"]').click()`);
  await waitFor("the project tree", () => cdp.ev(`!!document.querySelector('nav[aria-label="Project files"] button')`), 15000);
  if (jsFile.startsWith("api/")) await cdp.ev(`${treeButton("api")}.click()`);
  const tree = await cdp.ev(`[...document.querySelectorAll('nav[aria-label="Project files"] [title]')].map((node) => node.getAttribute("title"))`);
  check("the tree shows the .wd, the .skin and the .js", ["site/pages/index.wd", "site/pages/index.skin", jsFile].every((file) => tree.includes(file)), js(tree.slice(0, 30)));
  check("the tree hides .git and node_modules", !tree.some((file) => file === ".git" || file.startsWith(".git/") || file.includes("node_modules")), js(tree.filter((file) => /git|node_modules/.test(file))));
  check("a symlink out of the project shows as a link and is not walked", tree.some((file) => file.startsWith("site/escape ")) && !tree.some((file) => file.includes("secret")), js(tree.filter((file) => file.includes("escape"))));

  // ── Edit and save a .wd (keyboard ⌘S), a .skin (menu Save), a .js (menu Undo, then ⌘S) ──
  await openInArea(cdp, mainProcess, "site/pages/index.wd");
  check("the .wd opens in CodeMirror", await cdp.ev(`!!document.querySelector('[data-live-docs-editor="site/pages/index.wd"] .cm-editor')`));
  await typeAtEnd(cdp, "site/pages/index.wd", "\n<!-- m3 check: wd -->\n");
  await waitFor("the .wd tab marked unsaved", () => cdp.ev(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes("●")`), 5000);
  await mainProcess.assertHolds();
  await pressSave(cdp);
  const wdSaved = await waitFor("the .wd on disk", async () => (await readFile(path.join(project, "site/pages/index.wd"), "utf8")).includes("<!-- m3 check: wd -->"), 10000).catch(() => false);
  check("⌘S saves the .wd to disk", wdSaved);
  check("and the area says it is saved", await waitFor("Saved", () => cdp.ev(`document.querySelector('footer [role="status"]')?.textContent === "Saved"`), 5000).catch(() => false));

  await openInArea(cdp, mainProcess, "site/pages/index.skin");
  await typeAtEnd(cdp, "site/pages/index.skin", "\n// m3 check: skin\n");
  await mainProcess.assertHolds();
  check("the native menu's Save reaches the window", await mainProcess.menu("menu-save"));
  const skinSaved = await waitFor("the .skin on disk", async () => (await readFile(path.join(project, "site/pages/index.skin"), "utf8")).includes("// m3 check: skin"), 10000).catch(() => false);
  check("menu Save saves the .skin to disk", skinSaved);

  await openInArea(cdp, mainProcess, jsFile);
  const jsBefore = await readFile(path.join(project, jsFile), "utf8");
  await typeAtEnd(cdp, jsFile, "UNDO-ME");
  await waitFor("typed text", async () => (await editorText(cdp, jsFile)).includes("UNDO-ME"), 5000);
  await mainProcess.assertHolds();
  await mainProcess.menu("menu-undo");
  check("the native menu's Undo undoes in the area's editor", await waitFor("undo", async () => !(await editorText(cdp, jsFile)).includes("UNDO-ME"), 5000).catch(() => false));
  await typeAtEnd(cdp, jsFile, "\n// m3 check: js\n");
  await pressSave(cdp);
  const jsSaved = await waitFor("the .js on disk", async () => { const text = await readFile(path.join(project, jsFile), "utf8"); return text.includes("// m3 check: js") && !text.includes("UNDO-ME") && text.startsWith(jsBefore.trimEnd()); }, 10000).catch(() => false);
  check(`⌘S saves the .js (${jsFile}) to disk`, jsSaved);
  const strays = (await Promise.all(["site/pages", path.dirname(jsFile)].map(async (dir) => (await import("node:fs/promises")).readdir(path.join(project, dir))))).flat().filter((name) => name.endsWith(".tmp"));
  check("saves leave no temp files behind", strays.length === 0, js(strays));
  await shoot(cdp, "02-three-tabs-saved");

  // ── Outside edits: the open tab and the tree ──
  await cdp.ev(`[...document.querySelectorAll('[role="tab"]')].find((tab) => tab.title === "site/pages/index.wd").click()`);
  const wdNow = await readFile(path.join(project, "site/pages/index.wd"), "utf8");
  await writeFile(path.join(project, "site/pages/index.wd"), `${wdNow}\n## Edited outside Markie\n`);
  check("an outside edit shows up in the open, saved tab", await waitFor("the outside edit in the editor", async () => (await editorText(cdp, "site/pages/index.wd")).includes("Edited outside Markie"), 10000).catch(() => false));
  await writeFile(path.join(project, "site/pages/m3-new.wd"), "# Made outside\n");
  check("a file made outside shows up in the tree", await waitFor("the new file in the tree", () => cdp.ev(`!!${treeButton("site/pages/m3-new.wd")}`), 10000).catch(() => false));

  await typeAtEnd(cdp, "site/pages/index.wd", "\nunsaved line\n");
  await writeFile(path.join(project, "site/pages/index.wd"), "# Replaced outside\n");
  const banner = await waitFor("the changed-on-disk banner", () => cdp.ev(`[...document.querySelectorAll('[role="alert"]')].map((node) => node.innerText).find((text) => text.includes("changed outside Markie")) ?? null`), 10000).catch(() => null);
  check("an outside edit over unsaved text asks instead of replacing it", !!banner && (await editorText(cdp, "site/pages/index.wd")).includes("unsaved line"), js(banner));
  await shoot(cdp, "03-changed-on-disk");
  await mainProcess.assertHolds();
  await cdp.ev(`${buttonByText("Reload from disk")}.click()`);
  check("Reload from disk takes the outside version", await waitFor("reloaded", async () => (await editorText(cdp, "site/pages/index.wd")).trim() === "# Replaced outside", 5000).catch(() => false));

  // ── Main's refusals, asked through the real IPC from this window ──
  const refusals = await cdp.ev(`(async () => {
    const api = window.electronAPI.liveDocsProjects;
    const code = async (promise) => { const result = await promise; return result.ok ? "ok" : result.code; };
    const frame = document.createElement("iframe");
    frame.srcdoc = "<p>frame</p>";
    document.body.appendChild(frame);
    await new Promise((done) => { frame.onload = done; setTimeout(done, 1500); });
    let frameBridge = "unreadable";
    try { frameBridge = typeof frame.contentWindow.electronAPI; } catch { /* cross-origin */ }
    frame.remove();
    return {
      parent: await code(api.read({ path: "../outside/secret.txt" })),
      absolute: await code(api.read({ path: ${js(path.join(homeDir, "outside", "secret.txt"))} })),
      symlinkOut: await code(api.read({ path: "site/escape/secret.txt" })),
      gitWrite: await code(api.write({ path: ".git/config", text: "[core]\\n\\thooksPath = /tmp\\n", baseRevision: "0".repeat(64) })),
      gitRead: await code(api.read({ path: ".git/config" })),
      nodeModules: await code(api.read({ path: "node_modules/left-pad/index.js" })),
      oversized: await code(api.read({ path: "site/pages/big.json" })),
      binary: await code(api.read({ path: "site/pages/pixel.bin" })),
      extraKey: await code(api.read({ path: "site/pages/index.wd", root: "/" })),
      frameBridge,
    };
  })()`);
  check("main refuses ..", refusals.parent === "outside", refusals.parent);
  check("main refuses an absolute path", refusals.absolute === "outside", refusals.absolute);
  check("main refuses a symlink out of the project", refusals.symlinkOut === "outside", refusals.symlinkOut);
  check("main refuses a write into .git, and reads of .git and node_modules", refusals.gitWrite === "hidden" && refusals.gitRead === "hidden" && refusals.nodeModules === "hidden", js([refusals.gitWrite, refusals.gitRead, refusals.nodeModules]));
  check("main refuses an oversized file and a binary file", refusals.oversized === "too-large" && refusals.binary === "binary", js([refusals.oversized, refusals.binary]));
  check("main refuses a request with an extra key", refusals.extraKey === "invalid-request", refusals.extraKey);
  check("a subframe gets no Markie bridge to ask with", refusals.frameBridge === "undefined" || refusals.frameBridge === "unreadable", refusals.frameBridge);
  check("the .git config is unchanged", (await readFile(path.join(project, ".git", "config"), "utf8")) === "[core]\n");
  check("the file outside the project is unchanged", (await readFile(path.join(homeDir, "outside", "secret.txt"), "utf8")) === "secret\n");

  // ── Closing the project stops its watcher ──
  await cdp.ev(`window.__m3Changes = []; window.__m3Off = window.electronAPI.liveDocsProjects.onChanged((change) => window.__m3Changes.push(change));`);
  await mainProcess.assertHolds();
  await cdp.ev(`${buttonByText("← Live Docs")}.click()`);
  const confirmText = await waitFor("close confirmation or home", () => cdp.ev(`document.querySelector('[role="dialog"]')?.innerText ?? (document.querySelector('[data-markie-live-docs="home"]') ? "home" : null)`), 5000);
  if (confirmText !== "home") await cdp.ev(`${buttonByText("Discard and close")}.click()`);
  await waitFor("home after closing", () => cdp.ev(`!!document.querySelector('[data-markie-live-docs="home"]')`), 5000);
  await writeFile(path.join(project, "site/pages/after-close.wd"), "# after\n");
  await sleep(2000);
  check("after the project closes, outside edits send nothing", (await cdp.ev("window.__m3Changes.length")) === 0, String(await cdp.ev("JSON.stringify(window.__m3Changes)")));
  await cdp.ev("window.__m3Off()");

  check("nothing reached openExternal", (await mainProcess.opened()).length === 0, js(await mainProcess.opened()));
  check("the source project is byte for byte unchanged", sha(await readFile(sourceIndex)) === sourceBefore);
  await shoot(cdp, "04-home-after-close");
  cdp.close();
  mainProcess.close();

  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\nScreenshots: ${artifactDir}\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((entry) => entry.name).join(", ")}\n`);
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (error) {
  process.stderr.write(`live-docs-area-check failed: ${error.stack ?? error}\n`);
} finally {
  await closeWindow();
  stopRenderer();
  await Promise.all(tempPaths.map((target) => rm(target, { recursive: true, force: true }).catch(() => {})));
}
process.exit(ok ? 0 : 1);
