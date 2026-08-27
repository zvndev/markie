#!/usr/bin/env node
// Drives the two-level Projects destination in a real window, against a COPY
// of a real registry, and writes screenshots plus measured contrast evidence.
//
// Two rules this script exists to keep:
//   * never the live database. --profile is copied to a temp directory before
//     Electron is allowed near it, and the copy loses its cookies and web
//     storage first, so the run is signed out and cannot sync anything.
//   * measured, not eyeballed. CONSTITUTION asks for both color modes legible;
//     every sample below is read out of the live DOM with getComputedStyle.
//
// Usage:
//   MARKIE_ALLOW_E2E=1 node scripts/projects-shots.mjs \
//     --profile <dir with registry.db> [--out shots-v4]
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { safeKill } from "./lib/safe-kill.mjs";

requireElectronConsent("projects-shots", import.meta.url);

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const profileSource = flag("--profile");
const outDir = path.resolve(root, flag("--out", "shots-v4"));
const debugPort = Number(flag("--port", "9333"));

if (!profileSource || !existsSync(path.join(profileSource, "registry.db"))) {
  console.error("Pass --profile <dir containing registry.db>. It is copied, never opened in place.");
  process.exit(2);
}

const children = [];
const temps = [];
let devOrigin = "";

// `next dev` spawns a server of its own, and killing only the direct child
// leaves that server holding .next/dev/lock so every later run fails to start.
// Each child therefore leads its OWN process group, and cleanup kills exactly
// that group by negative pid. Never a pattern match: `pkill -f "next dev"` on
// a developer's machine kills every other project's dev server too, which is
// the kind of tidying that ruins somebody's afternoon.
function start(command, cmdArgs, options = {}) {
  const child = spawn(command, cmdArgs, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
function stop(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    safeKill(child, "SIGKILL");
  }
}
async function cleanup() {
  for (const child of children) stop(child);
  await Promise.all(temps.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}
process.on("exit", () => {
  for (const child of children) stop(child);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    for (const child of children) stop(child);
    process.exit(1);
  });
}

async function waitFor(label, fn, timeoutMs = 60000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function cdpConnect() {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("devtools://") && t.url.startsWith(devOrigin)
  );
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on("message", (message) => {
    const msg = JSON.parse(message);
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
        else if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

// ── Contrast, read out of the live DOM ──
// Inlined rather than imported because it runs inside the renderer.
const CONTRAST_FN = `
  const rgba = (raw) => {
    if (!raw || raw === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = raw.match(/rgba?\\(([^)]+)\\)/);
    if (m) {
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    const hex = raw.match(/^#([0-9a-f]{6})$/i);
    if (hex) return {
      r: parseInt(hex[1].slice(0, 2), 16),
      g: parseInt(hex[1].slice(2, 4), 16),
      b: parseInt(hex[1].slice(4, 6), 16),
      a: 1,
    };
    // Tailwind 4 resolves an opacity modifier (text-foreground/90) through
    // color-mix, and Chromium reports the result as oklab. Reading that as
    // "unparseable" scored every one of them 0:1, which looks like a finding
    // and is really a broken instrument.
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const gamma = (n) => {
      const v = Math.max(0, Math.min(1, n));
      return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    };
    const oklab = raw.match(/^oklab\\(([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/);
    if (oklab) {
      const L = parseFloat(oklab[1]), A = parseFloat(oklab[2]), B = parseFloat(oklab[3]);
      const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
      const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
      const s2 = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
      return {
        r: clamp(gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2) * 255),
        g: clamp(gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2) * 255),
        b: clamp(gamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s2) * 255),
        a: oklab[4] ? parseFloat(oklab[4]) : 1,
      };
    }
    const srgb = raw.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)$/);
    if (srgb) {
      return {
        r: clamp(parseFloat(srgb[1]) * 255),
        g: clamp(parseFloat(srgb[2]) * 255),
        b: clamp(parseFloat(srgb[3]) * 255),
        a: srgb[4] ? parseFloat(srgb[4]) : 1,
      };
    }
    return null;
  };
  const blend = (fg, bg) => ({
    r: Math.round(fg.r * (fg.a ?? 1) + bg.r * (1 - (fg.a ?? 1))),
    g: Math.round(fg.g * (fg.a ?? 1) + bg.g * (1 - (fg.a ?? 1))),
    b: Math.round(fg.b * (fg.a ?? 1) + bg.b * (1 - (fg.a ?? 1))),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const c = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const pageBg = () => {
    const b = rgba(getComputedStyle(document.body).backgroundColor);
    return b && b.a > 0 ? b : { r: 255, g: 255, b: 255, a: 1 };
  };
  const bgOf = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = rgba(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) {
          let out = bg;
          // Unwind the translucent layers over the first opaque one, in the
          // order the compositor puts them down.
          for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
          return out;
        }
        stack.push(bg);
      }
      node = node.parentElement;
    }
    let out = pageBg();
    for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
    return out;
  };
  const sample = (label, selector) => {
    const el = document.querySelector(selector);
    if (!el) return { label, selector, missing: true };
    const style = getComputedStyle(el);
    const fgRaw = rgba(style.color);
    const bg = bgOf(el);
    const fg = fgRaw && (fgRaw.a ?? 1) < 1 ? blend(fgRaw, bg) : fgRaw;
    // A font at 14px bold or 18.66px counts as large text under WCAG, where
    // the floor is 3.0 rather than 4.5. Nothing here relies on that, but the
    // threshold has to be honest about which one it applied.
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= 18.66 || (size >= 14 && weight >= 700);
    const value = fg ? ratio(fg, bg) : 0;
    return {
      label,
      selector,
      color: style.color,
      background: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')',
      fontSize: style.fontSize,
      large,
      contrast: Number(value.toFixed(2)),
      threshold: large ? 3 : 4.5,
      passes: value >= (large ? 3 : 4.5),
    };
  };
`;

const SAMPLES = [
  ["Projects title", "header h1"],
  ["search scope badge", "header .markie-overlay-field span"],
  ["search input placeholder", 'header input[aria-label^="Search"]'],
  ["header stat value", "header .tabular-nums"],
  ["header note", "header .text-muted"],
  ["auto folders heading", "#markie-auto-folders"],
  ["auto folder chip name", "[data-markie-folder-card] span"],
  ["auto folder chip count", "[data-markie-folder-card] span:nth-child(2)"],
  ["projects heading", "#markie-projects-heading"],
  ["project card name", '[data-markie-project-card]:not([data-markie-project-card="Unfiled"]) button'],
  ["Unfiled card name", '[data-markie-project-card="Unfiled"] button'],
  ["project card meta", "[data-markie-project-card] span"],
  ["New project button", "#markie-projects-heading ~ span button"],
];

const PROJECT_SAMPLES = [
  ["breadcrumb project name", 'nav[aria-label="Breadcrumb"] h1'],
  ["breadcrumb parent link", 'nav[aria-label="Breadcrumb"] button:nth-of-type(2)'],
  ["block card title", "[data-markie-project-block] h3"],
  ["block card count", "[data-markie-project-block] h3 + span"],
  ["file row name", "[data-markie-project-file] button span"],
  ["file row directory", "[data-markie-project-file] button span:nth-child(2)"],
  ["file row time", "[data-markie-project-file] > span"],
  ["loose run caption", "[data-markie-project-loose] span"],
];

const FOLDER_SAMPLES = [
  ["folder name", 'nav[aria-label="Breadcrumb"] h1'],
  ["folder rule", "header .text-muted"],
  ["group project name", "[data-markie-folder-group] button"],
  ["group file name", "[data-markie-folder-group] button[data-markie-project-file] span"],
  ["group file directory", "[data-markie-folder-group] button[data-markie-project-file] span:nth-child(2)"],
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const logDir = path.join(root, ".autoloop", "runs", "projects-shots");
  await mkdir(logDir, { recursive: true });

  // The copy, made before Electron ever sees the path, minus everything that
  // could carry a signed-in session into the run.
  const profile = await mkdtemp(path.join(tmpdir(), "markie-projects-shots-"));
  // --keep leaves the COPY on disk so its registry can be inspected after the
  // run (schema version, decisions). It never affects what the run touches:
  // the source profile is still only ever read.
  if (!args.includes("--keep")) temps.push(profile);
  else console.log(`profile copy kept at ${profile}`);
  await cp(profileSource, profile, { recursive: true });
  for (const name of ["Cookies", "Cookies-journal", "Local Storage", "Session Storage", "Network Persistent State", "Preferences"]) {
    await rm(path.join(profile, name), { recursive: true, force: true });
  }

  const devPort = await pickPort();
  devOrigin = `http://localhost:${devPort}`;
  start(path.join(root, "node_modules", ".bin", "next"), ["dev", "--turbopack", "--port", String(devPort)], {
    log: path.join(logDir, "next.log"),
  });
  await waitFor("Next dev renderer", async () => !!(await fetch(devOrigin).catch(() => null)), 90000);

  start(
    path.join(root, "node_modules", ".bin", "electron"),
    [".", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`],
    {
      env: { ...process.env, NODE_ENV: "development", MARKIE_E2E: "1", MARKIE_DEV_URL: devOrigin },
      log: path.join(logDir, "electron.log"),
    }
  );

  const cdp = await waitFor("Electron CDP target", cdpConnect, 60000);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete' && !!document.body"));

  const report = { profile: profileSource, modes: {} };

  const setMode = async (mode) => {
    await cdp.ev(`localStorage.setItem("markie.colormode.v1", ${JSON.stringify(mode)}); location.reload();`);
    await waitFor("reload", () => cdp.ev("document.readyState === 'complete' && !!document.querySelector('.markie-activity-bar')"));
    await waitFor(
      "theme applied",
      () => cdp.ev(`document.documentElement.classList.contains("dark") === ${mode === "dark"}`)
    );
  };
  const setSize = async (width) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 860,
      deviceScaleFactor: 2,
      mobile: false,
    });
  };
  const shot = async (name) => {
    await cdp.send("Page.bringToFront");
    const png = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(outDir, `${name}.png`);
    await writeFile(file, Buffer.from(png.data, "base64"));
    return file;
  };
  const diagnose = async (label) => {
    const state = await cdp.ev(
      `(() => ({
        rail: [...document.querySelectorAll('.markie-activity-bar button')].map((b) => b.getAttribute('aria-label')),
        overlay: !!document.querySelector('[role="dialog"]'),
        projectsView: !!document.querySelector('[data-markie-projects-view]'),
        status: document.querySelector('[role="status"]')?.textContent ?? null,
        text: (document.body.innerText || '').slice(0, 400),
      }))()`
    ).catch(() => null);
    console.error(`\n[${label}] ${JSON.stringify(state, null, 2)}`);
  };
  // Idempotent on purpose. The rail toggles: clicking Projects while Projects
  // is showing takes you back to the panel you had, so "click it" is only safe
  // once you know you are not already there.
  const openProjects = async () => {
    await waitFor("rail", () => cdp.ev(`!!document.querySelector('button[aria-label^="Projects"]')`));
    const already = await cdp.ev(`!!document.querySelector('[data-markie-projects-view]')`);
    if (!already) {
      await cdp.ev(`document.querySelector('button[aria-label^="Projects"]').click()`);
    }
    try {
      await waitFor("projects index", () => cdp.ev("!!document.querySelector('[data-markie-projects-index]')"), 120000);
    } catch (error) {
      await diagnose("openProjects");
      throw error;
    }
  };
  const backToIndex = async () => {
    await cdp.ev(`document.querySelector('button[aria-label="Back to all projects"]')?.click()`);
    await waitFor("index", () => cdp.ev("!!document.querySelector('[data-markie-projects-index]')"));
  };
  const measure = async (samples) =>
    cdp.ev(`(() => { ${CONTRAST_FN} return ${JSON.stringify(samples)}.map(([l, s]) => sample(l, s)); })()`);
  const overflow = async () =>
    cdp.ev(
      `(() => ({
        docWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
        widest: [...document.querySelectorAll('[data-markie-projects-view] *')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible')
          .slice(0, 5)
          .map((el) => (el.getAttribute('data-markie-project-card') || el.className || el.tagName).toString().slice(0, 60)),
      }))()`
    );

  const shots = [];
  for (const mode of ["dark", "light"]) {
    await setMode(mode);
    report.modes[mode] = { widths: {} };
    for (const width of [1280, 900]) {
      await setSize(width);
      await openProjects();
      await new Promise((r) => setTimeout(r, 600));
      shots.push(await shot(`index-${mode}-${width}`));
      const at = { index: { contrast: await measure(SAMPLES), overflow: await overflow() } };

      // Into the first project card that is a real project. Unfiled sorts by
      // recency like everything else and is often the newest thing on a busy
      // machine, but it is the pile Markie could not place, so a screenshot of
      // it says nothing about how a project reads.
      const opened = await cdp.ev(
        `(() => {
          const b = document.querySelector('[data-markie-project-card]:not([data-markie-project-card="Unfiled"]) button');
          if (!b) return null;
          const n = b.getAttribute('aria-label');
          b.click();
          return n;
        })()`
      );
      await waitFor("project level", () => cdp.ev("!!document.querySelector('[data-markie-projects-detail]')"));
      await new Promise((r) => setTimeout(r, 400));
      shots.push(await shot(`project-${mode}-${width}`));
      at.project = {
        opened,
        contrast: await measure(PROJECT_SAMPLES),
        overflow: await overflow(),
      };
      await backToIndex();

      // And into the widest built-in folder, which has the most projects in it.
      await cdp.ev(`document.querySelector('[data-markie-folder-card="week"]')?.click()`);
      await waitFor("folder level", () => cdp.ev("!!document.querySelector('[data-markie-projects-folder]')"));
      await new Promise((r) => setTimeout(r, 400));
      shots.push(await shot(`folder-${mode}-${width}`));
      at.folder = { contrast: await measure(FOLDER_SAMPLES), overflow: await overflow() };
      await backToIndex();

      report.modes[mode].widths[width] = at;
    }
    // The narrowest supported window, checked for overflow only.
    await setSize(700);
    await openProjects();
    await new Promise((r) => setTimeout(r, 400));
    shots.push(await shot(`index-${mode}-700`));
    report.modes[mode].widths[700] = { index: { overflow: await overflow() } };
  }

  await writeFile(path.join(outDir, "contrast.json"), `${JSON.stringify(report, null, 2)}\n`);

  const failures = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      for (const s of node) {
        if (s.missing) failures.push(`${trail}: no element for ${s.selector}`);
        else if (!s.passes) failures.push(`${trail}: ${s.label} ${s.contrast}:1 (needs ${s.threshold})`);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "overflow" && v?.overflows) failures.push(`${trail}: horizontal overflow (${v.docWidth} > ${v.viewport})`);
        else if (k === "contrast") walk(v, trail);
        else if (v && typeof v === "object") walk(v, `${trail}/${k}`);
      }
    }
  };
  walk(report.modes, "");

  console.log(`\nshots: ${outDir}`);
  for (const file of shots) console.log(`  ${file}`);
  console.log(`\nevidence: ${path.join(outDir, "contrast.json")}`);
  if (failures.length) {
    console.log("\nFAILURES");
    for (const f of failures) console.log(`  ${f}`);
  } else {
    console.log("\nEvery sample passes its WCAG threshold, in both modes, at every width.");
  }
  await cleanup();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup();
  process.exit(1);
});
