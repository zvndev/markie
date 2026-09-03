// Does hovering a link actually show a card, in a real window?
//
// Every part of this is invisible to a unit test: main has to be the one
// fetching (the renderer's connect-src is locked), the card has to be
// positioned against a real anchor's rectangle, and the picture has to survive
// the trip through main as a data URI and back into an <img> the CSP allows.
//
// The page under test is served from this script, on loopback, which the
// preview module refuses by design. MARKIE_E2E=1 is what opens that door, and
// only for this.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

requireElectronConsent("link-preview-check");

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const artifactDir = path.join(root, ".autoloop", "runs", "link-preview-check");
const children = [];
const tempPaths = [];
let servers = [];
let debugOrigin = "";

const checks = [];
const check = (name, passed, detail = "") => {
  checks.push({ name, passed });
  process.stdout.write(`  ${passed ? "ok  " : "FAIL"} ${name}\n`);
  if (detail) process.stdout.write(`         ${detail}\n`);
};

function start(command, args, options = {}) {
  const out = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", out, out],
  });
  children.push(child);
  if (options.log) child.on("exit", () => closeSync(out));
  return child;
}

async function cleanup() {
  for (const server of servers) await new Promise((r) => server.close(r));
  for (const child of children) safeKill(child);
  await new Promise((r) => setTimeout(r, 400));
  for (const p of tempPaths) await rm(p, { recursive: true, force: true }).catch(() => {});
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

function releaseStaleDevLock() {
  const lock = path.join(root, ".next", "dev", "lock");
  let holders = "";
  try {
    holders = execFileSync("lsof", ["-t", lock], { encoding: "utf-8" });
  } catch {
    return; // lsof exits non-zero when nobody holds it, which is the good case
  }
  for (const line of holders.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let command = "";
    try {
      command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
    } catch {
      continue;
    }
    if (!command.includes("next-server")) continue;
    try {
      process.kill(pid, "SIGKILL");
      process.stdout.write(`  ..   cleared a leftover next-server holding the dev lock (pid ${pid})\n`);
    } catch {
      /* already gone */
    }
  }
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function cdpConnect() {
  const list = await fetch(`${debugOrigin}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
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
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      ?.result?.value;
  return { send, ev, close: () => ws.close() };
}

// A real 240x120 PNG, so the card has something to draw and the screenshot is
// worth looking at.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAAFo0lEQVR4nO3Zf2iUdRzA8e/z3O73uROnCUIU4eY/GdnMFWVaTvJHZmGz0tKFokLoH2qbm0SEstKi0hEIafNnpSKpiZIjl2D4cxOngqnlKAhCTd3d7nb33D1P3J7bOHfbUDFln96vv27Pns/3+x1779mNaZZlKUAK/X4fALibCBqi5HS8Kph95b6eBLhz59f2t1/whIYoBA1RCBqiEDREIWiIQtAQhaAhCkFDFIKGKAQNUQgaohA0RCFoiELQEIWgIQpBQxSChigEDVEIGqIQNEQhaIhC0BCFoCEKQUMUgoYoBA1RCBqiEDREIWiIQtAQhaAhCkFDFIKGKAQNUQgaohA0RCFoiELQEIWgIQpBQxSChigEDVEIGqIQNEQhaIhC0BCFoCEKQUMUgoYoBI3/cdD11Xm3fnP+IMe00Z7bXWHueO8d7HXr6/+nOg4PgU/oC38lv/m59Xan5kzwqV6rVx9ehpzbHSgv8T/+SI6lVNm6cChivj8tMCCoO3PUx9taGi8l3h7jfe1Zt2WpT3e0HDpr1FfnFc6/2j9XXz4zEPRpf1w27UWCPq3ToH19wWSfz63VLAy+89kNpdTCV32F+c6gX1+1q6W2Id7dVPb6A4L6R6UBn0eLtFoV68OJpFo+IxD0a0ZSLf4qdDVk2gezb+54XV+dt78hNqLAufbHaOFg5xODczb91FpTG+1y3/rqvC0HooX5zlyftnp3pLYh3unw6AVBu3LU6abEiu0tk59yV77uvxY2Nx2Invo9MaifvmZ+7ssfXn/3Je+YimsD++rzJvoOnTXsqfKp/r3HY7uPxIqHuSaOcCmlykr8nQbtO1fvisws9tpBuHLUtbA1feWNhwc6NiwK1jb8091U9vpLpvr3HIvtPBx75Wl3eYnfNNW+E7E9x2JTnvEsmOz7YHO4y6/O7VTfHWyt3hWpW9GvpOr659+b2yr71tRGu9zX6Ugf78EBjs3vpY6XeXj0jqAtS9WejCml9p2Il0/1J5LqoQcc9qe8bs2hq4OnjU9m9dlSFy1bF+qYKhriXLo+1VDdqXiy7Rk68lFXp0H7eiZNUzt+Sb1jafo72cer9TCVvX7REGdFTerK3uPxxVP8lqWWbkydZ+fh1v0NqaUy6e0XTFOdaUokTWUkrTNNCdNSHle3++p6+nh/Xk4fD70yaLO9vHgi9ZSa9UVzzLB0TRXmO5OmKv869GSBs7TYO6nIvaQtqdTDrH0TXVf2d96hdx7MZiRUc8RK79vjVPb62s2BtV3XlLKSpgpFrcyIc31ax7iRTP+ExAxlpnfudt/s46H3/VHocKhRQ1O/08cPdx09ZzRcNMYOS3343FDX3AnePl5tS1nw5G/G4nWhUY+lrttOXkwUt902dpjbTq3T4E0H0tK1ZSZl624qe/0j54xxw1NXxg13Hf3VaLyUvqFkpGfRFL9SqazzB6UeupOKUu/4e9blvtnHyzw8escTOmaoFwvds8d5myNW5fqw26mWzQi8OdqTNNXSDeFQ1KprjG+v7Kvr6ssfIh1TVVtbVs4KvPWCp+FiIt72h1zV1pbMwcwtTlww1szPnbO6OXv37qay11+xvaWqNPDGKE8kZlXUhL0urao0MP15Tyhq2e+Fln0bXjUv92rIbLyUHulBD6ftpIfD497QrPYHVMHsK/doT+BuO7+2v/2C/xRCFIKGKAQNUQgaohA0RCFoiELQEIWgIQpBQxSChigEDVEIGqIQNEQhaIhC0BCFoCEKQUMUgoYoBA1RCBqiEDREIWiIQtAQhaAhCkFDFIKGKAQNUQgaohA0RCFoiELQEIWgIQpBQxSChigEDVEIGqIQNEQhaIhC0BCFoCEKQUMUgoYoBA1RCBqiEDREIWiIQtAQhaAhCkFDFIKGKAQNUQgaohA0RCFoiKJZlnW/zwDcNTyhIQpBQ0nyL4nILjzGMte4AAAAAElFTkSuQmCC",
  "base64"
);

const cardReport = `(() => {
  const card = document.querySelector('[data-markie-link-card]');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  const img = card.querySelector('img');
  return {
    text: card.innerText,
    width: Math.round(r.width),
    onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0,
    image: img ? { scheme: (img.src || '').split(':')[0], loaded: img.complete && img.naturalWidth > 0 } : null,
  };
})()`;

// A real hover: CDP mouse events, not a synthetic React event, because the
// listener is on the scroll container and the rectangle has to be the anchor's.
async function hoverText(cdp, text) {
  const at = await cdp.ev(`(() => {
    const a = [...document.querySelectorAll('.markdown-body a')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!at) throw new Error(`no link reading ${text}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, buttons: 0 });
  return at;
}

async function main() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-preview-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-preview-home-"));
  tempPaths.push(userDataDir, homeDir);
  await mkdir(artifactDir, { recursive: true });

  // ── The site being previewed ───────────────────────────────────────────────
  const sitePort = await pickPort();
  let pageRequests = 0;
  const site = createServer((req, res) => {
    if (req.url === "/card.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    if (req.url === "/post") {
      pageRequests++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head>
        <meta property="og:title" content="The Cormorant Papers">
        <meta property="og:description" content="A short account of what happened on the estuary.">
        <meta property="og:site_name" content="Estuary Review">
        <meta property="og:image" content="http://127.0.0.1:${sitePort}/card.png">
      </head><body>body text nobody should see</body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => site.listen(sitePort, "127.0.0.1", r));
  servers.push(site);
  const siteOrigin = `http://127.0.0.1:${sitePort}`;

  const docPath = path.join(homeDir, "notes.md");
  await writeFile(
    docPath,
    [
      "# Notes",
      "",
      `Read [the cormorant piece](${siteOrigin}/post) when you get a moment.`,
      "",
      "And [a local one](spec.pdf) that goes nowhere near the web.",
      "",
    ].join("\n"),
    "utf-8"
  );
  await writeFile(path.join(homeDir, "spec.pdf"), "%PDF-1.4\n");

  releaseStaleDevLock();
  const devPort = await pickPort();
  const debugPort = await pickPort();
  const devOrigin = `http://localhost:${devPort}`;
  debugOrigin = `http://127.0.0.1:${debugPort}`;

  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    log: path.join(artifactDir, "next.log"),
  });
  await waitFor("dev server", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", docPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    {
      env: { ...process.env, HOME: homeDir, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: path.join(artifactDir, "electron.log"),
    }
  );

  const cdp = await waitFor("CDP", cdpConnect, 40000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Input.enable").catch(() => {});
  await cdp.send("Page.navigate", { url: devOrigin });
  await waitFor("boot", () => cdp.ev("document.readyState === 'complete'"), 40000);
  try {
    await waitFor(
      "document",
      async () => (await cdp.ev(`document.querySelector('.markdown-body')?.innerText || ''`)).includes("cormorant"),
      40000
    );
  } catch (err) {
    // What the window actually shows beats guessing at why it does not.
    const seen = await cdp.ev(`document.body.innerText.slice(0, 800)`).catch(() => "(unreadable)");
    await writeFile(path.join(artifactDir, "window.txt"), String(seen), "utf-8");
    throw new Error(`${err.message}; window said: ${String(seen).slice(0, 300)}`);
  }

  // ── Nothing happens on open ────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 2000));
  check(
    "opening a document fetches nothing",
    pageRequests === 0,
    `${pageRequests} request(s) to the site`
  );
  check("and shows no card", (await cdp.ev(cardReport)) === null);

  // ── Hovering a web link ────────────────────────────────────────────────────
  await hoverText(cdp, "the cormorant piece");
  const card = await waitFor("card", async () => await cdp.ev(cardReport), 20000);

  check("hovering a link shows a card", !!card, JSON.stringify(card));
  check("it carries the page's title", card.text.includes("The Cormorant Papers"), card.text);
  check("and its summary", card.text.includes("estuary"), card.text);
  // Case-insensitively: the label is styled uppercase, and innerText reports
  // what the CSS made of it.
  check("and the site's name", /estuary review/i.test(card.text), card.text);
  check("and nothing out of the page's body", !card.text.includes("nobody should see"));
  check(
    "the picture is on screen, inlined by main rather than fetched here",
    card.image?.loaded === true && card.image?.scheme === "data",
    JSON.stringify(card.image)
  );
  check("the card is inside the window", card.onScreen === true, JSON.stringify(card));
  check("the site was asked exactly once", pageRequests === 1, String(pageRequests));

  await cdp.send("Page.captureScreenshot", { format: "png" }).then(async (shot) => {
    await writeFile(path.join(artifactDir, "01-card.png"), Buffer.from(shot.data, "base64"));
  });

  // ── Moving away ────────────────────────────────────────────────────────────
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
  await waitFor("card gone", async () => (await cdp.ev(cardReport)) === null, 8000);
  check("moving off the link takes the card away", true);

  // ── A link that never goes out to the web ──────────────────────────────────
  await hoverText(cdp, "a local one");
  await new Promise((r) => setTimeout(r, 2000));
  check("a local link asks the network for nothing", pageRequests === 1, String(pageRequests));
  check("and shows no card", (await cdp.ev(cardReport)) === null);

  // ── Hovering again is answered from memory ─────────────────────────────────
  await hoverText(cdp, "the cormorant piece");
  await waitFor("card again", async () => await cdp.ev(cardReport), 20000);
  check("hovering again does not ask the site twice", pageRequests === 1, String(pageRequests));

  cdp.close();
  const failed = checks.filter((c) => !c.passed);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.stdout.write(`failed: ${failed.map((c) => c.name).join(", ")}\n`);
  return failed.length === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  process.stdout.write(`\nlink-preview-check failed: ${err.message}\n`);
} finally {
  await cleanup();
}
process.exit(ok ? 0 : 1);
