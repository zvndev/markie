// Which update feed this install follows.
//
// update-policy.js answers "should this build update at all". This answers
// "from where", which is a separate question with a much sharper failure mode:
// getting it wrong moves someone onto an unreleased build they never asked for.
//
// The beta channel is the early-access lane ("Get new versions early" in
// Settings). Since the three-stage release pipeline, a release is published to
// this feed first under its final, stable version number (0.9.0, never
// 0.9.0-beta.1), soaks there for a few days, and then the very same files are
// promoted to the stable feed. Older X.Y.Z-beta.N builds still route here too.
//
// electron-updater does not care that a beta feed names a non-prerelease
// version. The S3 provider is a GenericProvider: it fetches `<channel>-mac.yml`
// (or `<channel>.yml` on Windows) and offers whatever version is in it when
// that version is semver-greater than the running one. `allowPrerelease` is
// only consulted by the GitHub providers, so it plays no part here.
//
// Three properties keep the channel safe:
//
//   1. Opt-in only. The default is stable, and only an explicit `true` from the
//      Settings toggle changes it. Nothing infers consent.
//   2. Unlisted. The beta feed is a separate file in the same bucket and is not
//      a public platform entry in server/download-manifest.json, so the website
//      and the share emails cannot surface it. You reach it from inside the app
//      or not at all.
//   3. Reversible. Turning the toggle off allows a downgrade, so an early user
//      lands back on current stable instead of being stranded above it on a
//      build we pulled. A prerelease version always qualifies. A stable-style
//      early build looks exactly like a stable one, so the opt-out records the
//      version it was made from, and that exact build is allowed to go down.
//
// Kept pure and dependency-free (fs is injected) so it unit-tests without
// booting Electron.

const path = require("node:path");

const STABLE_CHANNEL = "latest";
const BETA_CHANNEL = "beta";
const PREFS_FILE = "update-channel.json";

// electron-builder names the feed after the channel, so the two feeds are
// separate objects in the bucket and publishing a beta cannot rewrite stable.
// It also names them after the platform: the mac zip target carries a -mac
// suffix and NSIS does not, so the same channel is a different file on each.
// Getting that wrong would offer a Windows install a .dmg.
const FEEDS = {
  darwin: {
    [STABLE_CHANNEL]: "latest-mac.yml",
    [BETA_CHANNEL]: "beta-mac.yml",
  },
  win32: {
    [STABLE_CHANNEL]: "latest.yml",
    [BETA_CHANNEL]: "beta.yml",
  },
  // x64 only. electron-updater appends -linux on x64 and -linux-arm64 on arm64,
  // and Markie ships no arm64 Linux build, so the arm64 names would be feeds
  // nothing writes.
  linux: {
    [STABLE_CHANNEL]: "latest-linux.yml",
    [BETA_CHANNEL]: "beta-linux.yml",
  },
};

/**
 * The channel for a stored opt-in value. Anything that is not literally `true`
 * means stable: the value comes off disk, where a corrupted or hand-edited file
 * can hold any shape, and "truthy" is not consent.
 */
function channelFor(optedIn) {
  return optedIn === true ? BETA_CHANNEL : STABLE_CHANNEL;
}

/**
 * The feed file for a channel on a platform. Platforms without a published
 * feed fall back to the mac table: nothing fetches a feed for them (the update
 * policy refuses first), and the fallback keeps an unknown platform on stable
 * rather than letting it read as beta.
 */
function feedFor(channel, platform = process.platform) {
  const table = FEEDS[platform] ?? FEEDS.darwin;
  return table[channel] ?? table[STABLE_CHANNEL];
}

/** A semver prerelease build, i.e. one that came from the beta channel. */
function isPrerelease(version) {
  return typeof version === "string" && version.includes("-");
}

/**
 * The autoUpdater settings for this install.
 *
 * allowDowngrade is the bail-out. An early build carries a higher version than
 * current stable, so a user who opts back out would be offered nothing by the
 * stable feed and would keep running the build we withdrew. Allowing a
 * downgrade in exactly that case walks them back.
 *
 * "Exactly that case" is either a prerelease version (the legacy X.Y.Z-beta.N
 * lane) or the very version the user was running when they left the early
 * channel. Someone who was always on stable never gets allowDowngrade, and
 * once the opted-out user has moved to any other build the marker stops
 * matching on its own.
 *
 * Note that setting `autoUpdater.channel` flips allowDowngrade to true inside
 * electron-updater, so the caller must assign this value after the channel.
 */
function updaterSettingsFor({ optedIn, currentVersion, leftEarlyFrom } = {}) {
  const channel = channelFor(optedIn);
  const leftThisBuild =
    typeof leftEarlyFrom === "string" &&
    leftEarlyFrom.length > 0 &&
    leftEarlyFrom === currentVersion;
  return {
    channel,
    allowDowngrade:
      channel === STABLE_CHANNEL && (isPrerelease(currentVersion) || leftThisBuild),
  };
}

function prefsPath(userDataDir) {
  return path.join(userDataDir, PREFS_FILE);
}

/**
 * Read the stored preferences. Any failure answers "not opted in": this runs
 * during startup before there is a window to report an error in, so an
 * exception here is both invisible and fatal, and stable is the safe answer to
 * "I can't tell".
 *
 * The file is `{ "beta": boolean, "leftEarlyFrom"?: string }`. `beta` is the
 * original key and is kept, so a file written by any earlier build still reads.
 */
/**
 * @param {string} userDataDir
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync"> }} [opts]
 * @returns {{ optedIn: boolean, leftEarlyFrom: string | null }}
 */
function readChannelPrefs(userDataDir, { fs = require("node:fs") } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsPath(userDataDir), "utf-8"));
    const optedIn = parsed?.beta === true;
    const leftEarlyFrom =
      !optedIn && typeof parsed?.leftEarlyFrom === "string" && parsed.leftEarlyFrom
        ? parsed.leftEarlyFrom
        : null;
    return { optedIn, leftEarlyFrom };
  } catch {
    return { optedIn: false, leftEarlyFrom: null };
  }
}

/**
 * @param {string} userDataDir
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync"> }} [opts]
 */
function readBetaOptIn(userDataDir, opts = {}) {
  return readChannelPrefs(userDataDir, opts).optedIn;
}

/**
 * Persist the opt-in. Returns whether it stuck, so the UI can avoid lying.
 *
 * Turning the channel off while it was on records `currentVersion` as
 * `leftEarlyFrom`, which is what lets updaterSettingsFor walk a stable-numbered
 * early build back down. Turning it on clears the marker.
 */
/**
 * @param {string} userDataDir
 * @param {boolean} optedIn
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync">, currentVersion?: string }} [opts]
 */
function writeBetaOptIn(userDataDir, optedIn, { fs = require("node:fs"), currentVersion } = {}) {
  try {
    const next = { beta: optedIn === true };
    if (!next.beta) {
      const previous = readChannelPrefs(userDataDir, { fs });
      const leftFrom = previous.optedIn ? currentVersion : previous.leftEarlyFrom;
      if (typeof leftFrom === "string" && leftFrom) next.leftEarlyFrom = leftFrom;
    }
    fs.writeFileSync(prefsPath(userDataDir), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop a leftEarlyFrom marker once the install is no longer running that
 * build. Without this, a user who left early on 0.9.0, went down to 0.8.0, and
 * later took 0.9.0 again from stable would carry allowDowngrade on stable.
 * Returns whether anything changed. Never throws.
 */
/**
 * @param {string} userDataDir
 * @param {string} currentVersion
 * @param {{ fs?: Pick<typeof import("node:fs"), "readFileSync" | "writeFileSync"> }} [opts]
 */
function settleLeftEarly(userDataDir, currentVersion, { fs = require("node:fs") } = {}) {
  const prefs = readChannelPrefs(userDataDir, { fs });
  if (prefs.optedIn || !prefs.leftEarlyFrom || prefs.leftEarlyFrom === currentVersion) return false;
  try {
    fs.writeFileSync(prefsPath(userDataDir), `${JSON.stringify({ beta: false }, null, 2)}\n`, "utf-8");
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
  readChannelPrefs,
  settleLeftEarly,
  updaterSettingsFor,
  writeBetaOptIn,
};
