// Which update feed this install follows.
//
// update-policy.js answers "should this build update at all". This answers
// "from where", which is a separate question with a much sharper failure mode:
// getting it wrong moves someone onto an unreleased build they never asked for.
//
// The beta channel exists so a release can be tried on people who volunteered
// and withdrawn if we don't like it. Three properties make that safe:
//
//   1. Opt-in only. The default is stable, and only an explicit `true` from the
//      Settings toggle changes it. Nothing infers consent.
//   2. Unlisted. The beta feed is a separate file in the same bucket and is not
//      a public platform entry in server/download-manifest.json, so the website
//      and the share emails cannot surface it. You reach it from inside the app
//      or not at all.
//   3. Reversible. Turning the toggle off allows a downgrade, so a beta tester
//      lands back on current stable instead of being stranded above it on a
//      build we pulled.
//
// Kept pure and dependency-free (fs is injected) so it unit-tests without
// booting Electron.

const path = require("node:path");

const STABLE_CHANNEL = "latest";
const BETA_CHANNEL = "beta";
const PREFS_FILE = "update-channel.json";

// electron-builder names the mac feed after the channel, so the two feeds are
// separate objects in the bucket and publishing a beta cannot rewrite stable.
const FEEDS = {
  [STABLE_CHANNEL]: "latest-mac.yml",
  [BETA_CHANNEL]: "beta-mac.yml",
};

/**
 * The channel for a stored opt-in value. Anything that is not literally `true`
 * means stable: the value comes off disk, where a corrupted or hand-edited file
 * can hold any shape, and "truthy" is not consent.
 */
function channelFor(optedIn) {
  return optedIn === true ? BETA_CHANNEL : STABLE_CHANNEL;
}

function feedFor(channel) {
  return FEEDS[channel] ?? FEEDS[STABLE_CHANNEL];
}

/** A semver prerelease build, i.e. one that came from the beta channel. */
function isPrerelease(version) {
  return typeof version === "string" && version.includes("-");
}

/**
 * The autoUpdater settings for this install.
 *
 * allowDowngrade is the bail-out. A beta build carries a higher version than
 * current stable, so a user who opts back out would be offered nothing by the
 * stable feed and would keep running the build we withdrew. Allowing a
 * downgrade in exactly that case walks them back.
 */
function updaterSettingsFor({ optedIn, currentVersion } = {}) {
  const channel = channelFor(optedIn);
  return {
    channel,
    allowDowngrade: channel === STABLE_CHANNEL && isPrerelease(currentVersion),
  };
}

function prefsPath(userDataDir) {
  return path.join(userDataDir, PREFS_FILE);
}

/**
 * Read the stored opt-in. Any failure answers `false`: this runs during startup
 * before there is a window to report an error in, so an exception here is both
 * invisible and fatal, and stable is the safe answer to "I can't tell".
 */
/**
 * @param {string} userDataDir
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync"> }} [opts]
 */
function readBetaOptIn(userDataDir, { fs = require("node:fs") } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath(userDataDir), "utf-8"));
    return parsed?.beta === true;
  } catch {
    return false;
  }
}

/** Persist the opt-in. Returns whether it stuck, so the UI can avoid lying. */
/**
 * @param {string} userDataDir
 * @param {boolean} optedIn
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync"> }} [opts]
 */
function writeBetaOptIn(userDataDir, optedIn, { fs = require("node:fs") } = {}) {
  try {
    fs.writeFileSync(
      prefsPath(userDataDir),
      `${JSON.stringify({ beta: optedIn === true }, null, 2)}\n`,
      "utf-8"
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  BETA_CHANNEL,
  STABLE_CHANNEL,
  PREFS_FILE,
  channelFor,
  feedFor,
  isPrerelease,
  prefsPath,
  readBetaOptIn,
  updaterSettingsFor,
  writeBetaOptIn,
};
