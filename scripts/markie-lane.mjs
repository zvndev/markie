#!/usr/bin/env node
// Put Kirby's own Mac on the public Markie or on his private super-nightly.
//
// A private build only ever updates from the private gateway, and a public
// build never looks there, so neither can move itself to the other lane. Both
// are com.zvn.markie from the same team and live at /Applications/Markie.app;
// each keeps its own profile (public: ~/Library/Application Support/markie,
// private: .../Markie Super-nightly), so swapping the app swaps which profile
// opens and loses nothing.
//
//   npm run markie:use -- public    newest stable, downloaded the way a user gets it
//   npm run markie:use -- private   newest super-nightly built on this Mac
//   add --dry-run to stage and verify the build without touching the app
//
// The swap: verify the new app (signature, Gatekeeper, bundle id, version and,
// for public, the SHA-512 the stable feed names), ask Markie to quit and wait
// for it, move the installed app into "Markie Install Backups", copy the new
// one in, and relaunch it. A Markie that will not quit is left running and the
// swap is abandoned: quitting is how open documents get saved.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// The newest super-nightly built here by scripts/private-release.mjs, which
// verified it before it was published.
function stagePrivate() {
  const dir = path.join(root, ".release", "private-artifacts");
  const builds = existsSync(dir)
    ? readdirSync(dir)
        .filter((v) => /-super-nightly\.\d+$/.test(v) && existsSync(path.join(dir, v, "mac-arm64", "Markie.app")))
        .sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    : [];
  if (builds.length === 0) fail(`no private build in ${dir}; build one with scripts/private-release.mjs first`);
  const version = builds[0];
  return { app: path.join(dir, version, "mac-arm64", "Markie.app"), version, cleanup: () => {} };
}

function runningMarkie() {
  const out = spawnSync("pgrep", ["-f", `${APP}/Contents/MacOS/Markie$`], { encoding: "utf8" });
  return out.stdout.trim().split("\n").filter(Boolean);
}

async function quitMarkie() {
  if (runningMarkie().length === 0) return;
  say("asking Markie to quit");
  spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
  for (let i = 0; i < 60; i += 1) {
    if (runningMarkie().length === 0) return;
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
  const staged = lane === "public" ? await stagePublic(work) : stagePrivate();
  try {
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
  } finally {
    staged.cleanup();
    rmSync(work, { recursive: true, force: true });
  }
  // The agent shell exports ELECTRON_RUN_AS_NODE, and `open` passes the
  // environment through, so Markie would start as plain Node and exit.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync("open", ["-a", APP], { env });
  say(`now on ${staged.version} (${lane}); was ${before ?? "not installed"}`);
}

await main();
