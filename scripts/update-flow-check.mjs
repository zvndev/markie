#!/usr/bin/env node
// Does an already-installed Markie actually receive this release?
//
// Publishing latest-mac.yml is the push, but "the feed is correct" and "the app
// on someone's Mac offers the update" are different claims, and only the second
// one matters to the person using it. This downloads the *previous public*
// release from the same URL a user would, runs it against the *live* feed with
// a clean profile, and waits for the update-ready notice to appear on its own.
//
// Nothing is stubbed: real DMG, real signature, real feed, real timer.
//
//   node scripts/update-flow-check.mjs                 # against the live feed
//   node scripts/update-flow-check.mjs --from 0.3.1    # pin the starting version
//
// The app under test runs from a temporary directory with its own user-data
// dir, so it cannot touch an installed Markie or its profile.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `update-flow-${stamp}`);
const children = [];
const tempPaths = [];
const mounted = [];

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

  // The version to start from: whatever the feed said before this release.
  const previousFeed = path.join(root, ".release", target, "previous-latest-mac.yml");
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
  const primary = manifest.platforms.find(
    (p) => p.id === manifest.primaryPlatformId
  );
  const base = manifest.storage.publicBaseUrl.replace(/\/$/, "");
  const feedUrl = `${base}/${primary.feed.path}`;
  const dmgUrl = `${base}/${path.posix.dirname(primary.feed.path)}/Markie-${from}-${primary.arch}.dmg`;
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
  const userDataDir = await mkdtemp(path.join(tmpdir(), "markie-update-profile-"));
  tempPaths.push(workDir, userDataDir);

  // Downloaded from the same public URL a user would get, so this exercises
  // the real artifact rather than something rebuilt locally.
  const dmgPath = path.join(workDir, `Markie-${from}-arm64.dmg`);
  console.log(`  downloading ${dmgUrl}`);
  const dmg = await fetch(dmgUrl);
  if (!dmg.ok) throw new Error(`download failed: ${dmg.status} ${dmgUrl}`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dmgPath, Buffer.from(await dmg.arrayBuffer()));
  const dmgSize = (await stat(dmgPath)).size;
  check(
    `the previous release is still downloadable`,
    dmgSize > 50_000_000,
    `${from} DMG is ${(dmgSize / 1e6).toFixed(1)} MB`
  );

  const mountPoint = path.join(workDir, "mnt");
  await mkdir(mountPoint, { recursive: true });
  await run("hdiutil", [
    "attach",
    dmgPath,
    "-mountpoint",
    mountPoint,
    "-nobrowse",
    "-quiet",
  ]);
  mounted.push(mountPoint);

  const appDir = path.join(workDir, "Applications");
  await mkdir(appDir, { recursive: true });
  await run("ditto", [path.join(mountPoint, "Markie.app"), path.join(appDir, "Markie.app")]);
  await run("hdiutil", ["detach", mountPoint, "-quiet"]);
  mounted.pop();

  const appPath = path.join(appDir, "Markie.app");
  const binary = path.join(appPath, "Contents", "MacOS", "Markie");

  // Gatekeeper's verdict on the copy that is about to run. A build that cannot
  // launch cannot update.
  const gatekeeper = await run("spctl", ["-a", "-vvv", "-t", "install", appPath]).catch(
    (e) => e.message
  );
  check(
    "the previous release is still accepted by Gatekeeper",
    /Notarized Developer ID/.test(gatekeeper),
    gatekeeper.split("\n").find((l) => l.includes("source=")) ?? ""
  );

  const plist = await run("defaults", [
    "read",
    path.join(appPath, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  ]);
  check(
    "the app under test really is the previous version",
    plist.trim() === from,
    `Info.plist reports ${plist.trim()}`
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

  cdp.close();
  console.log(
    `\n  the downloaded update is staged in the test profile and is discarded with it;\n  installing it is the one step left for a person to click.`
  );
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`\nfatal: ${error.message}`);
} finally {
  await cleanup();
}

const passed = checks.filter((c) => c.passed).length;
console.log(`\n${passed}/${checks.length} checks passed`);
console.log(`logs: ${artifactDir}`);
if (failed || passed !== checks.length || checks.length === 0) process.exitCode = 1;
