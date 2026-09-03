#!/usr/bin/env node
// Does an already-installed Markie actually receive this release?
//
// Publishing latest-mac.yml is the push, but "the feed is correct" and "the app
// on someone's Mac offers the update" are different claims, and only the second
// one matters to the person using it. This downloads the *previous public*
// release from the same URL a user would, runs it against the *live* feed with
// a clean profile, and waits for the update-ready notice to appear on its own.
//
// Nothing is stubbed: real artifact, real signature, real feed, real timer.
//
// It runs on macOS and on Windows. The assertions are the same on both, because
// they are the same claim; only obtaining the previous release, judging its
// signature, and reading the version back off disk differ, and those four live
// in scripts/lib/update-targets.mjs. Windows has no updater hardware of its own
// here, so it runs on a GitHub Windows runner, which is a real Windows.
//
//   node scripts/update-flow-check.mjs                 # against the live feed
//   node scripts/update-flow-check.mjs --from 0.3.1    # pin the starting version
//
// The app under test runs from a temporary directory with its own user-data
// dir, so it cannot touch an installed Markie or its profile.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { targetFor } from "./lib/update-targets.mjs";

// A real window on a real machine is a deliberate act; see the helper.
requireElectronConsent("update-flow-check", import.meta.url);


// fileURLToPath, not URL.pathname: on Windows a file URL's pathname is
// "/C:/..." and resolving that produces a path nothing exists at.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `update-flow-${stamp}`);
const children = [];
const tempPaths = [];
const mounted = [];
// Set once the run has asked the updater to swap the app, so cleanup knows it
// has shared state to tidy rather than guessing.
let installed = false;

// At module scope because cleanup runs from signal handlers, outside main().
// `run` is a function declaration below, so it is hoisted by the time this is
// called rather than by the time it is built.
const platform = targetFor(process.platform, {
  run: (...a) => run(...a),
  mkdir,
  mkdtemp,
  stat,
  tmpdir,
  mounted,
});

await mkdir(artifactDir, { recursive: true });

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(
    `${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`
  );
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} exited ${code}: ${out.slice(-800)}`))
    );
  });
}

// The app under test writes straight to a file descriptor, never to a pipe
// this process owns.
//
// It used to get a pipe. When this script died without running its cleanup, the
// read end went with it, and the orphaned app hit EPIPE on its next log line —
// which, mid-quitAndInstall, put a JavaScript error dialog on screen and left a
// real signed Markie running loose, holding a half-finished Squirrel install.
// A test harness must not be able to do that to the machine it runs on.
function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["ignore", fd, fd],
  });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
}

async function cleanup() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.killed) return resolve();
          child.once("exit", resolve);
          child.kill();
          setTimeout(resolve, 2000);
        })
    )
  );
  await platform.killStrays(tempPaths).catch(() => {});
  // A run that installs can leave the installer's own state behind pointing at
  // a copy this script is about to delete. The installed Markie shares that
  // file; a stale entry is its problem, not ours to leave lying around.
  if (installed) {
    const statePath = platform.installerStatePath();
    if (statePath) await rm(statePath, { force: true }).catch(() => {});
  }
  for (const point of mounted) {
    await run("hdiutil", ["detach", point, "-force"]).catch(() => {});
  }
  await Promise.all(
    tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {}))
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
    await new Promise((r) => setTimeout(r, 500));
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

async function cdpConnect(origin) {
  const targets = await (await fetch(`${origin}/json`)).json();
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

async function main() {
  const manifest = JSON.parse(
    await readFile(path.join(root, "server", "download-manifest.json"), "utf-8")
  );
  const target = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf-8")
  ).version;

  const { writeFile } = await import("node:fs/promises");

  // The version to start from: whatever the feed said before this release. The
  // saved feed is named after the platform's own feed file, so a Windows run
  // does not read the macOS one and try to update from a version that never
  // shipped there.
  const previousFeedName =
    process.platform === "win32" ? "previous-latest.yml" : "previous-latest-mac.yml";
  const previousFeed = path.join(root, ".release", target, previousFeedName);
  const from =
    arg("--from") ??
    (await readFile(previousFeed, "utf-8").catch(() => ""))
      .match(/^version:\s*(\S+)/m)?.[1];
  if (!from) {
    throw new Error(
      `cannot tell which version to update from; pass --from <version>`
    );
  }
  if (from === target) {
    throw new Error(`--from ${from} is the version being released`);
  }

  // Read the bucket and feed path out of the manifest rather than repeating
  // them here: it is the single source of truth for the stable channel, and a
  // check that hardcodes the URL would keep passing after the real one moved.
  const entry = manifest.platforms.find((p) => p.id === platform.platformId);
  if (!entry) throw new Error(`no ${platform.platformId} entry in the download manifest`);
  const base = manifest.storage.publicBaseUrl.replace(/\/$/, "");
  const feedUrl = `${base}/${entry.feed.path}`;
  const artifactUrl = platform.artifactUrl(base, entry.feed.path, from, entry.arch);
  console.log(`  updating Markie ${from} -> ${target}`);
  console.log(`  feed: ${feedUrl}\n`);

  // The live feed is what installed apps read. If this is wrong, nothing else
  // in this script matters.
  const feed = await (await fetch(feedUrl, { cache: "no-store" })).text();
  const feedVersion = feed.match(/^version:\s*(\S+)/m)?.[1];
  check(
    "the public feed offers the new version",
    feedVersion === target,
    `feed says ${feedVersion}`
  );

  const workDir = await mkdtemp(path.join(tmpdir(), "markie-update-"));
  const userDataDir = await platform.profileDir();
  tempPaths.push(workDir, userDataDir);

  // Downloaded from the same public URL a user would get, so this exercises
  // the real artifact rather than something rebuilt locally.
  const artifactPath = path.join(workDir, path.posix.basename(artifactUrl));
  console.log(`  downloading ${artifactUrl}`);
  const download = await fetch(artifactUrl);
  if (!download.ok) throw new Error(`download failed: ${download.status} ${artifactUrl}`);
  await writeFile(artifactPath, Buffer.from(await download.arrayBuffer()));
  const size = (await stat(artifactPath)).size;
  check(
    `the previous release is still downloadable`,
    size > platform.minBytes,
    `${from} ${platform.artifactLabel} is ${(size / 1e6).toFixed(1)} MB`
  );

  const { appPath, binary } = await platform.stage({ artifactPath, workDir });

  const trust = await platform.trust({ appPath });
  check(trust.label, trust.ok, trust.detail);

  const onDisk = await platform.versionOnDisk({ appPath });
  check(
    "the app under test really is the previous version",
    onDisk === from,
    `the copy on disk reports ${onDisk}`
  );

  const debugPort = await pickPort();
  const debugOrigin = `http://127.0.0.1:${debugPort}`;
  start(
    binary,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`],
    { log: path.join(artifactDir, "app.log") }
  );

  const cdp = await waitFor(
    "the old app's window",
    () => cdpConnect(debugOrigin),
    60000
  );
  await cdp.send("Runtime.enable");
  await waitFor(
    "renderer boot",
    () => cdp.ev("document.readyState === 'complete'"),
    60000
  );
  check("the previous release launches", true);

  // From here on nothing is prompted. The app checks on its own ten seconds
  // after launch, downloads in the background, and raises the notice itself —
  // which is exactly what happens on someone's Mac.
  const status = () =>
    cdp.ev("window.electronAPI?.updateStatus?.() ?? 'no-api'");

  const seen = new Set();
  const sawState = await waitFor(
    "the app to notice the update",
    async () => {
      const s = await status();
      if (s && !seen.has(s)) {
        seen.add(s);
        console.log(`         updater state: ${s}`);
      }
      return s === "available" || s === "downloading" || s === "ready" ? s : null;
    },
    180000
  );
  check(
    "the installed app finds the update by itself",
    !!sawState,
    `reached "${sawState}" without being asked`
  );

  // The toast the user actually sees and clicks.
  const toast = await waitFor(
    "the update-ready notice",
    async () => {
      const text = await cdp.ev(
        "document.body.innerText.includes('Update ready') ? document.body.innerText.split('\\n').find(l => l.includes('Update ready')) : null"
      );
      return text || null;
    },
    600000
  );
  check(
    "the update-ready notice appears with the new version",
    toast.includes(target),
    `notice reads ${JSON.stringify(toast)}`
  );

  const button = await cdp.ev(
    "[...document.querySelectorAll('button')].map(b => b.textContent.trim()).find(t => /Restart/i.test(t)) ?? null"
  );
  check(
    "the install button is offered",
    !!button,
    `button reads ${JSON.stringify(button)}`
  );

  check(
    "the updater reports the download as finished",
    (await status()) === "ready",
    `updateStatus() = ${await status()}`
  );

  if (!process.argv.includes("--install")) {
    cdp.close();
    console.log(
      `\n  stopped before installing. Pass --install to click Restart & update\n  and verify the bundle is actually replaced.`
    );
    return;
  }

  // The last step, and the one that used to be taken on trust: click the button
  // and confirm the app on disk is genuinely replaced. Squirrel swaps the
  // bundle and relaunches, so the proof is the version in Info.plist changing
  // under a path we control.
  installed = true;
  const clicked = await cdp.ev(
    "[...document.querySelectorAll('button')].find(b => /Restart/i.test(b.textContent))?.click(), true"
  );
  check("the install button can be clicked", clicked === true);
  cdp.close();

  const installedVersion = await waitFor(
    "the installed app to be replaced",
    async () => {
      const v = await platform.versionOnDisk({ appPath });
      return v === target ? v : null;
    },
    180000
  );
  check(
    "Restart & update replaces the installed app",
    installedVersion === target,
    `the copy on disk now reports ${installedVersion}`
  );

  // It relaunches itself afterwards, which is the difference between "the files
  // changed" and "the user got their app back".
  const relaunched = await waitFor(
    "the new version to relaunch",
    () => platform.runningPid({ appPath }),
    120000
  );
  check(
    "the updated app relaunches on its own",
    !!relaunched,
    `running as pid ${relaunched}`
  );
}

// A `finally` only covers a normal throw. This script launches a real, signed
// Markie that will fight for an update on its own, so every way out has to take
// it with us — including the one that actually happened, where a closed stdout
// (piping this script through `head`) killed the parent on SIGPIPE and left the
// app running.
let cleaning = null;
const cleanupOnce = () => (cleaning ??= cleanup());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
  process.on(signal, () => {
    cleanupOnce().finally(() => process.exit(130));
  });
}
// Last resort. Synchronous only: nothing async runs after this point.
process.on("exit", () => {
  for (const child of children) {
    try {
      if (child.exitCode === null && !child.killed) process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nfatal: ${error.message}`);
} finally {
  await cleanupOnce();
}

const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
console.log(`logs: ${artifactDir}`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
