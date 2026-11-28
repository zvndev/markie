// The Mac cutover (0.10.0): Apple Silicon Macs move from Electron Markie to
// Markie RS, the Rust app, through the normal updater. Intel Macs stay on
// Electron as "Markie for Intel Macs". docs/RELEASING.md, "Mac cutover
// (0.10.0)", is the runbook; this file is the part of it that is pure logic,
// so the release runner, the handoff harness and the tests share one copy.
//
// The feeds after the cutover:
//
//   mac/latest-mac.yml        read by every Electron Mac build older than the
//                             cutover (both arches) and by Markie RS. Its
//                             version is the Rust version. It lists the Rust
//                             arm64 ZIP and DMG, and one Electron x64 ZIP: the
//                             Intel bridge.
//   mac-intel/latest-mac.yml  read by Electron x64 builds from the cutover on.
//                             Electron x64 ZIP and DMG only.
//
// electron-updater picks the file per machine (MacUpdater.filterFilesForArch):
// an Apple Silicon Mac, Rosetta included, takes the file with "arm64" in its
// name when there is one; an Intel Mac drops every arm64 file. So one mac/ feed
// serves both, and an old Intel install that reads it lands on the bridge,
// whose app-update.yml points at mac-intel/ from then on.
//
// The bridge rule. A feed has one version, and it is the Rust one. An Intel
// install older than the cutover is offered that version, downloads the x64
// ZIP, and becomes whatever Intel build the ZIP holds. That works for any
// bridge at or above the cutover version, because every such Electron build
// reads mac-intel/ and never mac/ again. So:
//
//   - a release that ships both (the cutover itself, or any later joint one)
//     makes its own x64 ZIP the bridge;
//   - a Rust-only release carries the bridge forward byte for byte from the
//     stable mac/ feed it replaces, so a Rust version past the last Intel
//     version never drops the x64 entry and never strands an old Intel Mac;
//   - an Intel-only release does not touch mac/ at all. Old Intel installs
//     reach the bridge, then the newest Intel build through mac-intel/.
//
// The one cosmetic cost: an old Intel install's notice names the Rust version
// (the feed's), and About then shows the Intel version it really got.
//
// Why an Electron x64 build at or above the cutover must never read mac/: it
// would be offered the Rust version, take the bridge, and if the bridge is not
// newer than itself it would reinstall the same or an older build on every
// check. The release runner asserts every x64 app it ships points at
// mac-intel/ for exactly this reason.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import yaml from "js-yaml";

/** @typedef {{ name: string, size: number, sha512: string }} FileRecord */
/** @typedef {{ version: string, files: FileRecord[] }} BuildRecord */

const require = createRequire(import.meta.url);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const RUST_RELEASE_FILE = "release.json";
export const MAC_RELEASE_PLAN_FILE = "mac-release.json";

// A semver the updater can compare. Release builds are X.Y.Z; the handoff
// harness also feeds a Rust release candidate (0.10.0-rc.1) through here.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

// The semver electron-updater itself uses to decide whether a feed is newer,
// not whichever copy happens to be hoisted to the top of node_modules.
function updaterSemver() {
  return createRequire(require.resolve("electron-updater"))("semver");
}

export function assertSemver(value, label = "version") {
  assert(typeof value === "string" && SEMVER.test(value), `invalid ${label}: ${value ?? "missing"}`);
  return value;
}

/** -1, 0 or 1, by the updater's own semver rules (prereleases sort first). */
export function compareSemver(left, right) {
  return updaterSemver().compare(assertSemver(left), assertSemver(right));
}

/**
 * Where the cutover puts things, read from the release manifest, or null when
 * the manifest has no cutover. Throws on a manifest that half-declares one.
 */
export function macCutoverConfig(manifest) {
  const cutover = manifest?.macCutover;
  if (!cutover) return null;
  assert(/^\d+\.\d+\.\d+$/.test(cutover.version ?? ""), `macCutover.version must be X.Y.Z: ${cutover.version}`);
  assert(cutover.arm64Source === "rust", "macCutover.arm64Source must be rust");
  assert(cutover.bundleId && /^[A-Z0-9]{10}$/.test(cutover.teamId ?? ""), "macCutover needs bundleId and teamId");
  const arm = manifest.platforms?.find((entry) => entry.id === "mac-arm64");
  const intel = manifest.platforms?.find((entry) => entry.id === "mac-x64");
  assert(arm?.feed?.path && intel?.feed?.path, "the Mac cutover needs feeds for mac-arm64 and mac-x64");
  const armDir = path.posix.dirname(arm.feed.path);
  const intelDir = path.posix.dirname(intel.feed.path);
  assert(armDir !== intelDir, "the Mac cutover gives Intel its own feed directory");
  const armEarly = manifest.betaChannel?.feed?.path;
  const intelEarly = manifest.betaChannel?.macIntelFeed?.path;
  assert(armEarly && path.posix.dirname(armEarly) === armDir, "the Apple Silicon early feed must sit beside its stable feed");
  assert(intelEarly && path.posix.dirname(intelEarly) === intelDir, "the Intel early feed must sit beside its stable feed");
  return {
    version: cutover.version,
    bundleId: cutover.bundleId,
    teamId: cutover.teamId,
    armDir,
    intelDir,
    armFeedPath: arm.feed.path,
    intelFeedPath: intel.feed.path,
    armEarlyPath: armEarly,
    intelEarlyPath: intelEarly,
  };
}

const artifactName = (version, arch, ext) => `Markie-${version}-${arch}.${ext}`;

/** The version inside a Markie artifact name, or null. */
export function artifactVersion(name, arch, ext) {
  const match = String(name ?? "").match(new RegExp(`^Markie-(.+)-${arch}\\.${ext}$`));
  return match && SEMVER.test(match[1]) ? match[1] : null;
}

async function hashFile(file) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

/**
 * The Rust release folder, rust/target/public/<version>/ as
 * rust/scripts/public-release.sh writes it: the arm64 ZIP and DMG and a
 * release.json naming each with its size and SHA-512 (base64, the way
 * electron-builder writes it). Every byte is checked here, before anything
 * trusts the folder.
 *
 * @param {string} dir
 * @param {{ expectVersion?: string | null, allowPrerelease?: boolean }} [options]
 */
export async function readRustRelease(dir, { expectVersion = null, allowPrerelease = false } = {}) {
  assert(dir, "pass the Rust release folder (rust/target/public/<version>/)");
  const manifestPath = path.join(dir, RUST_RELEASE_FILE);
  assert(existsSync(manifestPath), `missing ${manifestPath}; run rust/scripts/public-release.sh first`);
  const release = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = assertSemver(release?.version, "Rust release version");
  assert(allowPrerelease || /^\d+\.\d+\.\d+$/.test(version), `Rust release ${version} is a prerelease; a public release is X.Y.Z`);
  if (expectVersion) assert(version === expectVersion, `Rust release is ${version}, expected ${expectVersion}`);
  assert(/^[0-9a-f]{40}$/.test(release.gitCommit ?? ""), "Rust release.json needs the full gitCommit it was built from");
  assert(Array.isArray(release.files), "Rust release.json needs a files list");
  const expected = [artifactName(version, "arm64", "zip"), artifactName(version, "arm64", "dmg")];
  const names = release.files.map((file) => file?.name);
  assert(
    names.length === expected.length && expected.every((name) => names.includes(name)),
    `Rust release.json must list exactly ${expected.join(" and ")}, found ${names.join(", ") || "nothing"}`
  );
  const files = [];
  for (const entry of release.files) {
    assert(Number.isSafeInteger(entry.size) && entry.size > 0, `${entry.name} needs a positive size in release.json`);
    assert(SHA512_BASE64.test(entry.sha512 ?? ""), `${entry.name} needs a base64 SHA-512 in release.json`);
    const file = path.join(dir, entry.name);
    assert(existsSync(file), `missing ${file}`);
    const size = statSync(file).size;
    assert(size === entry.size, `${entry.name} is ${size} bytes, release.json says ${entry.size}`);
    const sha512 = await hashFile(file);
    assert(sha512 === entry.sha512, `${entry.name} SHA-512 does not match release.json`);
    files.push({ name: entry.name, size, sha512, path: file });
  }
  files.sort((left, right) => expected.indexOf(left.name) - expected.indexOf(right.name));
  return { version, gitCommit: release.gitCommit, dir, files, zip: files[0], dmg: files[1] };
}

/**
 * The Intel bridge in a mac/ feed: its one Electron x64 ZIP at or above the
 * cutover version, or null (a feed from before the cutover has an x64 ZIP too,
 * but an older one, which does not read mac-intel/ and is no bridge).
 *
 * @param {{ files?: { url?: string, size?: number, sha512?: string }[] } | null | undefined} feed
 * @param {string} cutoverVersion
 * @returns {(FileRecord & { version: string }) | null}
 */
export function bridgeFromFeed(feed, cutoverVersion) {
  const zips = (feed?.files ?? [])
    .map((entry) => ({ ...entry, name: decodeURIComponent(entry.url ?? "") }))
    .filter((entry) => artifactVersion(entry.name, "x64", "zip"));
  if (zips.length !== 1) return null;
  const [zip] = zips;
  const version = artifactVersion(zip.name, "x64", "zip");
  if (compareSemver(version, cutoverVersion) < 0) return null;
  return { name: zip.name, size: zip.size, sha512: zip.sha512, version };
}

function assertFileRecord(file, label) {
  assert(file && typeof file.name === "string" && !/[\\/]/.test(file.name), `${label} needs a plain file name`);
  assert(Number.isSafeInteger(file.size) && file.size > 0, `${label} needs a size`);
  assert(typeof file.sha512 === "string" && file.sha512.length > 0, `${label} needs a SHA-512`);
}

/** Electron Builder's feed shape, written the way refreshMacFeedIntegrity writes it. */
export function feedText({ version, files, releaseDate }) {
  const entries = files.map(({ name, sha512, size }) => ({ url: name, sha512, size }));
  return yaml.dump(
    { version, files: entries, path: entries[0].url, sha512: entries[0].sha512, releaseDate },
    { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, quotingType: "'" }
  );
}

/**
 * The two Mac feeds for one release under the cutover.
 *
 *   rust   { version, files: [arm64 zip, arm64 dmg] } or null (Intel-only)
 *   intel  { version, files: [x64 zip, x64 dmg] } or null (Rust-only)
 *   bridge the x64 ZIP record to carry in mac/; defaults to intel's ZIP. A
 *          Rust-only release must pass the one from the stable mac/ feed.
 *
 * Returns { mac, macIntel, bridge }, each feed { version, files, text } or
 * null when that directory is not part of the release.
 *
 * @param {{ rust?: BuildRecord | null, intel?: BuildRecord | null, bridge?: FileRecord | null, cutoverVersion: string, releaseDate?: string }} options
 * @returns {{ mac: { version: string, files: FileRecord[], text: string } | null, macIntel: { version: string, files: FileRecord[], text: string } | null, bridge: FileRecord | null }}
 */
export function buildCutoverFeeds({ rust = null, intel = null, bridge = null, cutoverVersion, releaseDate = new Date().toISOString() }) {
  assertSemver(cutoverVersion, "cutover version");
  assert(rust || intel, "a Mac release under the cutover ships Markie RS, the Intel build, or both");
  let macIntel = null;
  if (intel) {
    const version = assertSemver(intel.version, "Intel version");
    assert(compareSemver(version, cutoverVersion) >= 0, `Intel ${version} is older than the cutover ${cutoverVersion}`);
    const expected = [artifactName(version, "x64", "zip"), artifactName(version, "x64", "dmg")];
    const names = (intel.files ?? []).map((file) => file.name);
    assert(
      names.length === 2 && expected.every((name) => names.includes(name)),
      `the Intel feed lists exactly ${expected.join(" and ")}, got ${names.join(", ") || "nothing"}`
    );
    intel.files.forEach((file) => assertFileRecord(file, file.name));
    const files = expected.map((name) => intel.files.find((file) => file.name === name));
    macIntel = { version, files, text: feedText({ version, files, releaseDate }) };
  }
  let mac = null;
  const carried = bridge ?? (intel ? macIntel.files[0] : null);
  if (rust) {
    const version = assertSemver(rust.version, "Rust version");
    assert(compareSemver(version, cutoverVersion) >= 0, `Markie RS ${version} is older than the cutover ${cutoverVersion}`);
    const expected = [artifactName(version, "arm64", "zip"), artifactName(version, "arm64", "dmg")];
    const names = (rust.files ?? []).map((file) => file.name);
    assert(
      names.length === 2 && expected.every((name) => names.includes(name)),
      `the Rust files are exactly ${expected.join(" and ")}, got ${names.join(", ") || "nothing"}`
    );
    rust.files.forEach((file) => assertFileRecord(file, file.name));
    // No x64 entry would strand every Intel install older than the cutover:
    // electron-updater drops arm64 files on Intel and finds nothing left.
    assert(carried, "mac/ needs an Intel bridge (an Electron x64 ZIP); a Rust-only release carries the stable one forward");
    assertFileRecord(carried, "the Intel bridge");
    const bridgeVersion = artifactVersion(carried.name, "x64", "zip");
    assert(bridgeVersion, `the Intel bridge must be an Electron x64 ZIP, not ${carried.name}`);
    assert(
      compareSemver(bridgeVersion, cutoverVersion) >= 0,
      `the Intel bridge ${carried.name} is older than the cutover; only a build that reads mac-intel/ can be the bridge`
    );
    const files = [...expected.map((name) => rust.files.find((file) => file.name === name)), carried];
    mac = { version, files, text: feedText({ version, files, releaseDate }) };
  }
  return { mac, macIntel, bridge: rust ? carried : null };
}

/**
 * Under the cutover the only arm64 bytes allowed into the bucket are the ones
 * in the Rust release.json. An Electron arm64 build is refused by name and
 * hash, whatever directory it was staged in.
 *
 * @param {{ name: string, size?: number, sha512?: string }[]} files what is about to be uploaded or listed
 * @param {{ name: string, size: number, sha512: string }[]} rustFiles
 */
export function assertNoElectronArm64(files, rustFiles = []) {
  const allowed = new Map(rustFiles.map((file) => [file.name, file]));
  for (const file of files) {
    const name = path.basename(file.name);
    if (!/arm64/i.test(name)) continue;
    if (/\.blockmap$/.test(name) && allowed.has(name.replace(/\.blockmap$/, ""))) continue;
    const rust = allowed.get(name);
    assert(
      rust && (file.sha512 === undefined || file.sha512 === rust.sha512) && (file.size === undefined || file.size === rust.size),
      `refusing ${name}: the Mac cutover is on, and arm64 Macs get Markie RS only; an Electron arm64 build is never published`
    );
  }
}

/** True when a ZIP's entry list is an Electron app bundle. */
export function isElectronBundle(entryNames) {
  return entryNames.some((name) => /^[^/]+\.app\/Contents\/Frameworks\/Electron Framework\.framework\//.test(name));
}

/**
 * Which file electron-updater 6 downloads from a mac feed, using its own code:
 * Provider.resolveFiles, MacUpdater.filterFilesForArch, Provider.findFile, the
 * same three calls MacUpdater.doDownloadUpdate makes. `arm64Mac` is what it
 * works out from uname, process.arch and Rosetta; an x64 build under Rosetta
 * on Apple Silicon counts as an arm64 Mac.
 *
 * Also answers whether the feed is offered at all to an install running
 * `currentVersion`, by the updater's own semver comparison.
 *
 * @param {string} text
 * @param {{ arm64Mac: boolean, baseUrl?: string, currentVersion?: string | null }} options
 * @returns {{ version: string, offered: boolean | null, file: string | null, url: string | null }}
 */
export function updaterChoice(text, { arm64Mac, baseUrl = "https://updates.invalid/mac/", currentVersion = null }) {
  const { MacUpdater } = require("electron-updater/out/MacUpdater.js");
  const { findFile, resolveFiles } = require("electron-updater/out/providers/Provider.js");
  const info = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  const resolved = resolveFiles(info, new URL(baseUrl));
  const files = MacUpdater.filterFilesForArch(resolved, arm64Mac);
  let chosen = null;
  try {
    chosen = files.length > 0 ? findFile(files, "zip", ["pkg", "dmg"]) : null;
  } catch {
    chosen = null;
  }
  const offered = currentVersion ? updaterSemver().gt(info.version, currentVersion) : null;
  return {
    version: info.version,
    offered,
    file: chosen ? decodeURIComponent(chosen.info.url) : null,
    url: chosen ? chosen.url.href : null,
  };
}

/** Identifier and TeamIdentifier out of `codesign -dv --verbose=2` (which prints to stderr). */
export function parseCodesignDetails(text) {
  const field = (name) => String(text ?? "").match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() ?? null;
  return { identifier: field("Identifier"), teamId: field("TeamIdentifier") };
}
