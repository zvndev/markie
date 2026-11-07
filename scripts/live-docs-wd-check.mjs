#!/usr/bin/env node
// Live Docs M2 in a real window: a .wd shows the pictures beside it, a link in
// it reaches the host only after a real click, and Make Interactive turns a
// Markdown file into a .wd copy without touching the Markdown file.
//
// The unit tests cover every rule. They cannot say whether Chromium loads a
// markie-asset:// picture inside an opaque, sandboxed srcdoc frame under that
// frame's own CSP, whether a click inside that frame gives the host page the
// user activation the host checks for, or whether main's protocol handler
// refuses a `../` and a symlink once a real request arrives. Only a window can.
//
// Two launches, one profile, one dev server (so localStorage, where the dev
// build's nightly switch lives, survives between them):
//   A. open "Trip notes.md", run Make Interactive from the palette, check the
//      copy's preview, its links, its CodeMirror source, and the Markdown file.
//   B. open "board.wd" from disk, check the preview through its file lease.
//
// No browser opens. Every window this script launches has its main process's
// shell.openExternal replaced, through Electron's own inspector, by a stub
// that only records the URL, and nothing is clicked until the stub is proved
// to be in place. The replacement lives only in that test process: the app
// has no switch that changes openExternal, and must never get one.
//
// Run: MARKIE_ALLOW_E2E=1 node scripts/live-docs-wd-check.mjs
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { crc32, deflateSync } from "node:zlib";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("live-docs-wd-check", import.meta.url);
// Started from inside another Electron app (an editor, an agent host), this
// variable is inherited and turns the launched Markie into plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "live-docs-wd-check");
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
    await sleep(300);
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

// A solid-colour PNG, so naturalWidth has something real to report.
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from([r, g, b]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

// CDP with flattened sessions, so an out-of-process frame is reachable too.
async function cdpConnect(debugOrigin) {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  let nextId = 1;
  const pending = new Map();
  const frameSessions = new Map();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method === "Target.attachedToTarget" && message.params.targetInfo.type === "iframe") frameSessions.set(message.params.sessionId, message.params.targetInfo);
    if (message.method === "Target.detachedFromTarget") frameSessions.delete(message.params.sessionId);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const ev = async (expression, extra = {}) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...extra }, extra.sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // Evaluate inside the preview frame, in an isolated world: the frame's own
  // scripts never see this, and it works whatever the frame's sandbox is.
  const inPreview = async (expression) => {
    const tree = await send("Page.getFrameTree");
    const children = tree.frameTree.childFrames ?? [];
    const local = children.map((child) => child.frame).find((frame) => frame.url === "about:srcdoc");
    if (local) {
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: local.id, worldName: "m2-check" });
      return ev(expression, { contextId: executionContextId });
    }
    for (const [sessionId, info] of frameSessions) {
      if (info.url !== "about:srcdoc") continue;
      const own = await send("Page.getFrameTree", {}, sessionId);
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: own.frameTree.frame.id, worldName: "m2-check" }, sessionId);
      return ev(expression, { contextId: executionContextId, sessionId });
    }
    throw new Error("no about:srcdoc preview frame");
  };
  return { send, ev, inPreview, close: () => ws.close() };
}

// Replace shell.openExternal inside the launched app's main process, over
// the Node inspector the launch enabled with --inspect. Fails closed: any
// doubt that the stub is in place throws before the caller clicks anything.
const STUB_SOURCE = `(() => {
  const load = process.mainModule ? process.mainModule.require.bind(process.mainModule) : process.getBuiltinModule("module").createRequire(process.cwd() + "/");
  const { shell } = load("electron");
  globalThis.__m2Opened = [];
  const stub = async (url) => { globalThis.__m2Opened.push(String(url)); };
  stub.__m2Stub = true;
  shell.openExternal = stub;
  return shell.openExternal === stub;
})()`;
const STUB_HOLDS = `(() => {
  const load = process.mainModule ? process.mainModule.require.bind(process.mainModule) : process.getBuiltinModule("module").createRequire(process.cwd() + "/");
  return load("electron").shell.openExternal.__m2Stub === true;
})()`;
async function stubOpenExternal(inspectPort) {
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
  if ((await evaluate(STUB_SOURCE)) !== true || (await evaluate(STUB_HOLDS)) !== true) throw new Error("shell.openExternal could not be stubbed; refusing to click anything");
  return {
    opened: () => evaluate("globalThis.__m2Opened.slice()"),
    assertHolds: async () => { if ((await evaluate(STUB_HOLDS)) !== true) throw new Error("shell.openExternal is no longer stubbed; refusing to click"); },
    close: () => ws.close(),
  };
}

const PREVIEW_REPORT = `(async () => {
  await Promise.all([...document.images].map((image) => image.complete ? null : new Promise((done) => { image.onload = image.onerror = done; setTimeout(done, 4000); })));
  return {
    url: location.href,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
    headings: [...document.querySelectorAll("h1, h2")].map((heading) => heading.textContent),
    images: [...document.images].map((image) => ({ alt: image.alt, src: image.getAttribute("src"), loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth })),
    links: [...document.querySelectorAll("a")].map((anchor) => ({ text: anchor.textContent, href: anchor.getAttribute("href"), target: anchor.getAttribute("target") })),
    boxes: [...document.querySelectorAll('li input[type="checkbox"]')].map((box) => [box.parentElement.textContent.trim(), box.checked]),
    text: document.body.innerText,
  };
})()`;

const MARKDOWN = [
  "# Trip notes", "",
  "Book through [the hotel site](https://example.com/hotel) or [email Ada](mailto:ada@example.com).", "",
  "![The view](pics/view.png)", "",
  "![Outside the folder](../private/secret.png)", "",
  "![Symlinked out](pics/out.png)", "",
  "![Remote](https://example.com/remote.png)", "",
  "## Packing", "",
  "- [ ] passport",
  "- [x] charger", "",
].join("\n");

// What the window showed when a wait gave up, so a failure explains itself.
async function dump(cdp, name) {
  try {
    await shoot(cdp, name);
    process.stderr.write(`window text at ${name}: ${JSON.stringify(String(await cdp.ev("document.body.innerText")).slice(0, 600))}\n`);
  } catch { /* the window may already be gone */ }
}

async function shoot(cdp, name) {
  await sleep(450);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}

function checkPreview(report, label) {
  const byAlt = Object.fromEntries(report.images.map((image) => [image.alt, image]));
  check(`${label}: the picture beside the document loads`, byAlt["The view"]?.loaded === true && byAlt["The view"].width === 160, JSON.stringify(byAlt["The view"]));
  check(`${label}: it is served through a picture scope`, /^markie-asset:\/\/wd-[0-9a-f]{32}\/pics%2Fview\.png$/.test(byAlt["The view"]?.src ?? ""), String(byAlt["The view"]?.src));
  check(`${label}: a ../ picture never reaches the frame`, !byAlt["Outside the folder"], JSON.stringify(byAlt["Outside the folder"] ?? null));
  check(`${label}: a picture symlinked out of the folder is refused by main`, byAlt["Symlinked out"] && byAlt["Symlinked out"].loaded === false, JSON.stringify(byAlt["Symlinked out"] ?? null));
  check(`${label}: a remote picture is not loaded`, !byAlt.Remote, JSON.stringify(byAlt.Remote ?? null));
  check(`${label}: links keep their address and open a new window`, JSON.stringify(report.links) === JSON.stringify([
    { text: "the hotel site", href: "https://example.com/hotel", target: "_blank" },
    { text: "email Ada", href: "mailto:ada@example.com", target: "_blank" },
  ]), JSON.stringify(report.links));
  check(`${label}: the checklist keeps its ticks`, JSON.stringify(report.boxes) === JSON.stringify([["passport", false], ["charger", true]]), JSON.stringify(report.boxes));
  check(`${label}: the frame CSP allows only that scope for pictures`, /img-src markie-asset:\/\/wd-[0-9a-f]{32};/.test(report.csp ?? "") && /connect-src 'none'/.test(report.csp ?? ""), String(report.csp));
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-m2-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-m2-home-"));
  tempPaths.push(userDataDir, homeDir);
  const trip = path.join(homeDir, "trip");
  await mkdir(path.join(trip, "pics"), { recursive: true });
  await mkdir(path.join(homeDir, "private"), { recursive: true });
  await writeFile(path.join(trip, "pics", "view.png"), png(160, 90, [40, 120, 200]));
  await writeFile(path.join(homeDir, "private", "secret.png"), png(160, 90, [200, 40, 40]));
  await symlink(path.join(homeDir, "private", "secret.png"), path.join(trip, "pics", "out.png"));
  const mdPath = path.join(trip, "Trip notes.md");
  const wdPath = path.join(trip, "board.wd");
  await writeFile(mdPath, MARKDOWN);
  await writeFile(wdPath, MARKDOWN);
  const mdBefore = await readFile(mdPath);

  const devPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;
  const env = { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin };

  // ── Warm-up: turn the dev build's nightly switch on in this profile ───────
  // It is read once, when the app mounts, and a reload would drop the file the
  // window was launched with, so it is set in a launch of its own.
  let debugPort = await pickPort(), inspectPort = await pickPort();
  let win = await launchElectron({ debugPort, args: [".", `--user-data-dir=${userDataDir}`, `--inspect=127.0.0.1:${inspectPort}`], env, log: path.join(artifactDir, "electron-0.log") });
  closeWindow = win.close;
  let browser = await stubOpenExternal(inspectPort);
  let cdp = await waitFor("CDP", () => cdpConnect(`http://127.0.0.1:${debugPort}`), 40000);
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete' && !!document.querySelector('#root')?.childElementCount"), 40000);
  await cdp.ev(`localStorage.setItem("markie.nightly", "1")`);
  cdp.close(); browser.close();
  await win.close();

  // ── A. Make Interactive from a Markdown file ──────────────────────────────
  debugPort = await pickPort(); inspectPort = await pickPort();
  win = await launchElectron({ debugPort, args: [".", mdPath, `--user-data-dir=${userDataDir}`, `--inspect=127.0.0.1:${inspectPort}`], env, log: path.join(artifactDir, "electron-a.log") });
  closeWindow = win.close;
  browser = await stubOpenExternal(inspectPort);
  cdp = await waitFor("CDP", () => cdpConnect(`http://127.0.0.1:${debugPort}`), 40000);
  check("the nightly switch survived into this launch", await waitFor("nightly", () => cdp.ev(`localStorage.getItem("markie.nightly") === "1"`), 20000).catch(() => false));
  await waitFor("Markdown document", async () => (await cdp.ev(`document.querySelector('.markdown-body')?.innerText || ''`)).includes("Trip notes"), 40000)
    .catch(async (error) => { await dump(cdp, "00-no-markdown"); throw error; });

  await cdp.ev(`document.querySelector('[aria-label="Commands (⌘K)"]').click()`);
  await waitFor("palette", () => cdp.ev(`!!document.querySelector('input[placeholder="Type a command…"]')`));
  await cdp.ev(`document.querySelector('input[placeholder="Type a command…"]').focus()`);
  await cdp.send("Input.insertText", { text: "Make interactive" });
  await waitFor("palette option", () => cdp.ev(`[...document.querySelectorAll('[role="option"]')].some((option) => /Make interactive/.test(option.textContent))`));
  await cdp.ev(`[...document.querySelectorAll('[role="option"]')].find((option) => /Make interactive/.test(option.textContent)).click()`);
  await waitFor("the .wd copy's preview", () => cdp.ev(`!!document.querySelector('.docs-darkmown-preview iframe')`), 30000);
  await waitFor("the copy's picture", async () => (await cdp.inPreview(PREVIEW_REPORT))?.images?.some((image) => image.alt === "The view"), 20000);

  const workspace = await cdp.ev(`({
    // The embedded workspace shows the document's name in Markie's own toolbar.
    toolbar: document.querySelector('.markie-toolbar')?.innerText ?? '',
    status: document.querySelector('.docs-status [role="status"]')?.textContent ?? null,
    codeMirror: !!document.querySelector('.docs-darkmown-source .cm-editor'),
    textarea: !!document.querySelector('.docs-darkmown-source textarea'),
    source: document.querySelector('.docs-darkmown-source .cm-content')?.innerText ?? '',
    sandbox: document.querySelector('.docs-darkmown-preview iframe')?.getAttribute('sandbox'),
    trusted: document.querySelector('.docs-darkmown-host')?.getAttribute('data-darkmown-trusted'),
  })`);
  check("Make Interactive opens a new .wd named after the Markdown file", workspace.toolbar.includes("Trip notes.wd"), JSON.stringify(workspace.toolbar.slice(0, 200)));
  check("the copy is not saved to a file yet", workspace.status === "Not saved to a file yet", String(workspace.status));
  check("its source is CodeMirror, holding the Markdown", workspace.codeMirror && !workspace.textarea && workspace.source.includes("- [x] charger"), JSON.stringify({ codeMirror: workspace.codeMirror, textarea: workspace.textarea }));
  check("an untrusted preview runs scripts only for the link bridge", workspace.sandbox === "allow-scripts" && workspace.trusted === "false", `${workspace.sandbox} / ${workspace.trusted}`);
  const copy = await cdp.inPreview(PREVIEW_REPORT);
  checkPreview(copy, "copy");
  check("copy: headings and text survive", JSON.stringify(copy.headings) === JSON.stringify(["Trip notes", "Packing"]), JSON.stringify(copy.headings));
  check("the Markdown file is byte for byte unchanged", Buffer.compare(mdBefore, await readFile(mdPath)) === 0);

  // Links. The page records the bridge's message (and whether it held user
  // activation) and lets it carry on: the editor, preload, IPC and main's own
  // check all run, and the stubbed openExternal records what main would open.
  await cdp.ev(`(() => {
    window.__m2Links = [];
    window.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== "markie:wd-link") return;
      const frame = document.querySelector('.docs-darkmown-preview iframe');
      window.__m2Links.push({ href: event.data.href, keys: Object.keys(event.data).sort().join(","), active: navigator.userActivation.isActive, origin: event.origin, fromFrame: !!frame && event.source === frame.contentWindow });
    }, true);
  })()`);
  await browser.assertHolds();
  await cdp.inPreview(`document.querySelector('a').click()`);
  await sleep(600);
  check("a link fired by a script, not a click, sends nothing", (await cdp.ev("window.__m2Links.length")) === 0);
  check("and main opens nothing for it", (await browser.opened()).length === 0);
  const box = await cdp.inPreview(`(() => { const anchor = document.querySelector('a'); anchor.scrollIntoView({ block: "center" }); const r = anchor.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const frameBox = await cdp.ev(`(() => { const frame = document.querySelector('.docs-darkmown-preview iframe'); const r = frame.getBoundingClientRect(); return { x: r.left + frame.clientLeft, y: r.top + frame.clientTop }; })()`);
  const at = { x: Math.round(frameBox.x + box.x), y: Math.round(frameBox.y + box.y) };
  await browser.assertHolds();
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  const received = await waitFor("the link message", async () => { const links = await cdp.ev("window.__m2Links"); return links.length ? links : null; }, 5000).catch(() => []);
  check("a real click sends exactly one link to the host", received.length === 1, JSON.stringify(received));
  check("it carries only the href, from this frame's opaque origin", received[0]?.href === "https://example.com/hotel" && received[0]?.keys === "href,type" && received[0]?.origin === "null" && received[0]?.fromFrame === true, JSON.stringify(received[0] ?? null));
  check("the host holds the user activation that click gave it", received[0]?.active === true, JSON.stringify(received[0] ?? null));
  const after = await cdp.inPreview(`location.href`);
  check("the preview frame did not navigate", after === "about:srcdoc", String(after));
  const handed = await waitFor("main to open the link", async () => { const urls = await browser.opened(); return urls.length ? urls : null; }, 5000).catch(() => []);
  check("main hands exactly that URL to openExternal (stubbed)", JSON.stringify(handed) === JSON.stringify(["https://example.com/hotel"]), JSON.stringify(handed));

  // Main's own refusals, asked directly through the real IPC and protocol.
  const ipc = await cdp.ev(`(async () => {
    const api = window.electronAPI.darkmownPreview;
    const scope = await api.pictureScope({ markdownPath: ${JSON.stringify(mdPath)} });
    const load = (src) => new Promise((done) => { const image = new Image(); image.onload = () => done(image.naturalWidth); image.onerror = () => done("refused"); image.src = src; });
    const base = scope.ok ? scope.base : null;
    return {
      scope,
      beside: base ? await load(base + "/" + encodeURIComponent("pics/view.png")) : null,
      upward: base ? await load(base + "/" + encodeURIComponent("../private/secret.png")) : null,
      symlink: base ? await load(base + "/" + encodeURIComponent("pics/out.png")) : null,
      absolute: base ? await load(base + "/" + encodeURIComponent(${JSON.stringify(path.join(homeDir, "private", "secret.png"))})) : null,
      unknownScope: await load("markie-asset://wd-ffffffffffffffffffffffffffffffff/" + encodeURIComponent("pics/view.png")),
      ungrantedMarkdown: await api.pictureScope({ markdownPath: ${JSON.stringify(path.join(homeDir, "private", "nope.md"))} }),
      forgedLease: await api.pictureScope({ leaseId: "00000000-0000-4000-8000-000000000000" }),
      bothKeys: await api.pictureScope({ leaseId: "x", markdownPath: ${JSON.stringify(mdPath)} }),
      javascript: await api.openLink("javascript:alert(1)"),
      file: await api.openLink("file:///etc/passwd"),
      attach: await api.openLink("mailto:ada@example.com?attach=/etc/passwd"),
    };
  })()`);
  check("main issues a picture scope for a Markdown file this window opened", ipc.scope?.ok === true && /^markie-asset:\/\/wd-[0-9a-f]{32}$/.test(ipc.scope.base), JSON.stringify(ipc.scope));
  check("main serves the picture beside it", ipc.beside === 160, String(ipc.beside));
  check("main refuses a ../ picture on that scope", ipc.upward === "refused", String(ipc.upward));
  check("main refuses a symlink out of the folder", ipc.symlink === "refused", String(ipc.symlink));
  check("main refuses an absolute path on that scope", ipc.absolute === "refused", String(ipc.absolute));
  check("main refuses an unknown scope", ipc.unknownScope === "refused", String(ipc.unknownScope));
  check("main refuses a scope for a Markdown file it never granted", ipc.ungrantedMarkdown?.ok === false, JSON.stringify(ipc.ungrantedMarkdown));
  check("main refuses a forged lease and a request naming both", ipc.forgedLease?.ok === false && ipc.bothKeys?.ok === false);
  check("main refuses javascript:, file: and a mail draft with an attachment", ipc.javascript?.ok === false && ipc.file?.ok === false && ipc.attach?.ok === false, JSON.stringify([ipc.javascript, ipc.file, ipc.attach]));
  check("and hands none of them to openExternal", JSON.stringify(await browser.opened()) === JSON.stringify(["https://example.com/hotel"]), JSON.stringify(await browser.opened()));
  await shoot(cdp, "01-make-interactive");
  cdp.close(); browser.close();
  await win.close();

  // ── B. A .wd opened from disk, through its file lease ─────────────────────
  debugPort = await pickPort(); inspectPort = await pickPort();
  win = await launchElectron({ debugPort, args: [".", wdPath, `--user-data-dir=${userDataDir}`, `--inspect=127.0.0.1:${inspectPort}`], env, log: path.join(artifactDir, "electron-b.log") });
  closeWindow = win.close;
  browser = await stubOpenExternal(inspectPort);
  cdp = await waitFor("CDP", () => cdpConnect(`http://127.0.0.1:${debugPort}`), 40000);
  await waitFor("the .wd preview", () => cdp.ev(`!!document.querySelector('.docs-darkmown-preview iframe')`), 40000);
  await waitFor("the .wd picture", async () => (await cdp.inPreview(PREVIEW_REPORT))?.images?.some((image) => image.alt === "The view"), 20000);
  const fromDisk = await cdp.inPreview(PREVIEW_REPORT);
  const toolbar = await cdp.ev(`document.querySelector('.markie-toolbar')?.innerText ?? ''`);
  check("board.wd opens in the document workspace", toolbar.includes("board.wd"), JSON.stringify(toolbar.slice(0, 200)));
  checkPreview(fromDisk, "board.wd");
  await shoot(cdp, "02-wd-from-disk");
  check("nothing reached openExternal in this launch", (await browser.opened()).length === 0);
  cdp.close(); browser.close();

  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\nScreenshots: ${artifactDir}\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((entry) => entry.name).join(", ")}\n`);
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (error) {
  process.stderr.write(`live-docs-wd-check failed: ${error.stack ?? error}\n`);
} finally {
  await closeWindow();
  stopRenderer();
  await Promise.all(tempPaths.map((target) => rm(target, { recursive: true, force: true }).catch(() => {})));
}
process.exit(ok ? 0 : 1);
