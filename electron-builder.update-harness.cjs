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
//   - no publish target, so app-update.yml is not written: a harness build
//     whose override failed has no feed at all, never the public one.
//   - an unpacked arm64 app in dist-harness/, signed with the Developer ID in
//     the keychain and not notarized. Squirrel accepts an update only when it
//     satisfies the running app's designated requirement, so this build must
//     be signed by the same team as Markie RS; the harness checks that.
const base = require("./electron-builder.config.cjs");

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
  win: { ...base.win, publish: null },
  linux: { ...base.linux, publish: null },
};
