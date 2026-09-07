#!/usr/bin/env node
// Does a video link alone on its line become a card, in a real window, and
// does the player it opens actually get through the CSP?
//
// The two things a unit test cannot say: whether frame-src in the packaged
// policy lets the player load at all (a refused frame is a blank rectangle
// with no error anywhere a test would look), and whether the card's own click
// survives the editor underneath it, which sees the same press. So this opens
// a document with a video link in it, clicks the card through CDP, listens
// for the browser's own policy-violation event, and reads the serializer and
// the file afterwards to make sure nothing about the document changed.
//
// The card's title and thumbnail come from the network, and this makes no
// promise about the network: those are looked at and reported, never failed.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { startRendererDev } from "./lib/renderer-dev.mjs";
import { launchElectron } from "./lib/electron-window.mjs";

requireElectronConsent("embed-check", import.meta.url);

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "embed-check");
let stopRenderer = () => {};
let closeWindow = async () => {};
const tempPaths = [];
let debugOrigin = "";

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(`  ${passed ? "ok  " : "FAIL"} ${name}\n`);
  if (detail) process.stdout.write(`         ${detail}\n`);
};
const note = (text) => process.stdout.write(`  ..   ${text}\n`);

async function cleanup() {
  await closeWindow();
  stopRenderer();
  for (const p of tempPaths) await rm(p, { recursive: true, force: true }).catch(() => {});
}
// A run killed outright cannot ask the window to quit, but each helper signals
// what it spawned from its own exit handler, which a bare signal would skip.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(1));
}
async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}
async function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
async function cdpConnect() {
  const targets = await (await fetch(`${debugOrigin}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const settle = pending.get(msg.id);
    if (settle) {
      pending.delete(msg.id);
      settle(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const bodyText = `document.querySelector('.markdown-body')?.innerText || ''`;
const cardReport = `(() => {
  const cards = [...document.querySelectorAll('[data-markie-embed]')];
  return cards.map((c) => {
    const button = c.querySelector('[data-markie-embed-card]');
    const frame = c.querySelector('iframe');
    const thumb = c.querySelector('.markie-embed-thumb');
    const r = c.getBoundingClientRect();
    return {
      url: c.getAttribute('data-markie-embed'),
      button: !!button,
      label: button?.getAttribute('aria-label') ?? null,
      title: c.querySelector('.markie-embed-title')?.textContent ?? null,
      host: c.querySelector('.markie-embed-host')?.textContent ?? null,
      thumb: thumb ? { hidden: thumb.hidden, loaded: thumb.complete && thumb.naturalWidth > 0 } : null,
      frame: frame ? frame.getAttribute('src') : null,
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
})()`;

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-embed-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-embed-home-"));
  tempPaths.push(userDataDir, homeDir);
  await mkdir(artifactDir, { recursive: true });

  const docPath = path.join(homeDir, "talks.md");
  const source = [
    "# Talks",
    "",
    "The keynote:",
    "",
    VIDEO,
    "",
    `And a mention of ${VIDEO} inside a sentence, which stays a link.`,
    "",
    "[the same one, with words](https://youtu.be/dQw4w9WgXcQ)",
    "",
  ].join("\n");
  await writeFile(docPath, source, "utf-8");

  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;
  const dev = await startRendererDev({ port: devPort, log: path.join(artifactDir, "vite.log") });
  stopRenderer = dev.stop;
  const win = await launchElectron({
    debugPort,
    args: [".", docPath, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
    log: path.join(artifactDir, "electron.log"),
  });
  closeWindow = win.close;

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  await waitFor("document", async () => (await cdp.ev(bodyText)).includes("keynote"), 40000);
  await waitFor("card", async () => (await cdp.ev(cardReport))?.length >= 1, 20000);
  await new Promise((r) => setTimeout(r, 1500));

  // ── The card ───────────────────────────────────────────────────────────────
  const cards = await cdp.ev(cardReport);
  check("the link alone on its line is one card, and the two in prose are not", cards.length === 1, JSON.stringify(cards));
  const card = cards[0];
  check("it is a play button naming the provider", card?.button === true && card?.label === "Play the video on YouTube", JSON.stringify(card));
  check("it keeps the address it was written with", card?.url === VIDEO, String(card?.url));
  check("no player is loaded before anyone asks for one", card?.frame === null && (await cdp.ev(`document.querySelectorAll('iframe').length`)) === 0);
  check("it is the width of the page and sixteen by nine", card?.width > 300 && Math.abs(card.width / card.height - 16 / 9) < 0.05, `${card?.width}x${card?.height}`);
  check(
    "rich editing stayed on: a video link is not raw HTML to the guard",
    (await cdp.ev(`!!document.querySelector('.ProseMirror[contenteditable="true"]') && !document.querySelector('[data-markie-rich-guard]')`)) === true
  );
  // Reported, not judged: whether the network answered.
  note(`title on the card: ${JSON.stringify(card?.title)}; thumbnail: ${JSON.stringify(card?.thumb)}`);
  const inProse = await cdp.ev(`[...document.querySelectorAll('.markdown-body a')].map((a) => a.textContent)`);
  check("the sentence link and the worded link are still links", Array.isArray(inProse) && inProse.length === 2, JSON.stringify(inProse));
  await shootTo(cdp, "01-card");

  // ── Clicking it ────────────────────────────────────────────────────────────
  // The browser reports a frame the policy refused as an event on the
  // document, and nowhere else. Listen before the click.
  await cdp.ev(`(() => {
    window.__markieCspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__markieCspViolations.push({ directive: e.violatedDirective, blocked: e.blockedURI });
    });
    return true;
  })()`);
  const at = await cdp.ev(`(() => {
    const b = document.querySelector('[data-markie-embed-card]');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("the card is somewhere a pointer can reach", !!at, JSON.stringify(at));
  if (at) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    const opened = await waitFor("player", async () => {
      const [c] = await cdp.ev(cardReport);
      return c?.frame ? c : null;
    }, 8000).catch(() => null);
    check(
      "clicking the card opens the cookie-free player, and only then",
      opened?.frame === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0",
      JSON.stringify(opened)
    );
    await new Promise((r) => setTimeout(r, 2500));
    const violations = await cdp.ev(`window.__markieCspViolations`);
    check("the policy let the player through", Array.isArray(violations) && violations.length === 0, JSON.stringify(violations));
    const frameState = await cdp.ev(`(() => {
      const f = document.querySelector('.markie-embed-frame');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    check("the player has the card's place and size", frameState?.width > 300 && Math.abs(frameState.width / frameState.height - 16 / 9) < 0.05, JSON.stringify(frameState));
    await shootTo(cdp, "02-player");
  }

  // ── The document is untouched ──────────────────────────────────────────────
  const serialized = await cdp.ev(`window.__markieEditor ? window.__markieEditor.storage.markdown.getMarkdown() : ''`);
  check("the serializer still writes the bare address on its own line", serialized.includes(`\n\n${VIDEO}\n\n`), JSON.stringify(serialized).slice(0, 200));
  check("opening the player was not an edit", !serialized.includes("iframe") && !serialized.includes("markie-embed"));
  check("nothing on disk changed", (await readFile(docPath, "utf-8")) === source);

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

async function shootTo(cdp, name) {
  await new Promise((r) => setTimeout(r, 450));
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(artifactDir, `${name}.png`), Buffer.from(shot.data, "base64"));
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stdout.write(`\nembed-check failed: ${err.stack ?? err}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
