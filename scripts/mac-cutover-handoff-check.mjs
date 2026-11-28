#!/usr/bin/env node
// Does an installed Electron Markie on Apple Silicon really become Markie RS
// through Check for Updates? The Mac cutover's one claim that no unit test can
// make, checked on this Mac before anything is public.
//
// It serves, on 127.0.0.1 only, a copy of what mac/ will hold at the cutover:
// the Rust release candidate's arm64 ZIP and DMG plus an Electron x64 ZIP as
// the Intel bridge, with the feed written by the release runner's own code. It
// then runs an Electron 0.9.7 arm64 build against that feed and watches it:
//
//   1. find the update on its own, download the Rust ZIP (and not the x64 one),
//      and raise the update-ready notice naming the release candidate;
//   2. with --install, let Squirrel swap the bundle, and check what is on disk
//      afterwards is Markie RS: not Electron, the release candidate's version,
//      com.zvn.markie signed by the cutover's team;
//   3. see Markie RS start from the swapped bundle.
//
// The Electron build is not the 0.9.7 users have. A shipped build reads its
// feed from inside its signed bundle and has no way to be pointed elsewhere,
// so the check builds 0.9.7 from this checkout (--build) with one addition: the
// test-only override in electron/update-harness.js, which only a build carrying
// the harness marker honours, and only for a loopback URL. Same electron-updater,
// same Squirrel, same signing team: what decides whether the swap works.
//
// Safety:
//   - it refuses to run against an installed Markie (/Applications or
//     ~/Applications), as the source or as the app under test. It runs a copy
//     inside a temporary folder, with a throwaway profile.
//   - Squirrel's install state lives under the bundle id, shared with the real
//     Markie; it is saved before and put back after.
//   - after the swap Markie RS is started by this script with HOME pointed at a
//     throwaway folder, so it cannot read or import the real profile. The
//     in-app "Restart & update" path relaunches through LaunchServices with the
//     real HOME instead, so it needs --install=restart --allow-real-profile.
//
// Usage (once the Rust rc exists; MARKIE_ALLOW_E2E=1 because it opens a window):
//
//   MARKIE_ALLOW_E2E=1 npm run cutover:check -- \
//     --rust-dir ../markie-rs/rust/target/public/0.10.0-rc.1 \
//     --intel-dir dist --build [--from-version 0.9.7] [--install]
//
//   --rust-dir      the Rust release candidate folder (release.json + ZIP + DMG)
//   --intel-dir     a folder with an Electron Markie-<v>-x64.zip (the bridge)
//   --build         build the 0.9.7 arm64 harness app first (dist-harness/)
//   --from-app      or use a harness app built earlier
//   --from-version  the version to update from (default 0.9.7)
//   --install       swap and launch Markie RS (default: stop at update-ready)
//   --install=restart --allow-real-profile   click Restart & update instead
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { requireElectronConsent } from "./lib/e2e-consent.mjs";
import { macCutoverConfig, parseCodesignDetails } from "./lib/mac-cutover.mjs";
import {
  assertHarnessPackage,
  assertSafeAppPath,
  assertSafeSourceApp,
  buildLocalFeed,
  isElectronApp,
  startFeedServer,
} from "./lib/handoff-harness.mjs";

requireElectronConsent("mac-cutover-handoff-check", import.meta.url);

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(path.join(root, "server", "package.json"));
const WebSocket = require("ws");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const artifactDir = path.join(root, ".autoloop", "runs", `mac-cutover-handoff-${stamp}`);
const children = [];
const tempPaths = [];
const SHIPIT_STATE = path.join(process.env.HOME ?? "", "Library/Caches/com.zvn.markie.ShipIt/ShipItState.plist");
let shipItBackup = null;
let feedServer = null;

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? "  ok  " : "  FAIL"} ${name}${detail ? `\n         ${detail}` : ""}\n`);
  return passed;
}

function arg(flag) {
  const exact = process.argv.indexOf(flag);
  if (exact !== -1) return process.argv[exact + 1] ?? null;
  return process.argv.find((value) => value.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null;
}
const has = (flag) => process.argv.some((value) => value === flag || value.startsWith(`${flag}=`));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}: ${out.slice(-800)}`))));
  });
}

// The app writes to a file descriptor, never a pipe this process owns; see
// update-flow-check.mjs for the run that taught that.
function start(command, args, options = {}) {
  const fd = options.log ? openSync(options.log, "a") : "ignore";
  const child = spawn(command, args, { cwd: options.cwd ?? root, env: options.env ?? process.env, stdio: ["ignore", fd, fd] });
  children.push(child);
  if (typeof fd === "number") child.on("exit", () => closeSync(fd));
  return child;
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
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
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
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
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
      pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  return { send, ev, close: () => ws.close() };
}

const plistValue = async (appPath, key) =>
  (await run("plutil", ["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")]).catch(() => "")).trim() || null;

async function runningPid(appPath) {
  const out = await run("bash", ["-lc", `pgrep -f ${JSON.stringify(path.join(appPath, "Contents/MacOS"))} || true`]).catch(() => "");
  return out.trim() ? out.trim().split(/\s+/)[0] : null;
}

async function killStrays(dirs) {
  for (const dir of dirs) {
    const out = await run("bash", ["-lc", `pgrep -f ${JSON.stringify(dir)} || true`]).catch(() => "");
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
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
  await killStrays(tempPaths).catch(() => {});
  await feedServer?.close().catch(() => {});
  // Squirrel's state belongs to the real Markie too: put back what was there.
  rmSync(SHIPIT_STATE, { force: true });
  if (shipItBackup) copyFileSync(shipItBackup, SHIPIT_STATE);
  await Promise.all(tempPaths.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}

async function buildHarnessApp(fromVersion) {
  console.log(`  building the ${fromVersion} arm64 harness app (dist-harness/)`);
  await run("npm", ["run", "build"], { stdio: "inherit" });
  await run(path.join(root, "node_modules/.bin/electron-builder"), [
    "--config",
    "electron-builder.update-harness.cjs",
    "--mac",
    "--arm64",
    "--dir",
    "--publish",
    "never",
  ], { env: { ...process.env, MARKIE_HARNESS_FROM_VERSION: fromVersion } });
  await run("npm", ["run", "native:restore"]).catch(() => {});
  return path.join(root, "dist-harness", "mac-arm64", "Markie.app");
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("the handoff check runs on an Apple Silicon Mac; it tests the arm64 path");
  }
  const manifest = JSON.parse(readFileSync(path.join(root, "server", "download-manifest.json"), "utf8"));
  const cutover = macCutoverConfig(manifest);
  if (!cutover) throw new Error("the release manifest declares no Mac cutover");
  const rustDir = arg("--rust-dir");
  const intelDir = arg("--intel-dir") ?? path.join(root, "dist");
  const fromVersion = arg("--from-version") ?? "0.9.7";
  const installMode = has("--install") ? (arg("--install") === "restart" ? "restart" : "quit") : null;
  if (!rustDir) throw new Error("pass --rust-dir <rust/target/public/<rc version>>");
  if (installMode === "restart" && !has("--allow-real-profile")) {
    throw new Error(
      "--install=restart lets Squirrel relaunch Markie RS through LaunchServices with your real HOME, so it reads your real profile; " +
        "pass --allow-real-profile to accept that, or use --install to have this script start it with a throwaway HOME"
    );
  }
  await mkdir(artifactDir, { recursive: true });

  const workDir = await mkdtemp(path.join(tmpdir(), "markie-cutover-"));
  const profileDir = await mkdtemp(path.join(tmpdir(), "markie-cutover-profile-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "markie-cutover-home-"));
  tempPaths.push(workDir, profileDir, homeDir);

  // 1. The local feed, from the Rust rc and an Electron x64 build.
  const feed = await buildLocalFeed({ rustDir: path.resolve(rustDir), intelDir: path.resolve(intelDir), outDir: path.join(workDir, "feed"), cutoverVersion: cutover.version });
  const target = feed.version;
  const rustZip = `Markie-${target}-arm64.zip`;
  console.log(`  feed: Markie RS ${target} for arm64, ${feed.intelZip.name} as the Intel bridge`);
  feedServer = await startFeedServer({ root: path.join(workDir, "feed") });
  const feedUrl = `${feedServer.url}/mac/`;
  console.log(`  serving ${feedUrl}\n`);

  // 2. The app to update from: a harness build, copied into the work folder.
  const sourceApp = assertSafeSourceApp(arg("--from-app") ?? (has("--build") ? await buildHarnessApp(fromVersion) : path.join(root, "dist-harness", "mac-arm64", "Markie.app")));
  const appDir = path.join(workDir, "Applications");
  await mkdir(appDir, { recursive: true });
  await run("ditto", [sourceApp, path.join(appDir, "Markie.app")]);
  const appPath = assertSafeAppPath(path.join(appDir, "Markie.app"), { workDir });
  const asar = createRequire(import.meta.url)("@electron/asar");
  assertHarnessPackage(asar.extractFile(path.join(appPath, "Contents/Resources/app.asar"), "package.json").toString("utf8"), fromVersion);
  check("the app under test is the harness build of the version updated from", (await plistValue(appPath, "CFBundleShortVersionString")) === fromVersion, `${appPath}`);
  const signed = parseCodesignDetails(await run("codesign", ["-dv", "--verbose=2", appPath]).catch((e) => e.message));
  check(
    "it is signed as com.zvn.markie by the cutover's team, so Squirrel can accept Markie RS",
    signed.identifier === cutover.bundleId && signed.teamId === cutover.teamId,
    `Identifier=${signed.identifier} TeamIdentifier=${signed.teamId}`
  );
  check("it is Electron, for arm64", isElectronApp(appPath) && /arm64/.test(await run("lipo", ["-archs", path.join(appPath, "Contents/MacOS/Markie")]).catch(() => "")));

  if (existsSync(SHIPIT_STATE)) {
    shipItBackup = path.join(workDir, "ShipItState.plist.saved");
    copyFileSync(SHIPIT_STATE, shipItBackup);
  }

  // 3. Launch against the local feed, with a throwaway profile.
  const debugPort = await pickPort();
  start(path.join(appPath, "Contents/MacOS/Markie"), [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`], {
    log: path.join(artifactDir, "electron.log"),
    env: { ...process.env, MARKIE_UPDATE_HARNESS_FEED_URL: feedUrl },
  });
  const cdp = await waitFor("the Electron window", () => cdpConnect(`http://127.0.0.1:${debugPort}`), 60000);
  await cdp.send("Runtime.enable");
  await waitFor("renderer boot", () => cdp.ev("document.readyState === 'complete'"), 60000);
  check(`Electron ${fromVersion} launches`, true);

  // Nothing is prompted: the app checks ten seconds after launch on its own.
  const status = () => cdp.ev("window.electronAPI?.updateStatus?.() ?? 'no-api'");
  const sawState = await waitFor("the app to notice the update", async () => {
    const s = await status();
    return ["available", "downloading", "ready"].includes(s) ? s : null;
  }, 180000);
  check("it finds the update by itself", !!sawState, `reached "${sawState}"`);
  const toast = await waitFor("the update-ready notice", async () =>
    (await cdp.ev("document.body.innerText.split('\\n').find(l => l.includes('Update ready')) ?? null")) || null, 600000);
  check("the update-ready notice names the release candidate", toast.includes(target), `notice reads ${JSON.stringify(toast)}`);
  const asked = feedServer.requests.map((r) => r.path);
  check("it downloaded the Rust ZIP", asked.includes(`/mac/${rustZip}`), asked.join(", "));
  check("it did not download the Intel bridge", !asked.some((p) => p.endsWith("-x64.zip")));

  if (!installMode) {
    cdp.close();
    console.log("\n  stopped at update-ready. Pass --install to let Squirrel swap in Markie RS and start it.");
    return;
  }

  // 4. The swap.
  if (installMode === "restart") {
    await cdp.ev("[...document.querySelectorAll('button')].find(b => /Restart/i.test(b.textContent))?.click(), true");
  } else {
    // Squirrel installs a downloaded update when the app exits, without a
    // relaunch, so this script starts Markie RS itself with a throwaway HOME.
    // Give Squirrel a moment to take the ZIP from electron-updater first.
    await new Promise((r) => setTimeout(r, 5000));
    for (const child of children) child.kill("SIGTERM");
  }
  cdp.close();
  const swapped = await waitFor("the bundle to be replaced", async () => {
    const v = await plistValue(appPath, "CFBundleShortVersionString");
    return v === target ? v : null;
  }, 180000);
  check("Squirrel replaced the bundle with the release candidate", swapped === target, `Info.plist now reports ${swapped}`);
  check("what is on disk is Markie RS, not Electron", !isElectronApp(appPath));
  const after = parseCodesignDetails(await run("codesign", ["-dv", "--verbose=2", appPath]).catch((e) => e.message));
  check("it is com.zvn.markie signed by the cutover's team", after.identifier === cutover.bundleId && after.teamId === cutover.teamId, `Identifier=${after.identifier} TeamIdentifier=${after.teamId}`);
  check("its signature is intact", await run("codesign", ["--verify", "--deep", "--strict", appPath]).then(() => true, () => false));

  // 5. Markie RS starts from the swapped bundle.
  if (installMode === "quit") {
    const executable = await plistValue(appPath, "CFBundleExecutable");
    start(path.join(appPath, "Contents/MacOS", executable ?? "Markie"), [], {
      log: path.join(artifactDir, "markie-rs.log"),
      env: { ...process.env, HOME: homeDir, MARKIE_UPDATE_HARNESS_FEED_URL: "" },
    });
  }
  const pid = await waitFor("Markie RS to be running", () => runningPid(appPath), 120000);
  await new Promise((r) => setTimeout(r, 10000));
  check(
    installMode === "restart" ? "Squirrel relaunched it as Markie RS, and it stays up" : "Markie RS starts from the swapped bundle and stays up",
    !!pid && (await runningPid(appPath)) === pid,
    `pid ${pid}, version ${swapped}`
  );
}

let cleaning = null;
const cleanupOnce = () => (cleaning ??= cleanup());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
  process.on(signal, () => {
    cleanupOnce().finally(() => process.exit(130));
  });
}
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
