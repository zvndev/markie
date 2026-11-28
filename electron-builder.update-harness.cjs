/* eslint-disable @typescript-eslint/no-require-imports */
// The Electron build the Mac cutover handoff check updates *from*
// (scripts/mac-cutover-handoff-check.mjs). Never a release config.
//
// It is the public config with four changes:
//
//   - package.json carries `markieUpdateHarness: true`, the marker that lets
//     electron/update-harness.js point this build at a loopback feed. The
//     release runner refuses any app that carries it, and release:preflight
//     fails if the public config ever sets it.
//   - its version is MARKIE_HARNESS_FROM_VERSION (0.9.7 by default), the
//     release being updated from, so the updater compares the same numbers an
//     installed 0.9.7 does.
//   - no publish target. electron-updater still reads app-update.yml when it
//     downloads (for updaterCacheDirName), so afterPack writes one, as the
//     private lane does. Its url is a dead loopback address: a harness build
//     whose override failed has no working feed at all, never the public one.
//   - an unpacked arm64 app in dist-harness/, signed with the Developer ID in
//     the keychain and not notarized. Squirrel accepts an update only when it
//     satisfies the running app's designated requirement, so this build must
//     be signed by the same team as Markie RS; the harness checks that.
const fs = require("node:fs");
const path = require("node:path");
const base = require("./electron-builder.config.cjs");
const preflight = require("./build/preflight.cjs");

// Port 9 on loopback is the discard service, which nothing on a Mac answers.
const HARNESS_UPDATE_YML = [
  "provider: generic",
  "url: http://127.0.0.1:9/markie-update-harness-no-feed/",
  "updaterCacheDirName: markie-update-harness",
  "",
].join("\n");

const version = process.env.MARKIE_HARNESS_FROM_VERSION || "0.9.7";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`MARKIE_HARNESS_FROM_VERSION must be X.Y.Z, got ${version}`);
}

module.exports = {
  ...base,
  publish: null,
  extraMetadata: { version, markieUpdateHarness: true },
  directories: { ...base.directories, output: "dist-harness" },
  mac: { ...base.mac, publish: null, notarize: false, target: [{ target: "dir", arch: ["arm64"] }] },
  afterPack: async (context) => {
    if (context.electronPlatformName === "darwin") {
      const resources = path.join(context.appOutDir, "Markie.app", "Contents", "Resources");
      fs.writeFileSync(path.join(resources, "app-update.yml"), HARNESS_UPDATE_YML);
    }
    await preflight(context);
  },
  win: { ...base.win, publish: null },
  linux: { ...base.linux, publish: null },
};
