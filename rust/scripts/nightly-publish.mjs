#!/usr/bin/env node
/** Markie, the Mac app, on the super-nightly channel: write the feed, verify the
 * release, publish it to the private gateway.
 *
 * The channel is Electron Markie's super-nightly lane, unchanged on the server:
 * the same prefix, the same feed name and format, the same artifact name. An
 * installed Electron super-nightly reads this feed with electron-updater and
 * installs the ZIP over itself through Squirrel.Mac. The rules are those of
 * the Electron lane's scripts/private-release.mjs (docs/rust-port/NIGHTLY.md):
 *   - the publish key comes only from MARKIE_PRIVATE_PUBLISH_KEY, never from
 *     an argument, and is never printed;
 *   - one closed destination, <gateway>/private-releases/super-nightly/:filename;
 *   - the immutable ZIP goes first (If-None-Match: *), the feed last;
 *   - every file is hashed again right before its upload;
 *   - no redirect is followed, and there is no public fallback.
 *
 *   node rust/scripts/nightly-publish.mjs <feed|verify|publish|repoint>
 *
 * Environment: MARKIE_NIGHTLY_VERSION (X.Y.Z-super-nightly.N), MARKIE_PRIVATE_API_ORIGIN
 * (exactly the gateway origin), MARKIE_PRIVATE_PUBLISH_KEY (publish only),
 * MARKIE_NIGHTLY_OUTPUT_DIR (optional; default rust/target/nightly/<version>).
 * `repoint` is the roll back: it replaces the channel's feed with one kept from
 * an earlier publish, named by MARKIE_NIGHTLY_REPOINT_FEED, and uploads nothing else.
 * No dependencies beyond Node.
 *
 * Mac only. Windows stays on Electron, and nothing here names its feeds.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { infoPlist } from "./mac-info-plist.mjs";

const rustDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GATEWAY_ORIGIN = "https://markie-nightly.zvndev.com";
export const LANE_PREFIX = "/private-releases/super-nightly/";
export const FEED_NAME = "super-nightly-mac.yml";
export const BUNDLE_ID = "com.zvn.markie";
export const BUNDLE_NAME = "Markie.app";
export const APP_NAME = "Markie";
/** The last Electron build on this channel. A Rust build must be above it, or
 * the Electron app that is installed never sees it as an update. */
export const LAST_ELECTRON_SUPER_NIGHTLY = "0.9.8-super-nightly.2";
export const TEAM_ID = "3VU8SG5TD9";
export const IDENTITY = `Developer ID Application: Kirby Campbell (${TEAM_ID})`;
const LIMIT = 512 * 1024 * 1024, MAX_FEED_BYTES = 64 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-super-nightly\.(0|[1-9]\d*)$/;
const HASH = /^[A-Za-z0-9+/]{86}==$/;
/** Electron Markie's designated requirement: what Squirrel.Mac in an installed
 * Electron build, and this app's own updater, check a download against. */
export const REQUIREMENT = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM_ID}"`;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = (bytes) => createHash("sha512").update(bytes).digest("base64");
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

/** Runs a tool with no shell. `tools.run` is the seam the tests answer for. */
export const systemTools = {
  run(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? {}, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
    return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
};

export function readProvenance(root = rustDir, tools = systemTools) {
  const git = (args) => { const r = tools.run("/usr/bin/git", args, { cwd: root, env: process.env }); assert(r.ok, "git is not available in this checkout."); return r.stdout.trim(); };
  return { gitCommit: git(["rev-parse", "HEAD"]), gitDirty: git(["status", "--porcelain", "--untracked-files=all"]) !== "" };
}

export function gatewayOrigin(value) {
  assert(typeof value === "string" && value.length < 300, "MARKIE_PRIVATE_API_ORIGIN is required.");
  let url;
  try { url = new URL(value); } catch { throw new Error("The private gateway origin must be an HTTPS origin."); }
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash && value.replace(/\/$/, "") === url.origin, "The private gateway origin must be a bare HTTPS origin, with no path or credentials.");
  // The publish key goes to one reviewed host. Changing it is a code change.
  assert(url.origin === GATEWAY_ORIGIN, "The destination must be the reviewed private gateway origin.");
  return url.origin;
}

export function outputDirectory(root, requested, version) {
  const allowed = path.join(root, "target", "nightly");
  assert(!requested || path.isAbsolute(requested), "MARKIE_NIGHTLY_OUTPUT_DIR must be absolute.");
  const output = requested ? path.resolve(requested) : path.join(allowed, version);
  const repository = path.dirname(root);
  assert(!inside(repository, output) || inside(allowed, output), "The output folder must be outside the repository or under the ignored rust/target/nightly.");
  assert(!/-dry-run$/.test(path.basename(output)), "A dry-run build is never verified for publishing.");
  let existing = output;
  while (!existsSync(existing)) existing = path.dirname(existing);
  assert(realpathSync(existing) === existing, "The output folder may not be reached through a symlink.");
  return output;
}

export function nightlySettings(env = process.env, root = rustDir, provenance = readProvenance(root)) {
  const version = env.MARKIE_NIGHTLY_VERSION;
  assert(typeof version === "string" && VERSION.test(version), "MARKIE_NIGHTLY_VERSION must be X.Y.Z-super-nightly.N.");
  assert(versionAbove(version, LAST_ELECTRON_SUPER_NIGHTLY), `The version must be above ${LAST_ELECTRON_SUPER_NIGHTLY}, the last Electron build on this channel.`);
  assert(/^[a-f0-9]{40}$/.test(provenance.gitCommit) && provenance.gitDirty === false, "A nightly is verified and published from one clean, exact commit.");
  return { version, apiOrigin: gatewayOrigin(env.MARKIE_PRIVATE_API_ORIGIN), gitCommit: provenance.gitCommit, channel: "super-nightly", output: outputDirectory(root, env.MARKIE_NIGHTLY_OUTPUT_DIR, version) };
}

export const artifactName = (version) => `Markie-${version}-arm64.zip`;

/** Whether `a` is a higher version than `b`, both X.Y.Z-super-nightly.N: semver order for this shape. */
export function versionAbove(a, b) {
  const [left, right] = [a, b].map((v) => VERSION.exec(v)?.slice(1).map(Number));
  assert(left && right, "Both versions must be X.Y.Z-super-nightly.N.");
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

export function uploadUrl(settings, name) {
  assert(name === FEED_NAME || name === artifactName(settings.version), "Only the super-nightly Mac feed and this version's ZIP may be uploaded.");
  const origin = gatewayOrigin(settings.apiOrigin), url = new URL(LANE_PREFIX + name, origin);
  assert(url.origin === origin && url.pathname === LANE_PREFIX + name && !url.search && !url.hash, "The upload destination left its closed prefix.");
  return url.href;
}

/** The feed text: the small subset the gateway and the app both read strictly. */
export function feedText(version, sha512, size, releaseDate = new Date().toISOString()) {
  const name = artifactName(version);
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${releaseDate}'\n`;
}

export function createFeed(settings) {
  const zip = path.join(settings.output, artifactName(settings.version));
  assert(existsSync(zip) && lstatSync(zip).isFile(), "This version's ZIP is not in the output folder; run nightly-release.sh first.");
  const data = readFileSync(zip);
  assert(data.length > 0 && data.length <= LIMIT, "The ZIP is outside the gateway's size bounds.");
  const text = feedText(settings.version, digest(data), data.length);
  writeFileSync(path.join(settings.output, FEED_NAME), text);
  return parseFeed(Buffer.from(text), settings);
}

const scalar = (input) => ((input.startsWith("'") && input.endsWith("'")) || (input.startsWith('"') && input.endsWith('"'))) && input.length >= 2 ? input.slice(1, -1) : input;

/** The gateway's feed grammar (`parseFeed` in server/src/private-releases.ts): fields and files, nothing else. */
function readFeed(bytes) {
  assert(bytes.length > 0 && bytes.length <= MAX_FEED_BYTES, "The feed is outside its size bounds.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
  assert(!/[\x00-\x08\x0b-\x1f\x7f]/.test(text), "The feed has a control character.");
  const top = new Map(), files = [];
  let inFiles = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
    if (line === "files:") { assert(!top.has("files"), "The feed repeats files."); top.set("files", ""); inFiles = true; continue; }
    const child = /^  - url: (.+)$/.exec(line);
    if (child && inFiles) { assert(files.length < 32, "The feed lists too many files."); files.push({ url: scalar(child[1]) }); continue; }
    const property = /^    (sha512|size): (.+)$/.exec(line);
    if (property && inFiles && files.length) {
      const entry = files.at(-1);
      assert(!(property[1] in entry), "The feed repeats a file property.");
      entry[property[1]] = scalar(property[2]); continue;
    }
    const field = /^(version|path|sha512|releaseDate): (.+)$/.exec(line);
    assert(field && !top.has(field[1]), "The feed has an unknown or repeated field.");
    inFiles = false; top.set(field[1], scalar(field[2]));
  }
  assert(!top.has("releaseDate") || Number.isFinite(Date.parse(top.get("releaseDate"))), "The feed's release date is not valid.");
  return { top, files };
}

/** The feed of one version this publisher wrote: exactly this version's arm64 ZIP. */
export function parseFeed(bytes, settings) {
  const { top, files } = readFeed(bytes);
  const name = artifactName(settings.version);
  assert(top.get("version") === settings.version, "The feed is for another version.");
  assert(files.length === 1 && files[0].url === name && top.get("path") === name, "The feed must name exactly this version's ZIP.");
  const { sha512, size } = files[0];
  assert(typeof sha512 === "string" && HASH.test(sha512) && top.get("sha512") === sha512, "The feed's SHA-512 is not valid.");
  assert(typeof size === "string" && /^[1-9]\d*$/.test(size) && Number(size) <= LIMIT, "The feed's size is not valid.");
  return { version: settings.version, name, sha512, size: Number(size) };
}

/** Any feed this channel has carried, Electron's or this app's: the roll back re-points the channel at one. */
export function parseChannelFeed(bytes) {
  const { top, files } = readFeed(bytes);
  const version = top.get("version");
  assert(typeof version === "string" && VERSION.test(version), "The feed's version is not X.Y.Z-super-nightly.N.");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), names = new RegExp(`^Markie-${escaped}-(?:arm64|x64)\\.zip$`);
  assert(files.length >= 1 && files.length <= 2 && new Set(files.map((f) => f.url)).size === files.length, "The feed must list one ZIP per architecture.");
  for (const file of files) {
    assert(names.test(file.url), "The feed names a file that is not this version's ZIP.");
    assert(typeof file.sha512 === "string" && HASH.test(file.sha512) && typeof file.size === "string" && /^[1-9]\d*$/.test(file.size) && Number(file.size) <= LIMIT, "The feed's SHA-512 or size is not valid.");
  }
  const legacy = files.find((f) => f.url === top.get("path"));
  assert(legacy && legacy.sha512 === top.get("sha512"), "The feed's path and SHA-512 must name one of its files.");
  assert(files.some((f) => f.url === artifactName(version)), "The feed has no arm64 ZIP.");
  return { version, files: files.map((f) => f.url) };
}

/** Replace the channel's feed with one it carried before. The ZIPs stay as
 * they are; the gateway accepts the feed only if it already holds every file
 * the feed names, at that size and SHA-512. Nothing else is uploaded. */
export async function repointFeed(feedBytes, apiOrigin, key, fetchImpl = fetch) {
  assert(typeof key === "string" && key.length >= 32 && key.length <= 256 && !/[\s\x00-\x1f]/.test(key), "MARKIE_PRIVATE_PUBLISH_KEY is required to publish.");
  const feed = parseChannelFeed(feedBytes);
  const url = uploadUrl({ version: feed.version, apiOrigin }, FEED_NAME);
  const response = await fetchImpl(url, {
    method: "PUT", redirect: "error", credentials: "omit",
    headers: { "x-markie-publish-key": key, "x-markie-sha512": digest(feedBytes), "Content-Length": String(feedBytes.length), "Content-Type": "application/yaml" },
    body: feedBytes,
  });
  assert(response.ok, `The gateway refused the feed (${response.status}); the channel still points where it did.`);
  return { version: feed.version, files: feed.files, status: response.status };
}

/** The ZIP's table of contents: every entry inside the bundle, none through a link. */
export function inspectZip(bytes) {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  assert(end >= 0, "The artifact is not a ZIP archive.");
  const total = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  assert(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 8) === total && total !== 0xffff && size !== 0xffffffff && offset !== 0xffffffff, "Multi-disk and ZIP64 archives are not supported.");
  assert(total > 0 && total < 50000 && offset + size <= end, "The ZIP's entry count or directory is out of bounds.");
  const names = new Set(), links = [];
  let at = offset, expanded = 0;
  for (let i = 0; i < total; i++) {
    assert(at + 46 <= offset + size && bytes.readUInt32LE(at) === 0x02014b50, "The ZIP directory is damaged.");
    const madeBy = bytes.readUInt16LE(at + 4), flags = bytes.readUInt16LE(at + 8), unpacked = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extraLength = bytes.readUInt16LE(at + 30), commentLength = bytes.readUInt16LE(at + 32);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert(!(flags & 1) && unpacked !== 0xffffffff, "The ZIP holds an encrypted or oversized entry.");
    const rest = name.startsWith(`${BUNDLE_NAME}/`) ? name.slice(BUNDLE_NAME.length + 1).replace(/\/$/, "") : null;
    // Plain ASCII only: the Mac's disk treats names that differ by case or Unicode form as one file.
    assert(rest !== null && /^[\x20-\x7e]*$/.test(name) && !name.includes("\\") && (rest === "" || rest.split("/").every((part) => part && part !== "." && part !== "..")), `The ZIP holds an entry outside ${BUNDLE_NAME}.`);
    const key = name.replace(/\/$/, "").toLowerCase();
    assert(!names.has(key), "The ZIP repeats an entry.");
    names.add(key);
    if (madeBy >>> 8 === 3 && (mode & 0o170000) === 0o120000) { assert(unpacked < 4096, "The ZIP holds an oversized link."); links.push(key); }
    expanded += unpacked;
    assert(expanded <= 4 * LIMIT, "The ZIP unpacks beyond the verification limit.");
    at += 46 + nameLength + extraLength + commentLength;
  }
  assert(at === offset + size, "The ZIP directory is damaged.");
  for (const link of links) for (const name of names) assert(!name.startsWith(link + "/"), "The ZIP writes through a link.");
  return { entries: total, expanded, links: links.length };
}

/** `codesign --display --verbose=4`, read the way the updater reads it. */
export function assertSigningAuthority(display) {
  const first = (key) => new RegExp(`(?:^|\\r?\\n)${key}=([^\\r\\n]*)`).exec(display)?.[1];
  assert(first("Identifier") === BUNDLE_ID, `The app is not signed as ${BUNDLE_ID}.`);
  assert(first("Authority") === IDENTITY, "The app is not signed with the reviewed Developer ID Application certificate.");
  assert(first("TeamIdentifier") === TEAM_ID, "The signing team is not the reviewed team.");
  assert(/(?:^|\n)CodeDirectory [^\n]*flags=0x[0-9a-f]+\((?:[a-z-]+,)*runtime(?:,[a-z-]+)*\)/.test(display), "The hardened runtime is not on.");
}

/** Everything a release must be before any byte is uploaded. */
export function verifyRelease(settings, tools = systemTools) {
  const names = readdirSync(settings.output).filter((name) => !name.startsWith("."));
  assert(names.every((name) => name === BUNDLE_NAME || name === FEED_NAME || name === artifactName(settings.version)), "The output folder holds something other than this version's app, ZIP and feed.");
  const feedPath = path.join(settings.output, FEED_NAME), feedBytes = readFileSync(feedPath);
  const feed = parseFeed(feedBytes, settings);
  const file = path.join(settings.output, feed.name);
  assert(lstatSync(file).isFile() && lstatSync(file).size === feed.size, "The ZIP's size is not the feed's.");
  const data = readFileSync(file);
  assert(digest(data) === feed.sha512, "The ZIP's SHA-512 is not the feed's.");
  inspectZip(data);
  assert(process.platform === "darwin", "Verifying a signed nightly needs macOS.");
  const temporary = mkdtempSync(path.join(tmpdir(), "markie-nightly-verify-"));
  try {
    assert(tools.run("/usr/bin/ditto", ["-x", "-k", file, temporary]).ok, "The ZIP could not be unpacked.");
    assert(readdirSync(temporary).length === 1, "The ZIP unpacks to more than the app.");
    const app = path.join(temporary, BUNDLE_NAME), plist = path.join(app, "Contents", "Info.plist");
    // The whole Info.plist is what the generator writes for this version:
    // Markie's identity, markie://, and Markie's document types, entry for entry.
    const read = tools.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
    assert(read.ok, "The app's Info.plist could not be read.");
    const info = JSON.parse(read.stdout);
    assert(info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleName === APP_NAME, "The app in the ZIP is not Markie.");
    assert(info.CFBundleShortVersionString === settings.version && info.CFBundleVersion === settings.version, "The app in the ZIP is another version.");
    // Squirrel.Mac names the installed app after the executable: only Electron's own name keeps /Applications/Markie.app.
    assert(info.CFBundleExecutable === APP_NAME, `The app's executable is ${info.CFBundleExecutable}, not ${APP_NAME}: Squirrel.Mac would install it under another name.`);
    // The copyright line carries the build year, so it is left out of the comparison.
    const comparable = ({ NSHumanReadableCopyright: _year, ...rest }) => rest;
    assert(isDeepStrictEqual(comparable(info), comparable(infoPlist("nightly", settings.version))), "The app's Info.plist is not Markie's: its URL scheme and document types must be exactly Electron Markie's.");
    // Signature first: nothing from the ZIP runs before macOS vouches for it.
    assert(tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]).ok, "The app's code signature is not valid.");
    // As Squirrel.Mac checks it inside a running Electron Markie: nested code, strict, every architecture.
    assert(tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "-R", `=${REQUIREMENT}`, app]).ok, "The app does not satisfy Electron Markie's designated requirement; an installed Electron build would refuse it.");
    const authority = tools.run("/usr/bin/codesign", ["--display", "--verbose=4", app]);
    assert(authority.ok, "The signing authority could not be read.");
    assertSigningAuthority(authority.stderr);
    assert(tools.run("/usr/sbin/spctl", ["--assess", "--type", "execute", app]).ok, "Gatekeeper does not accept the app.");
    assert(tools.run("/usr/bin/xcrun", ["stapler", "validate", app], { env: process.env }).ok, "The notarization ticket is not stapled.");
    // The binary names the commit it was built from; it must be this checkout's.
    const reported = tools.run(path.join(app, "Contents", "MacOS", APP_NAME), ["--version"]);
    assert(reported.ok && reported.stdout.trim() === `${APP_NAME} ${settings.version} (${BUNDLE_ID}) ${settings.gitCommit}`, "The app was not built from the checked-out commit at this version.");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return {
    version: settings.version, gitCommit: settings.gitCommit,
    files: [{ name: feed.name, file, size: feed.size, sha512: feed.sha512 }, { name: FEED_NAME, file: feedPath, size: feedBytes.length, sha512: digest(feedBytes) }],
  };
}

export async function publishFiles(settings, verified, key, fetchImpl = fetch) {
  assert(typeof key === "string" && key.length >= 32 && key.length <= 256 && !/[\s\x00-\x1f]/.test(key), "MARKIE_PRIVATE_PUBLISH_KEY is required to publish.");
  assert(verified.version === settings.version && verified.gitCommit === settings.gitCommit, "Publishing needs the artifacts verified for this version and commit.");
  assert(verified.files.length === 2 && verified.files[0].name === artifactName(settings.version) && verified.files[1].name === FEED_NAME, "Publishing sends this version's ZIP, then the feed, and nothing else.");
  const results = [];
  for (const entry of verified.files) {
    const isFeed = entry.name === FEED_NAME;
    // Hashed again here: the bytes sent are the bytes that were verified.
    const body = readFileSync(entry.file);
    assert(body.length > 0 && body.length <= LIMIT && body.length === entry.size && digest(body) === entry.sha512, "A file changed after verification; nothing more was uploaded.");
    const response = await fetchImpl(uploadUrl(settings, entry.name), {
      method: "PUT", redirect: "error", credentials: "omit",
      headers: { "x-markie-publish-key": key, "x-markie-sha512": entry.sha512, "Content-Length": String(entry.size), "Content-Type": isFeed ? "application/yaml" : "application/octet-stream", ...(isFeed ? {} : { "If-None-Match": "*" }) },
      body,
    });
    // 409 on the ZIP: an earlier attempt already put this name there, and the
    // gateway never overwrites it. Going on is safe, because the gateway
    // accepts the feed only if the ZIP it holds has exactly this feed's size
    // and SHA-512. A different ZIP under this name fails at the feed.
    const already = !isFeed && response.status === 409;
    assert(response.ok || already, `The gateway refused ${isFeed ? "the feed" : "the ZIP"} (${response.status}); ${isFeed ? "the feed was not replaced" : "the feed was not sent"}.`);
    results.push({ name: entry.name, status: response.status, alreadyThere: already });
  }
  return { uploaded: results };
}

export async function runCli(args = process.argv.slice(2), env = process.env, root = rustDir, options = {}) {
  assert(args.length === 1 && ["feed", "verify", "publish", "repoint"].includes(args[0]), "Usage: node rust/scripts/nightly-publish.mjs <feed|verify|publish|repoint>. Version, gateway and key come from the environment.");
  if (args[0] === "repoint") {
    // The roll back: no build is involved, only a feed file kept from an earlier publish.
    const file = env.MARKIE_NIGHTLY_REPOINT_FEED;
    assert(typeof file === "string" && path.isAbsolute(file) && path.basename(file) === FEED_NAME, `MARKIE_NIGHTLY_REPOINT_FEED must be the absolute path of a kept ${FEED_NAME}.`);
    const pointed = await repointFeed(readFileSync(file), gatewayOrigin(env.MARKIE_PRIVATE_API_ORIGIN), env.MARKIE_PRIVATE_PUBLISH_KEY, options.fetch ?? fetch);
    return { command: "repoint", destination: GATEWAY_ORIGIN + LANE_PREFIX, channelNowAt: pointed.version, files: pointed.files };
  }
  const tools = options.tools ?? systemTools;
  const settings = nightlySettings(env, root, options.provenance ?? readProvenance(root, tools));
  if (args[0] === "feed") createFeed(settings);
  const verified = verifyRelease(settings, tools);
  const published = args[0] === "publish" ? await publishFiles(settings, verified, env.MARKIE_PRIVATE_PUBLISH_KEY, options.fetch ?? fetch) : undefined;
  return { command: args[0], version: settings.version, gitCommit: settings.gitCommit, destination: settings.apiOrigin + LANE_PREFIX, files: verified.files.map(({ name, size, sha512 }) => ({ name, size, sha512 })), ...(published ? { uploaded: published.uploaded } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    // Messages here are this script's own fixed sentences; none carries the key.
    console.error(`Nightly publish stopped: ${error instanceof Error ? error.message : "unknown error"}`);
    console.error("Nothing was published past this point, and there is no public fallback.");
    process.exitCode = 1;
  });
}
