#!/usr/bin/env node
// Put Kirby's own Mac on the public Markie or on his private super-nightly.
//
// A private build only ever updates from the private gateway, and a public
// build never looks there, so neither can move itself to the other lane. Both
// are com.zvn.markie from the same team and live at /Applications/Markie.app;
// each keeps its own profile (public: ~/Library/Application Support/markie;
// private: .../Markie Nightly for the Rust app, .../Markie Super-nightly for an
// Electron super-nightly), so swapping the app swaps which profile opens and
// loses nothing.
//
//   npm run markie:use -- public    newest stable, downloaded the way a user gets it
//   npm run markie:use -- private   highest super-nightly built on this Mac: on the
//                                   Mac that is the Rust app (docs/PRIVATE_RELEASES.md)
//   add --dry-run to stage and verify the build without touching the app
//
// The swap: verify the new app (signature, Gatekeeper, bundle id, version and
// the SHA-512 its feed names, except for an unpacked private build, which was
// verified when it was built), ask Markie to quit and wait
// for it, move the installed app into "Markie Install Backups", copy the new
// one in, and relaunch it. A Markie that will not quit is left running and the
// swap is abandoned: quitting is how open documents get saved.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const APP = "/Applications/Markie.app";
const BUNDLE_ID = "com.zvn.markie";
const BACKUPS = path.join(homedir(), "Library", "Application Support", "Markie Install Backups");
const manifest = JSON.parse(readFileSync(path.join(root, "server", "download-manifest.json"), "utf8"));
const FEED_BASE = manifest.storage.publicBaseUrl.replace(/\/$/, "");

const say = (line) => process.stdout.write(`[markie-lane] ${line}\n`);
const fail = (line) => {
  process.stderr.write(`[markie-lane] ${line}\n`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const plist = (app, key) => run("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, path.join(app, "Contents", "Info.plist")]).trim();

function verifyApp(app, { expectVersion, lane }) {
  const id = plist(app, "CFBundleIdentifier");
  if (id !== BUNDLE_ID) fail(`${app} is ${id}, not ${BUNDLE_ID}`);
  const version = plist(app, "CFBundleShortVersionString");
  if (expectVersion && version !== expectVersion) fail(`${app} is ${version}, expected ${expectVersion}`);
  const isPrivate = /-super-nightly\.\d+$/.test(version);
  if ((lane === "private") !== isPrivate) fail(`${app} is ${version}, which is not a ${lane} build`);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const gate = spawnSync("spctl", ["-a", "-t", "exec", "-vv", app], { encoding: "utf8" });
  if (gate.status !== 0) fail(`Gatekeeper refuses ${app}: ${gate.stderr.trim()}`);
  say(`verified ${version}: signature, Gatekeeper (${gate.stderr.match(/source=([^\n]+)/)?.[1] ?? "accepted"})`);
  return version;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) fail(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The newest stable for this Mac's architecture, from the same feed installed
// apps read, checked against the SHA-512 that feed names.
async function stagePublic(work) {
  const feed = (await fetchBuffer(`${FEED_BASE}/mac/latest-mac.yml?t=${Date.now()}`)).toString("utf8");
  const version = feed.match(/^version:\s*(\S+)/m)?.[1];
  if (!version) fail("the stable feed names no version");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `Markie-${version}-${arch}.dmg`;
  const entry = feed.split(/\n(?=\s*-\s+url:)/).find((block) => block.includes(`url: ${name}`));
  const sha512 = entry?.match(/sha512:\s*(\S+)/)?.[1];
  if (!sha512) fail(`the stable feed lists no SHA-512 for ${name}`);
  say(`downloading ${name}`);
  const bytes = await fetchBuffer(`${FEED_BASE}/mac/${name}`);
  const actual = createHash("sha512").update(bytes).digest("base64");
  if (actual !== sha512) fail(`${name} does not match the SHA-512 in the stable feed`);
  const dmg = path.join(work, name);
  writeFileSync(dmg, bytes);
  const mount = path.join(work, "mount");
  mkdirSync(mount);
  run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount]);
  const app = path.join(mount, "Markie.app");
  if (!existsSync(app)) fail(`${name} holds no Markie.app`);
  return { app, version, cleanup: () => spawnSync("hdiutil", ["detach", mount, "-quiet"]) };
}

const SUPER_NIGHTLY = /^(\d+)\.(\d+)\.(\d+)-super-nightly\.(\d+)$/;

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.match(SUPER_NIGHTLY).slice(1).map(Number));
  return x.map((n, i) => n - y[i]).find((d) => d !== 0) ?? 0;
}

// The rust/markie-rs checkout: MARKIE_RS_DIR, or this repo's worktree on that branch.
function rustCheckout() {
  if (process.env.MARKIE_RS_DIR) return process.env.MARKIE_RS_DIR;
  const list = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const entry = (list.stdout ?? "").split("\n\n").find((block) => block.split("\n").includes("branch refs/heads/rust/markie-rs"));
  return entry?.match(/^worktree (.+)$/m)?.[1] ?? null;
}

// Every super-nightly built on this Mac, highest version first. The Rust app's
// release ZIPs sit in the rust/markie-rs checkout beside the feed
// nightly-publish.mjs published for them (rust/target/nightly/<version>/).
// .release/private-artifacts holds unpacked apps: Electron ones from
// scripts/private-release.mjs, and an earlier Rust one installed from there.
function privateBuilds() {
  const builds = [];
  const rs = rustCheckout();
  const nightly = rs ? path.join(rs, "rust", "target", "nightly") : null;
  for (const version of nightly && existsSync(nightly) ? readdirSync(nightly) : []) {
    const zip = path.join(nightly, version, `Markie-${version}-arm64.zip`);
    const feed = path.join(nightly, version, "super-nightly-mac.yml");
    if (SUPER_NIGHTLY.test(version) && existsSync(zip) && existsSync(feed)) builds.push({ version, kind: "Rust", zip, feed });
  }
  const electron = path.join(root, ".release", "private-artifacts");
  for (const version of existsSync(electron) ? readdirSync(electron) : []) {
    const app = path.join(electron, version, "mac-arm64", "Markie.app");
    if (!SUPER_NIGHTLY.test(version) || !existsSync(app)) continue;
    builds.push({ version, kind: plist(app, "CFBundleExecutable") === "markie-rs" ? "Rust" : "Electron", app });
  }
  return builds.sort((a, b) => compareVersions(b.version, a.version));
}

// The highest super-nightly here. A lower one would only update itself back up
// to the feed's version, so the newest file on disk is not the one to take.
function stagePrivate(work) {
  const [build] = privateBuilds();
  if (!build) fail("no super-nightly built on this Mac; build the Rust app with rust/scripts/nightly-release.sh on rust/markie-rs");
  say(`highest super-nightly here: ${build.version} (${build.kind})`);
  if (build.app) return { app: build.app, version: build.version, cleanup: () => {} };
  const feed = readFileSync(build.feed, "utf8");
  if (feed.match(/^version:\s*(\S+)/m)?.[1] !== build.version) fail(`${build.feed} does not name ${build.version}`);
  const sha512 = feed.match(/^sha512:\s*(\S+)/m)?.[1];
  if (!sha512 || createHash("sha512").update(readFileSync(build.zip)).digest("base64") !== sha512) {
    fail(`${build.zip} does not match the SHA-512 in ${build.feed}`);
  }
  const out = path.join(work, "rust");
  mkdirSync(out);
  run("ditto", ["-x", "-k", build.zip, out]);
  const app = path.join(out, "Markie.app");
  if (!existsSync(app)) fail(`${build.zip} holds no Markie.app`);
  return { app, version: build.version, cleanup: () => {} };
}

// The installed app's own executable (Markie for Electron, markie-rs for the
// Rust app), anchored so Electron's helpers under Contents/Frameworks and tools
// run from inside the bundle do not count as Markie still running.
function runningMarkie(exe) {
  const out = spawnSync("pgrep", ["-f", `^${APP}/Contents/MacOS/${exe}( |$)`], { encoding: "utf8" });
  return out.stdout.trim().split("\n").filter(Boolean);
}

// Both apps treat this quit as ⌘Q: Electron runs its close flush, and the Rust
// app's quit hook flushes pending saves the same way.
async function quitMarkie() {
  if (!existsSync(APP)) return;
  const exe = plist(APP, "CFBundleExecutable");
  if (runningMarkie(exe).length === 0) return;
  say("asking Markie to quit");
  spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
  for (let i = 0; i < 60; i += 1) {
    if (runningMarkie(exe).length === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("Markie did not quit within 30 seconds; nothing was changed. Quit it yourself and run this again.");
}

async function main() {
  const lane = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (lane !== "public" && lane !== "private") fail("usage: npm run markie:use -- public|private [--dry-run]");
  if (process.platform !== "darwin") fail("this switches the macOS app only");
  const before = existsSync(APP) ? plist(APP, "CFBundleShortVersionString") : null;
  const work = mkdtempSync(path.join(tmpdir(), "markie-lane-"));
  let staged = null;
  // fail() exits the process, which skips finally blocks; this still runs.
  process.on("exit", () => {
    staged?.cleanup();
    rmSync(work, { recursive: true, force: true });
  });
  staged = lane === "public" ? await stagePublic(work) : stagePrivate(work);
  verifyApp(staged.app, { expectVersion: staged.version, lane });
  if (dryRun) {
    say(`dry run: would replace ${before ?? "nothing"} with ${staged.version}; nothing changed`);
    return;
  }
  if (before === staged.version) {
    say(`already on ${before}; nothing to do`);
    return;
  }
  await quitMarkie();
  if (existsSync(APP)) {
    const backup = path.join(BACKUPS, `${new Date().toISOString().slice(0, 19).replace(/:/g, "")}-${before}`);
    mkdirSync(backup, { recursive: true });
    renameSync(APP, path.join(backup, "Markie.app"));
    say(`moved ${before} to ${backup}`);
  }
  run("ditto", [staged.app, APP]);
  verifyApp(APP, { expectVersion: staged.version, lane });
  // The agent shell exports ELECTRON_RUN_AS_NODE, and `open` passes the
  // environment through, so Markie would start as plain Node and exit.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync("open", ["-a", APP], { env });
  say(`now on ${staged.version} (${lane}); was ${before ?? "not installed"}`);
}

await main();
