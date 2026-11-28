// The bridge: an installed Electron Markie super-nightly updates itself into the Rust app.
//
//   MARKIE_ELECTRON_CHECKOUT=<a zvndev/markie checkout with `npm ci` done in . and server/> \
//     node --test rust/scripts/bridge.test.mjs
//
// These tests drive Electron Markie's own code: electron-updater as its
// package-lock pins it, and the gateway from server/src/private-releases.ts.
// They prove everything about the hand-over that can be proved without a
// signed build and a live publish. What they cannot prove is listed in
// docs/rust-port/NIGHTLY.md, "The bridge".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  APP_NAME, BUNDLE_ID, BUNDLE_NAME, FEED_NAME, GATEWAY_ORIGIN, IDENTITY, LANE_PREFIX, LAST_ELECTRON_SUPER_NIGHTLY, TEAM_ID,
  artifactName, createFeed, feedText, publishFiles, systemTools, verifyRelease, versionAbove,
} from "./nightly-publish.mjs";
import { infoPlist, plistXml } from "./mac-info-plist.mjs";

const checkout = process.env.MARKIE_ELECTRON_CHECKOUT;
const updaterDir = checkout && path.join(checkout, "node_modules", "electron-updater");
const gatewayFile = checkout && path.join(checkout, "server", "src", "private-releases.ts");
const ready = !!checkout && existsSync(path.join(updaterDir, "package.json")) && existsSync(gatewayFile) && existsSync(path.join(checkout, "server", "node_modules", "hono"));
const needs = { skip: (!ready && "set MARKIE_ELECTRON_CHECKOUT to a zvndev/markie checkout with its dependencies installed") || (process.platform !== "darwin" && "needs macOS") };

const VERSION = "0.10.0-super-nightly.1", COMMIT = "a".repeat(40);
const sha = (data) => createHash("sha512").update(data).digest("base64");
const bearer = { authorization: "Bearer synthetic-owner-token" };
// The feed Electron Markie's own publisher wrote for its last super-nightly
// (scripts/private-release.mjs, through js-yaml), with a synthetic hash.
const ELECTRON_FEED = `version: 0.9.8-super-nightly.2
files:
  - url: Markie-0.9.8-super-nightly.2-arm64.zip
    sha512: ${sha("synthetic electron zip")}
    size: 112694292
path: Markie-0.9.8-super-nightly.2-arm64.zip
sha512: ${sha("synthetic electron zip")}
releaseDate: '2026-11-24T17:59:58.201Z'
`;

/** electron-updater's generic provider, set up as electron/private-release.js sets it up. */
function electronProvider(serve) {
  const require = createRequire(path.join(updaterDir, "package.json"));
  const { GenericProvider } = require("./out/providers/GenericProvider.js");
  const { findFile } = require("./out/providers/Provider.js");
  const { MacUpdater } = require("./out/MacUpdater.js");
  const semver = createRequire(path.join(updaterDir, "package.json"))("semver");
  const requested = [];
  const provider = new GenericProvider(
    { provider: "generic", url: `${GATEWAY_ORIGIN}${LANE_PREFIX}`, channel: "super-nightly", requestHeaders: bearer, useMultipleRangeRequest: false },
    { channel: "super-nightly", isAddNoCacheQuery: false },
    { platform: "darwin", isUseMultipleRangeRequest: false, executor: { request: async (options) => { requested.push(options); return serve(options); } } },
  );
  return { provider, requested, findFile, MacUpdater, semver, version: require("./package.json").version };
}

/** A release folder as nightly-release.sh leaves it: the ZIP of a Markie bundle. Not signed. */
function release(version = VERSION) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-bridge-test-")));
  const output = path.join(root, "out"), app = path.join(root, "source", BUNDLE_NAME);
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  mkdirSync(output);
  writeFileSync(path.join(app, "Contents", "Info.plist"), plistXml(infoPlist("nightly", version)));
  const binary = path.join(app, "Contents", "MacOS", infoPlist("nightly", version).CFBundleExecutable);
  writeFileSync(binary, `#!/bin/sh\necho "${APP_NAME} ${version} (${BUNDLE_ID}) ${COMMIT}"\n`);
  chmodSync(binary, 0o755);
  writeFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "icon");
  const zip = path.join(output, artifactName(version));
  assert.equal(spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]).status, 0);
  const settings = { version, apiOrigin: GATEWAY_ORIGIN, gitCommit: COMMIT, channel: "super-nightly", output };
  return { root, output, zip, settings, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Real ditto, plutil and the fixture binary; scripted codesign, spctl and stapler. */
const signedTools = {
  run(command, args, options) {
    const display = `Identifier=${BUNDLE_ID}\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded\nAuthority=${IDENTITY}\nTeamIdentifier=${TEAM_ID}\n`;
    if (command === "/usr/bin/codesign") return { ok: true, stdout: "", stderr: args.includes("--display") ? display : "" };
    if (command === "/usr/sbin/spctl" || command === "/usr/bin/xcrun") return { ok: true, stdout: "", stderr: "" };
    return systemTools.run(command, args, options);
  },
};

test("electron-updater asks for the feed this publisher writes, and reads it as an update", needs, async () => {
  const data = Buffer.from("synthetic rust zip");
  const ours = feedText(VERSION, sha(data), data.length, "2026-11-25T10:00:00.000Z");
  const e = electronProvider(async () => ours);
  const info = await e.provider.getLatestVersion();
  // The one request it makes is for the Mac feed of channel super-nightly, with the owner's token.
  assert.equal(e.requested.length, 1);
  assert.equal(String(e.requested[0].protocol + "//" + e.requested[0].hostname + e.requested[0].path), `${GATEWAY_ORIGIN}${LANE_PREFIX}${FEED_NAME}`);
  assert.deepEqual(info, {
    version: VERSION,
    files: [{ url: artifactName(VERSION), sha512: sha(data), size: data.length }],
    path: artifactName(VERSION),
    sha512: sha(data),
    releaseDate: "2026-11-25T10:00:00.000Z",
  });
  // Field for field what it reads from a feed Electron Markie's own publisher wrote.
  const electron = createRequire(path.join(updaterDir, "package.json"))("js-yaml").load(ELECTRON_FEED);
  assert.deepEqual(Object.keys(info), Object.keys(electron));
  assert.deepEqual(Object.keys(info.files[0]), Object.keys(electron.files[0]));
  assert.equal(typeof info.files[0].size, typeof electron.files[0].size);

  // The file it will download: the arm64 ZIP, under the lane's prefix, which
  // is the only prefix the installed app's request guard lets through.
  const files = e.MacUpdater.filterFilesForArch(e.provider.resolveFiles(info), true);
  const zip = e.findFile(files, "zip", ["pkg", "dmg"]);
  assert.equal(zip.url.href, `${GATEWAY_ORIGIN}${LANE_PREFIX}${artifactName(VERSION)}`);
  assert.ok(zip.url.href.startsWith(`${GATEWAY_ORIGIN}/private-releases/super-nightly/`));
  assert.equal(zip.info.sha512, sha(data));
  assert.match(e.version, /^6\./, "electron-updater 6, as Markie's package-lock pins it");
});

test("the installed Electron build sees the Rust version as newer, by electron-updater's own comparison", needs, () => {
  const { semver } = electronProvider(async () => "");
  // AppUpdater.isUpdateAvailable: not equal, and gt(latest, current). allowDowngrade is off in a private build.
  const update = (latest, current) => !semver.eq(semver.parse(latest), semver.parse(current)) && semver.gt(semver.parse(latest), semver.parse(current));
  assert.equal(update("0.10.0-super-nightly.1", LAST_ELECTRON_SUPER_NIGHTLY), true);
  assert.equal(update("0.10.0-super-nightly.1", "0.9.8-super-nightly.1"), true);
  assert.equal(update("0.10.0-super-nightly.2", "0.10.0-super-nightly.1"), true);
  assert.equal(update("0.10.0-super-nightly.10", "0.10.0-super-nightly.9"), true, "build numbers compare as numbers");
  // And back: an Electron super-nightly with a higher version is an update for either app. That is the roll back.
  assert.equal(update("0.10.1-super-nightly.1", "0.10.0-super-nightly.9"), true);
  // Never the other way.
  assert.equal(update(LAST_ELECTRON_SUPER_NIGHTLY, "0.10.0-super-nightly.1"), false);
  assert.equal(update("0.9.9-super-nightly.1", "0.10.0-super-nightly.1"), false);
  // This repo's own ordering agrees with semver on every pair of this shape.
  const versions = ["0.9.8-super-nightly.1", "0.9.8-super-nightly.2", "0.9.8-super-nightly.10", "0.9.9-super-nightly.0", "0.10.0-super-nightly.0", "0.10.0-super-nightly.1", "0.10.0-super-nightly.11", "0.10.1-super-nightly.1", "1.0.0-super-nightly.0"];
  for (const a of versions) for (const b of versions) assert.equal(versionAbove(a, b), semver.gt(a, b), `${a} > ${b}`);
});

test("published by this publisher to the real gateway code, the feed and ZIP come back to the owner as Electron expects", needs, async () => {
  const { createPrivateReleaseGateway } = await import(pathToFileURL(gatewayFile).href);
  const data = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-bridge-gateway-")));
  const r = release();
  try {
    chmodSync(data, 0o700);
    const publishKey = randomBytes(32).toString("base64url");
    const gateway = createPrivateReleaseGateway({
      enabled: true, root: data, ownerId: "synthetic-owner", authOrigin: "https://trusted-auth.example", publishKey,
      // Markie Cloud's session check, standing in: the owner's token, and nobody else's.
      fetch: async (_url, init) => {
        const id = new Headers(init.headers).get("authorization") === bearer.authorization ? "synthetic-owner" : "someone-else";
        return Response.json({ user: { id, emailVerified: true }, session: { userId: id, expiresAt: new Date(Date.now() + 60000).toISOString() } });
      },
    });
    const toGateway = (url, init) => { assert.ok(url.startsWith(GATEWAY_ORIGIN + LANE_PREFIX), url); return gateway.request(url.slice(GATEWAY_ORIGIN.length), init); };

    // An Electron super-nightly is already on the lane, as on the real gateway today.
    const electronZip = Buffer.from("synthetic electron zip"), electronName = "Markie-0.9.8-super-nightly.2-arm64.zip";
    const put = (name, body) => gateway.request(LANE_PREFIX + name, { method: "PUT", headers: { "x-markie-publish-key": publishKey, "x-markie-sha512": sha(body), "content-length": String(body.length) }, body });
    assert.equal((await put(electronName, electronZip)).status, 201);
    assert.equal((await put(FEED_NAME, Buffer.from(ELECTRON_FEED.replaceAll("112694292", String(electronZip.length))))).status, 200);

    // The Rust build is published over it with this repo's publisher, unchanged gateway.
    createFeed(r.settings);
    const verified = verifyRelease(r.settings, signedTools);
    const result = await publishFiles(r.settings, verified, publishKey, toGateway);
    assert.deepEqual(result.uploaded.map((u) => [u.name, u.status]), [[artifactName(VERSION), 201], [FEED_NAME, 200]]);
    // It lands in the lane's own folder beside the Electron build, which stays there for a roll back.
    assert.deepEqual(readdirSync(data).sort(), [electronName, artifactName(VERSION), FEED_NAME].sort());
    assert.equal(statSync(path.join(data, artifactName(VERSION))).size, statSync(r.zip).size);

    // What the installed Electron app then does: its provider reads the feed with its token...
    const e = electronProvider(async (options) => {
      const response = await gateway.request(options.path, { headers: options.headers });
      assert.equal(response.status, 200);
      return response.text();
    });
    e.provider.setRequestHeaders(bearer);
    const info = await e.provider.getLatestVersion();
    assert.equal(info.version, VERSION);
    const zip = e.findFile(e.MacUpdater.filterFilesForArch(e.provider.resolveFiles(info), true), "zip", ["pkg", "dmg"]);
    // ...and downloads the ZIP, whose SHA-512 is the feed's (electron-updater checks exactly this).
    const download = await gateway.request(zip.url.pathname, { headers: bearer });
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(sha(bytes), zip.info.sha512);
    assert.equal(bytes.length, zip.info.size);
    assert.deepEqual(bytes, readFileSync(r.zip));
    // No blockmap is published and none is needed: a private build turns differential download off.
    assert.equal((await gateway.request(`${zip.url.pathname}.blockmap`, { headers: bearer })).status, 404);
    // Anyone else, and anyone signed out, still gets nothing.
    for (const headers of [{}, { authorization: "Bearer someone-elses-token" }]) {
      assert.equal((await gateway.request(LANE_PREFIX + FEED_NAME, { headers })).status, 404);
      assert.equal((await gateway.request(zip.url.pathname, { headers })).status, 404);
    }
    // The access proof the Electron app re-checks every 30 seconds is untouched.
    assert.deepEqual(await (await gateway.request("/private-releases/access", { headers: bearer })).json(), { channel: "super-nightly", authorized: true, userId: "synthetic-owner" });
  } finally { r.cleanup(); rmSync(data, { recursive: true, force: true }); }
});

test("the ZIP unpacks to what Squirrel.Mac looks for: one application bundle with Markie's bundle id", { skip: process.platform !== "darwin" && "needs macOS" }, () => {
  const r = release();
  const unpacked = mkdtempSync(path.join(tmpdir(), "markie-bridge-unpack-"));
  try {
    // Squirrel.Mac unpacks with ditto, then walks the folder (skipping hidden
    // files and the insides of packages) for the first application bundle
    // whose bundle identifier is the running app's.
    assert.equal(spawnSync("/usr/bin/ditto", ["-x", "-k", r.zip, unpacked]).status, 0);
    const found = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const item = path.join(dir, name);
        if (!statSync(item).isDirectory()) continue;
        if (name.endsWith(".app")) {
          const id = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(item, "Contents", "Info.plist")], { encoding: "utf8" });
          const type = spawnSync("/usr/bin/plutil", ["-extract", "CFBundlePackageType", "raw", "-o", "-", path.join(item, "Contents", "Info.plist")], { encoding: "utf8" });
          if (id.stdout.trim() === BUNDLE_ID && type.stdout.trim() === "APPL") found.push(path.relative(unpacked, item));
          continue; // a package: its insides are not searched
        }
        walk(item);
      }
    };
    walk(unpacked);
    assert.deepEqual(found, [BUNDLE_NAME]);
    assert.deepEqual(readdirSync(unpacked), [BUNDLE_NAME], "nothing beside the bundle, hidden or not");
    // The executable Squirrel's relaunch will start is the one the plist names.
    assert.ok(statSync(path.join(unpacked, BUNDLE_NAME, "Contents", "MacOS", infoPlist("nightly", VERSION).CFBundleExecutable)).mode & 0o111);
  } finally { r.cleanup(); rmSync(unpacked, { recursive: true, force: true }); }
});
