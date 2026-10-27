import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  EARLY_STATE_FILE,
  markPromoted,
  markSuperseded,
  markWithdrawn,
  planPromoteDue,
  promotionBlocker,
  recordEarlyPublish,
  resolveSoakDays,
  setHold,
} from "./lib/early-state.mjs";
import {
  expectedLinuxArtifacts,
  linuxChecksumFile,
  linuxEvidenceFile,
  linuxFeedFile,
  verifyLinuxEvidence,
} from "./linux-build-evidence.mjs";

export { expectedLinuxArtifacts };

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderConfigPath = path.join(rootDir, "electron-builder.config.cjs");
const releaseManifestPath = path.join(rootDir, "server/download-manifest.json");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const packageJson = () => readJson(path.join(rootDir, "package.json"));
const releaseManifest = () => readJson(releaseManifestPath);

// Everything the early-access stage and promotion touch outside this process,
// in one place, so tests can replace the bucket, git, and the clock without
// any of them being contacted. Production never calls setReleaseIo; the
// defaults below are the real thing. Functions are late-bound so a default can
// call helpers declared further down this file.
const io = {
  root: rootDir,
  now: () => new Date(),
  pollDelayMs: 5000,
  packageVersion: () => readJson(path.join(io.root, "package.json")).version,
  releaseGitState: () => assertReleaseGitState(),
  promoteGitState: (commit) => assertPromoteGitState(commit),
  publishCredentials: () => assertPublishCredentials(),
  verifyLocal: (platform, { commit } = {}) =>
    platform === "win"
      ? verifyLocalWindowsArtifacts()
      : platform === "linux"
        ? verifyLocalLinuxArtifacts({ commit })
        : verifyLocalMacArtifacts({ verifyTrust: true }),
  publish: (platform, files, version) =>
    platform === "win"
      ? publishWindowsFiles(files, version)
      : platform === "linux"
        ? publishLinuxFiles(files, version)
        : publishFiles(files, version),
  log: (line) => console.log(line),
};

/** Test seam. Returns a function that restores the previous values. */
export function setReleaseIo(overrides) {
  const previous = { ...io };
  Object.assign(io, overrides);
  return () => Object.assign(io, previous);
}

function loadLocalEnv(file = path.join(rootDir, ".env")) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function publicMacPlatform(manifest = releaseManifest()) {
  const platform = manifest.platforms.find(
    (entry) => entry.id === "mac-arm64" && entry.status === "public"
  );
  assert(platform?.feed?.path, "stable manifest needs a public macOS feed path");
  return platform;
}

// "Markie-*-arm64.dmg" is a filename glob, not a regex. Escape everything the
// regex engine would read as syntax, then let `*` mean "the version".
export function artifactPatternRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".+");
  return new RegExp(`^${escaped}$`);
}

// Every platform the manifest publishes, not just the primary one. The Intel
// route shipped on the download page from the same manifest, so a release that
// only verified Apple Silicon could hand Intel users a stale or missing build
// and nothing in the pipeline would notice.
/**
 * The routes of "ready" platforms whose stable feed is in the bucket, i.e. the
 * ones the server is offering now. Same shape as publicDownloadRoutes.
 */
export async function releasedReadyRoutes(manifest = releaseManifest()) {
  const siteUrl = manifest.siteUrl.replace(/\/+$/, "");
  const publicBase = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
  const ready = (manifest.platforms ?? []).filter((entry) => entry.status === "ready" && entry.feed?.path);
  const feeds = new Map();
  const routes = [];
  for (const platform of ready) {
    if (!feeds.has(platform.feed.path)) feeds.set(platform.feed.path, await fetchFeed(`${publicBase}/${platform.feed.path}`));
    if (!feeds.get(platform.feed.path)) continue;
    routes.push({ id: platform.id, url: `${siteUrl}${platform.route}`, artifactPattern: platform.artifactPattern });
  }
  return routes;
}

export function publicDownloadRoutes(manifest = releaseManifest()) {
  const siteUrl = manifest.siteUrl.replace(/\/+$/, "");
  const platforms = (manifest.platforms ?? []).filter((entry) => entry.status === "public");
  assert(platforms.length > 0, "stable manifest needs at least one public platform");
  return platforms.map((platform) => {
    assert(platform.route, `public platform ${platform.id} needs a download route`);
    assert(platform.artifactPattern, `public platform ${platform.id} needs an artifactPattern`);
    return {
      id: platform.id,
      url: `${siteUrl}${platform.route}`,
      artifactPattern: platform.artifactPattern,
    };
  });
}

// `version` selects the channel's feed. It defaults to stable so every existing
// caller keeps pointing at latest-mac.yml; only a beta release asks for its own.
/** @param {object} [manifest] @param {string | null} [version] */
export function releaseUrls(manifest = releaseManifest(), version = null) {
  const platform = publicMacPlatform(manifest);
  const publicBase = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
  const stableFeedPath = platform.feed.path.replace(/^\/+/, "");
  // The beta feed is a sibling of stable in the same directory, so it inherits
  // the bucket and the artifact base without a second manifest entry to keep in
  // step. It is deliberately not a public platform: the website reads the
  // manifest, and an unlisted channel is one nothing public can point at.
  const feedPath = version
    ? [...stableFeedPath.split("/").slice(0, -1), macFeedFile(version)].join("/")
    : stableFeedPath;
  const artifactPath = stableFeedPath.split("/").slice(0, -1).join("/");
  const artifactBaseUrl = artifactPath ? `${publicBase}/${artifactPath}` : publicBase;
  const siteUrl = manifest.siteUrl.replace(/\/+$/, "");
  return {
    feedUrl: `${publicBase}/${feedPath}`,
    artifactBaseUrl,
    downloadPageUrl: `${siteUrl}/download`,
    downloadUrl: `${siteUrl}${platform.route}`,
    latestJsonUrl: `${siteUrl}${manifest.latestManifestRoute}`,
  };
}

export function parseElectronBuilderFeed(text) {
  const version = text.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null;
  const files = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const url = rawLine.match(/^\s*-\s+url:\s*(.+?)\s*$/)?.[1];
    if (url) {
      current = { url: url.replace(/^['"]|['"]$/g, "") };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const sha512 = rawLine.match(/^\s+sha512:\s*(.+?)\s*$/)?.[1];
    if (sha512) current.sha512 = sha512.replace(/^['"]|['"]$/g, "");
    const size = rawLine.match(/^\s+size:\s*(\d+)\s*$/)?.[1];
    if (size) current.size = Number(size);
  }
  return { version, files };
}

async function hashReadable(readable) {
  const hash = createHash("sha512");
  for await (const chunk of readable) hash.update(chunk);
  return hash.digest("base64");
}

const hashFile = (file) => hashReadable(createReadStream(file));

function run(command, args, options = {}) {
  if (!options.quiet) console.log(`[release] ${command} ${(options.displayArgs ?? args).join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    shell: false,
  });
  if (result.error) throw result.error;
  assert(result.status === 0, `${command} failed with exit code ${result.status ?? "unknown"}`);
  return options.capture ? result.stdout.trim() : "";
}

function gitOutput(args) {
  return run("git", args, { capture: true });
}

// A release version is either a stable X.Y.Z or a beta prerelease X.Y.Z-beta.N.
// Only the tag the beta channel actually publishes is accepted: any other
// prerelease label would resolve to a feed file nothing ever writes, so the
// build would upload into a channel with no readers.
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

export function assertVersion(value) {
  assert(RELEASE_VERSION.test(value ?? ""), `invalid release version: ${value ?? "missing"}`);
  return value;
}

/** Which updater channel a version belongs to. */
export function releaseChannel(version) {
  return assertVersion(version).includes("-") ? "beta" : "latest";
}

/**
 * The Electron Builder mac feed file for a version. Beta and stable are
 * separate objects in the same bucket, which is what makes a beta publish
 * incapable of rewriting the feed stable users follow — and what makes
 * withdrawing a beta a matter of restoring one file.
 */
export function macFeedFile(version) {
  return releaseChannel(version) === "beta" ? "beta-mac.yml" : "latest-mac.yml";
}

function versionParts(value) {
  const [core, pre] = assertVersion(value).split("-");
  return {
    nums: core.split(".").map(Number),
    // null for a stable release, which sorts above every prerelease of the
    // same X.Y.Z so that shipping stable after a beta is not read as a
    // downgrade and refused.
    pre: pre ? Number(pre.split(".")[1]) : null,
  };
}

export function compareVersions(left, right) {
  const { nums: a, pre: aPre } = versionParts(left);
  const { nums: b, pre: bPre } = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  // Same X.Y.Z: a prerelease is older than the release it leads to.
  if (aPre === bPre) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return aPre > bPre ? 1 : -1;
}

export function setReleaseVersion(version, root = rootDir) {
  assertVersion(version);
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const mcpPath = path.join(root, "mcp/package.json");
  // The Claude Code plugin manifest is user-visible on install, so it has to
  // move with the release or the marketplace advertises a stale version.
  const pluginPath = path.join(root, "mcp/.claude-plugin/plugin.json");
  const pkg = readJson(packagePath);
  const lock = readJson(lockPath);
  const mcp = readJson(mcpPath);
  const plugin = readJson(pluginPath);
  pkg.version = version;
  lock.version = version;
  assert(lock.packages?.[""], "package-lock.json is missing the root package entry");
  lock.packages[""].version = version;
  mcp.version = version;
  plugin.version = version;
  writeJson(packagePath, pkg);
  writeJson(lockPath, lock);
  writeJson(mcpPath, mcp);
  writeJson(pluginPath, plugin);
  return [packagePath, lockPath, mcpPath, pluginPath];
}

function macAppPaths() {
  return [
    path.join(rootDir, "dist/mac-arm64/Markie.app"),
    path.join(rootDir, "dist/mac/Markie.app"),
  ];
}

function expectedMacArtifacts(version) {
  return [
    `Markie-${version}-arm64.zip`,
    `Markie-${version}-x64.zip`,
    `Markie-${version}-arm64.dmg`,
    `Markie-${version}-x64.dmg`,
  ];
}

function macDiskImages(version, root = rootDir) {
  return expectedMacArtifacts(version)
    .filter((name) => name.endsWith(".dmg"))
    .map((name) => path.join(root, "dist", name));
}

export function notarytoolSubmitPlan(file, credentials = process.env) {
  const appleId = credentials.APPLE_ID;
  const password = credentials.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = credentials.APPLE_TEAM_ID;
  assert(appleId, "missing APPLE_ID");
  assert(password, "missing APPLE_APP_SPECIFIC_PASSWORD");
  assert(teamId, "missing APPLE_TEAM_ID");
  const suffix = ["--wait", "--output-format", "json"];
  return {
    args: [
      "notarytool",
      "submit",
      file,
      "--apple-id",
      appleId,
      "--password",
      password,
      "--team-id",
      teamId,
      ...suffix,
    ],
    displayArgs: [
      "notarytool",
      "submit",
      file,
      "--apple-id",
      "<redacted>",
      "--password",
      "<redacted>",
      "--team-id",
      "<redacted>",
      ...suffix,
    ],
  };
}

export async function refreshMacFeedIntegrity(version, root = rootDir) {
  assertVersion(version);
  const dist = path.join(root, "dist");
  const feedName = macFeedFile(version);
  const feedPath = path.join(dist, feedName);
  const feed = yaml.load(readFileSync(feedPath, "utf8"), { schema: yaml.JSON_SCHEMA });
  assert(feed && typeof feed === "object", `${feedName} must contain an object`);
  assert(Array.isArray(feed.files), `${feedName} must contain files`);
  const expectedNames = new Set(expectedMacArtifacts(version));
  const updated = new Map();
  for (const entry of feed.files) {
    const name = decodeURIComponent(entry.url ?? "");
    assert(expectedNames.has(name), `unexpected macOS feed artifact: ${name || "missing"}`);
    const file = path.join(dist, name);
    assert(existsSync(file), `missing local artifact while refreshing feed: ${name}`);
    entry.size = statSync(file).size;
    entry.sha512 = await hashFile(file);
    updated.set(name, entry);
  }
  assert(updated.size === expectedNames.size, `${feedName} does not cover every macOS artifact`);
  const legacyName = decodeURIComponent(feed.path ?? "");
  const legacyEntry = updated.get(legacyName);
  assert(legacyEntry, `${feedName} legacy path must reference a release artifact`);
  feed.sha512 = legacyEntry.sha512;
  writeFileSync(
    feedPath,
    yaml.dump(feed, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, quotingType: "'" })
  );
  return feedPath;
}

export async function verifyLocalMacArtifacts({ root = rootDir, verifyTrust = false } = {}) {
  const version = assertVersion(readJson(path.join(root, "package.json")).version);
  const dist = path.join(root, "dist");
  const feedName = macFeedFile(version);
  const feedPath = path.join(dist, feedName);
  assert(existsSync(feedPath), `missing dist/${feedName}; run release:prepare:mac first`);
  const feed = parseElectronBuilderFeed(readFileSync(feedPath, "utf8"));
  assert(feed.version === version, `local feed version ${feed.version ?? "missing"} does not match ${version}`);
  const feedNames = new Set(feed.files.map((file) => decodeURIComponent(file.url)));
  for (const name of expectedMacArtifacts(version)) {
    assert(feedNames.has(name), `local updater feed is missing ${name}`);
  }

  const files = [];
  for (const entry of feed.files) {
    const name = decodeURIComponent(entry.url);
    assert(!name.includes("/") && !name.includes(".."), `unsafe artifact name in feed: ${name}`);
    assert(name.includes(`-${version}-`), `artifact does not contain release version ${version}: ${name}`);
    const file = path.join(dist, name);
    assert(existsSync(file), `missing local artifact: ${name}`);
    const size = statSync(file).size;
    assert(size === entry.size, `${name} size ${size} does not match feed size ${entry.size}`);
    const sha512 = await hashFile(file);
    assert(sha512 === entry.sha512, `${name} SHA-512 does not match ${feedName}`);
    const blockmap = `${file}.blockmap`;
    assert(existsSync(blockmap), `missing differential update blockmap: ${path.basename(blockmap)}`);
    files.push({
      name,
      size,
      sha512,
      blockmap: path.basename(blockmap),
      blockmapSize: statSync(blockmap).size,
      blockmapSha512: await hashFile(blockmap),
    });
  }

  if (verifyTrust) {
    assert(process.platform === "darwin", "macOS trust verification must run on macOS");
    const manifest = releaseManifest();
    const updaterPath = path.posix.dirname(publicMacPlatform(manifest).feed.path);
    for (const appPath of macAppPaths()) {
      assert(existsSync(appPath), `missing packaged app: ${path.relative(rootDir, appPath)}`);
      const updateConfigPath = path.join(appPath, "Contents/Resources/app-update.yml");
      assert(existsSync(updateConfigPath), `missing updater config: ${path.relative(rootDir, updateConfigPath)}`);
      const updateConfig = readFileSync(updateConfigPath, "utf8");
      for (const snippet of [
        `provider: ${manifest.storage.provider}`,
        `bucket: ${manifest.storage.bucket}`,
        `endpoint: ${manifest.storage.endpoint}`,
        `region: ${manifest.storage.region}`,
        `path: ${updaterPath}`,
      ]) {
        assert(updateConfig.includes(snippet), `packaged updater config is missing ${snippet}`);
      }
      run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
      run("spctl", ["-a", "-vvv", "-t", "install", appPath]);
      run("xcrun", ["stapler", "validate", appPath]);
    }
    for (const file of macDiskImages(version, root)) {
      run("codesign", ["--verify", "--verbose=2", file]);
      run("spctl", ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", file]);
      run("xcrun", ["stapler", "validate", file]);
    }
  }

  return { version, feedPath, files };
}

function evidenceDir(version) {
  return path.join(io.root, ".release", version);
}

function evidencePath(version, name) {
  return path.join(evidenceDir(version), name);
}

export function unsafeUntrackedFiles(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith(".autoloop/runs/"));
}

function writeEvidence(version, name, value) {
  mkdirSync(evidenceDir(version), { recursive: true });
  writeJson(evidencePath(version, name), value);
}

function assertReleaseGitState() {
  assert(gitOutput(["branch", "--show-current"]) === "main", "production releases must come from main");
  assert(gitOutput(["status", "--porcelain", "--untracked-files=no"]) === "", "tracked files must be clean");
  const unsafeUntracked = unsafeUntrackedFiles(
    gitOutput(["ls-files", "--others", "--exclude-standard"])
  );
  assert(
    unsafeUntracked.length === 0,
    `untracked release inputs must be committed or removed: ${unsafeUntracked.join(", ")}`
  );
  run("git", ["fetch", "origin", "main"]);
  const head = gitOutput(["rev-parse", "HEAD"]);
  const origin = gitOutput(["rev-parse", "origin/main"]);
  assert(head === origin, "HEAD must be pushed to origin/main before preparing or publishing");
  return head;
}

function assertMacReleaseCredentials() {
  for (const name of [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert(process.env[name], `missing ${name}`);
  }
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], {
    capture: true,
  });
  assert(/Developer ID Application/.test(identities), "no Developer ID Application identity is available");
}

function assertPublishCredentials() {
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    assert(process.env[name], `missing ${name}`);
  }
}

function builderBin() {
  const name = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
  const local = path.join(rootDir, "node_modules/.bin", name);
  assert(existsSync(local), "electron-builder is not installed; run npm ci");
  return local;
}

// electron-builder 26.15 dropped the app-builder binary and builds blockmaps in
// JavaScript. This is the call it makes for its own DMG blockmaps, gzip and all,
// so a stapled DMG gets the same blockmap the builder would have written.
function blockMapBuilder() {
  try {
    return createRequire(import.meta.url)("app-builder-lib/out/targets/blockmap/blockmap").buildBlockMap;
  } catch (error) {
    throw new Error(`electron-builder's blockmap builder is missing (${error.message}); run npm ci`);
  }
}

function buildBlockMap(file, output) {
  return blockMapBuilder()(file, "gzip", output);
}

// Everything prepare needs after the forty-minute build, resolved before it.
// 0.9.0's first prepare built, signed and notarized both DMGs, then died on a
// blockmap tool an electron-builder upgrade had removed.
function assertMacReleaseToolchain() {
  builderBin();
  assert(typeof blockMapBuilder() === "function", "electron-builder's blockmap builder is not a function");
}

async function notarizeMacDiskImages(version) {
  for (const file of macDiskImages(version)) {
    assert(existsSync(file), `missing disk image for notarization: ${path.basename(file)}`);
    const submission = notarytoolSubmitPlan(file);
    run("xcrun", submission.args, { displayArgs: submission.displayArgs });
    run("xcrun", ["stapler", "staple", file]);
    run("xcrun", ["stapler", "validate", file]);
    run("codesign", ["--verify", "--verbose=2", file]);
    run("spctl", ["-a", "-vv", "-t", "open", "--context", "context:primary-signature", file]);
    const blockmap = `${file}.blockmap`;
    rmSync(blockmap, { force: true });
    await buildBlockMap(file, blockmap);
  }
  await refreshMacFeedIntegrity(version);
}

async function prepareMac() {
  assert(process.platform === "darwin", "macOS releases must be prepared on macOS");
  const commit = assertReleaseGitState();
  assertMacReleaseCredentials();
  assertMacReleaseToolchain();
  run("npm", ["run", "release:preflight"]);
  rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
  try {
    run(builderBin(), ["--config", builderConfigPath, "--mac", "--publish", "never"]);
  } finally {
    run("npm", ["run", "native:restore"]);
  }
  const version = packageJson().version;
  await notarizeMacDiskImages(version);
  run("npm", ["run", "electron:smoke:mac:arm64"]);
  run("npm", ["run", "electron:smoke:mac:x64"]);
  // Launching the packaged app IS the check here, so the release runner says so
  // itself rather than requiring the operator to remember an environment
  // variable. The consent gate exists to stop an agent or a stray `npm run`
  // booting Markie on somebody's Mac unasked; a release that has already been
  // given an explicit instruction is not that, and without this the whole
  // pipeline stops after notarizing with a message about consent.
  const launchEnv = { ...process.env, MARKIE_ALLOW_E2E: "1" };
  run("npm", ["run", "electron:smoke:mac:launch"], { env: launchEnv });
  run("node", ["scripts/desktop-launch-smoke.mjs", "--platform", "mac", "--arch", "x64"], {
    env: launchEnv,
  });
  const verified = await verifyLocalMacArtifacts({ verifyTrust: true });
  writeEvidence(verified.version, "local.json", {
    schemaVersion: 1,
    version: verified.version,
    platform: "mac",
    commit,
    preparedAt: new Date().toISOString(),
    files: verified.files,
    checks: ["preflight", "package-smoke", "native-launch", "updater-config", "codesign", "gatekeeper", "dmg-notarization", "stapler", "feed-refresh", "sha512"],
  });
  console.log(`[release] prepared and verified Markie ${verified.version}; nothing was uploaded`);
}

async function fetchRequired(url, options = {}) {
  const response = await fetch(url, options);
  assert(response.ok, `${options.method ?? "GET"} ${url} failed with ${response.status}`);
  return response;
}

async function verifyRemoteFile(url, entry, deep) {
  const head = await fetchRequired(url, { method: "HEAD", redirect: "follow" });
  const length = Number(head.headers.get("content-length"));
  if (Number.isFinite(length) && length > 0) {
    assert(length === entry.size, `${entry.url} public size ${length} does not match feed ${entry.size}`);
  }
  if (!deep) return;
  const response = await fetchRequired(url, { redirect: "follow" });
  assert(response.body, `GET ${url} returned no body`);
  const sha512 = await hashReadable(Readable.fromWeb(response.body));
  assert(sha512 === entry.sha512, `${entry.url} public SHA-512 does not match the updater feed`);
}

async function verifyWebsiteContract({ expectedVersion, expectedArtifactUrl, allowVersionMismatch = false }) {
  const urls = releaseUrls();
  const latest = await fetchRequired(`${urls.latestJsonUrl}?release-check=${Date.now()}`, {
    redirect: "follow",
    cache: "no-store",
  });
  const body = await latest.json();
  assert(body.schemaVersion === 2, "latest release JSON has the wrong schema version");
  assert(body.channel === "stable", "latest release JSON is not the stable channel");
  if (!allowVersionMismatch) assert(body.version === expectedVersion, `website latest version is ${body.version}`);
  assert(body.downloadPageUrl === urls.downloadPageUrl, "latest release JSON has the wrong download page URL");
  const mac = body.platforms?.find((platform) => platform.id === "mac-arm64");
  assert(mac?.downloadUrl === urls.downloadUrl, "latest release JSON has the wrong stable macOS URL");
  if (!allowVersionMismatch) assert(mac?.artifactUrl === expectedArtifactUrl, "latest release JSON has stale artifact data");

  const page = await fetchRequired(urls.downloadPageUrl, { redirect: "follow" });
  assert((page.headers.get("content-type") ?? "").includes("text/html"), "download page is not HTML");

  // Every public platform, not only the primary: an Intel user follows
  // /download/mac-intel, and that route has to redirect to an Intel artifact.
  // A "ready" platform joins the contract the moment its stable feed exists,
  // because that is the moment the server starts offering it.
  for (const route of [...publicDownloadRoutes(), ...(await releasedReadyRoutes())]) {
    const listed = body.platforms?.find((platform) => platform.id === route.id);
    assert(listed, `latest release JSON has no ${route.id} platform`);
    assert(
      listed.downloadUrl === route.url,
      `latest release JSON has the wrong ${route.id} download URL`
    );
    const download = await fetch(route.url, { redirect: "manual" });
    assert(
      [301, 302, 307, 308].includes(download.status),
      `${route.id} download route returned ${download.status}`
    );
    const location = download.headers.get("location");
    assert(location, `${route.id} download route sent no redirect target`);
    const name = decodeURIComponent(location.split("?")[0].split("/").pop() ?? "");
    assert(
      artifactPatternRegExp(route.artifactPattern).test(name),
      `${route.id} download route points at ${name || "nothing"}, expected ${route.artifactPattern}`
    );
    if (!allowVersionMismatch && route.url === urls.downloadUrl) {
      assert(location === expectedArtifactUrl, "stable download route points at a stale artifact");
    }
  }
}

export async function verifyPublicMac({ expectedVersion, deep = false, verifyWebsite = true } = {}) {
  const version = assertVersion(expectedVersion ?? packageJson().version);
  const urls = releaseUrls();
  const response = await fetchRequired(urls.feedUrl, { cache: "no-store" });
  const feed = parseElectronBuilderFeed(await response.text());
  assert(feed.version === version, `public updater feed is ${feed.version ?? "missing"}, expected ${version}`);
  for (const name of expectedMacArtifacts(version)) {
    assert(feed.files.some((file) => decodeURIComponent(file.url) === name), `public feed is missing ${name}`);
  }
  for (const entry of feed.files) {
    const artifactUrl = `${urls.artifactBaseUrl}/${encodeURIComponent(decodeURIComponent(entry.url))}`;
    await verifyRemoteFile(artifactUrl, entry, deep);
  }
  const primary = publicMacPlatform();
  const primaryEntry = feed.files.find((entry) =>
    artifactPatternRegExp(primary.artifactPattern).test(decodeURIComponent(entry.url))
  );
  assert(primaryEntry, "public feed has no primary macOS download artifact");
  const primaryUrl = `${urls.artifactBaseUrl}/${encodeURIComponent(decodeURIComponent(primaryEntry.url))}`;
  if (verifyWebsite) {
    await verifyWebsiteContract({ expectedVersion: version, expectedArtifactUrl: primaryUrl });
  }
  return { version, feed, primaryUrl, urls };
}

function assertLocalEvidence(version, commit) {
  const file = evidencePath(version, "local.json");
  assert(existsSync(file), `missing ${path.relative(rootDir, file)}; run release:prepare:mac`);
  const evidence = readJson(file);
  assert(evidence.version === version, "local release evidence version is stale");
  assert(evidence.commit === commit, "local release evidence was produced for a different commit");
  return evidence;
}

export function assertEvidenceMatchesArtifacts(evidenceFiles, actualFiles) {
  const normalized = (files) =>
    files
      .map(({ name, size, sha512, blockmap, blockmapSize, blockmapSha512 }) => ({
        name,
        size,
        sha512,
        blockmap,
        blockmapSize,
        blockmapSha512,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  assert(
    JSON.stringify(normalized(evidenceFiles ?? [])) === JSON.stringify(normalized(actualFiles ?? [])),
    "current dist artifacts do not match the smoke-tested local release evidence"
  );
}

function publishFiles(files, version) {
  run(builderBin(), [
    "publish",
    "--config",
    builderConfigPath,
    "--files",
    ...files,
    "--version",
    version,
    "--policy",
    "always",
  ]);
}

async function waitForFeedVersion(feedUrl, version, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${feedUrl}?release-check=${Date.now()}`, { cache: "no-store" });
      if (response.ok && parseElectronBuilderFeed(await response.text()).version === version) return;
    } catch {
      // Retry propagation failures below.
    }
    await new Promise((resolve) => setTimeout(resolve, io.pollDelayMs));
  }
  throw new Error(`updater feed ${feedUrl} did not reach ${version}`);
}

async function waitForPublicFeed(version, attempts = 12) {
  return waitForFeedVersion(releaseUrls().feedUrl, version, attempts);
}

export async function waitForWebsiteVersion(version, attempts = 72, delayMs = 5000) {
  const { latestJsonUrl } = releaseUrls();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${latestJsonUrl}?release-check=${Date.now()}`, {
        cache: "no-store",
      });
      if (response.ok && (await response.json()).version === version) return;
    } catch {
      // Retry the server's short release cache below.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`stable website release manifest did not reach ${version}`);
}

async function publishMac(confirmVersion) {
  const version = packageJson().version;
  assert(confirmVersion === version, `pass --confirm-public-release=${version} to publish production`);
  const commit = assertReleaseGitState();
  assertPublishCredentials();
  const evidence = assertLocalEvidence(version, commit);
  const local = await verifyLocalMacArtifacts({ verifyTrust: true });
  assertEvidenceMatchesArtifacts(evidence.files, local.files);

  await verifyWebsiteContract({ allowVersionMismatch: true });
  const urls = releaseUrls();
  const previousFeed = await fetchRequired(urls.feedUrl, { cache: "no-store" });
  const previousFeedText = await previousFeed.text();
  const previousVersion = parseElectronBuilderFeed(previousFeedText).version;
  assertVersion(previousVersion);
  assert(
    compareVersions(version, previousVersion) > 0,
    `release ${version} must be newer than public feed ${previousVersion}`
  );
  mkdirSync(evidenceDir(version), { recursive: true });
  writeFileSync(evidencePath(version, "previous-latest-mac.yml"), previousFeedText);

  const artifactFiles = local.files.flatMap((file) => [
    path.join(rootDir, "dist", file.name),
    path.join(rootDir, "dist", file.blockmap),
  ]);
  publishFiles(artifactFiles, version);
  for (const file of local.files) {
    await verifyRemoteFile(`${urls.artifactBaseUrl}/${encodeURIComponent(file.name)}`, file, true);
    await verifyRemoteFile(
      `${urls.artifactBaseUrl}/${encodeURIComponent(file.blockmap)}`,
      {
        url: file.blockmap,
        size: file.blockmapSize,
        sha512: file.blockmapSha512,
      },
      true
    );
  }

  publishFiles([local.feedPath], version);
  await waitForPublicFeed(version);
  await waitForWebsiteVersion(version);
  const verified = await verifyPublicMac({ expectedVersion: version, deep: false });
  writeEvidence(version, "public.json", {
    schemaVersion: 1,
    version,
    platform: "mac",
    commit,
    publishedAt: new Date().toISOString(),
    feedUrl: verified.urls.feedUrl,
    downloadPageUrl: verified.urls.downloadPageUrl,
    latestJsonUrl: verified.urls.latestJsonUrl,
    primaryUrl: verified.primaryUrl,
    checks: ["remote-size", "remote-sha512", "stable-download-route", "latest-release-json"],
  });
  console.log(`[release] Markie ${version} is public and verified`);
  await mirrorStableAfterPublish("mac", version, local.feedPath);
  console.log(`[release] final human check: open the previous Markie release and confirm Check for Updates shows ${version}`);
}

async function rollbackMac(confirmVersion) {
  // The version comes from the confirmation, not package.json. A promoted
  // release goes stable days after it was cut, and main may have moved to the
  // next version by then; the saved previous feed is what proves the version
  // was really published from here.
  assert(confirmVersion, `pass --confirm-rollback=<version> to restore the feed saved before that release`);
  const version = assertVersion(confirmVersion);
  assertPublishCredentials();
  const previous = evidencePath(version, "previous-latest-mac.yml");
  assert(existsSync(previous), `missing ${path.relative(rootDir, previous)}`);
  const rollbackDir = path.join(evidenceDir(version), "rollback");
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackFeed = path.join(rollbackDir, macFeedFile(version));
  copyFileSync(previous, rollbackFeed);
  const previousVersion = parseElectronBuilderFeed(readFileSync(previous, "utf8")).version;
  assertVersion(previousVersion);
  publishFiles([rollbackFeed], previousVersion);
  await waitForPublicFeed(previousVersion);
  await waitForWebsiteVersion(previousVersion);
  await verifyPublicMac({ expectedVersion: previousVersion, deep: false });
  console.log(`[release] restored the public macOS updater feed to ${previousVersion}`);
}

async function status() {
  const pkg = packageJson();
  const urls = releaseUrls();
  const result = {
    packageVersion: pkg.version,
    commit: gitOutput(["rev-parse", "--short", "HEAD"]),
    feedUrl: urls.feedUrl,
    downloadPageUrl: urls.downloadPageUrl,
    latestJsonUrl: urls.latestJsonUrl,
    publicFeedVersion: null,
    websiteVersion: null,
  };
  try {
    const response = await fetch(urls.feedUrl, { cache: "no-store" });
    if (response.ok) result.publicFeedVersion = parseElectronBuilderFeed(await response.text()).version;
  } catch {}
  try {
    const response = await fetch(urls.latestJsonUrl, { cache: "no-store" });
    if (response.ok) result.websiteVersion = (await response.json()).version ?? null;
  } catch {}
  try {
    result.linuxFeedVersion = (await fetchFeed(earlyTarget("linux").stableFeedUrl))?.version ?? null;
  } catch {
    result.linuxFeedVersion = null;
  }
  Object.assign(result, await earlyStatus());
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Windows
//
// The Windows build cannot be produced here. It is signed by Azure Artifact
// Signing from CI, because no certificate exists on this machine and putting
// one here is not the goal. So the local half of a Windows release is not
// "build and upload" but "fetch what CI signed, prove it is what it claims to
// be, and publish that" — which is why every check below runs against the
// downloaded bytes rather than against anything CI reported about them.
// ---------------------------------------------------------------------------

const WINDOWS_RELEASE_TAG = "windows-signed";

function windowsDistDir(root = rootDir) {
  // Deliberately not dist/. The macOS prepare deletes dist/ wholesale, and a
  // Windows artifact set that disappears halfway through a release is a very
  // confusing thing to debug.
  return path.join(root, "dist-windows");
}

function windowsPlatform(manifest = releaseManifest()) {
  const platform = manifest.platforms.find((entry) => entry.id === "windows-x64");
  assert(platform?.feed?.path, "release manifest needs a Windows updater feed path");
  assert(platform.codeSigning?.subject, "release manifest needs the expected Windows signer subject");
  return platform;
}

function windowsFeedFile(version) {
  return releaseChannel(version) === "beta" ? "beta.yml" : "latest.yml";
}

// Only the installer. electron-builder's Windows feed lists the NSIS target and
// nothing else — differential updates on Windows are the installer plus its
// blockmap — so the portable .zip is not part of the update surface. It stays
// on the GitHub release tag for anyone who wants it and is not copied to the
// bucket, where nothing would link to it.
export function expectedWindowsArtifacts(version) {
  return [`Markie-${version}-x64.exe`];
}

// A distinguished name, compared as a set of components rather than as a
// string, because the two sides spell the same name differently. openssl prints
// `CN = ZVN DEV LLC, C = US` with spaces around each equals and calls the state
// ST=; Windows prints `CN=ZVN DEV LLC, C=US` and calls it S=. Component order
// is not guaranteed to survive the round trip either. Comparing the raw strings
// rejects the correct certificate, which is a failure that looks exactly like
// the wrong certificate.
export function normalizeDistinguishedName(value) {
  return (value ?? "")
    .replace(/^subject\s*=\s*/i, "")
    .split(/,\s*(?=[A-Za-z]+\s*=)/)
    .map((part) => part.trim().replace(/\s*=\s*/, "=").replace(/^ST=/i, "S="))
    .filter(Boolean)
    .sort()
    .join(", ");
}

// The Authenticode signature lives in the PE's certificate table, which is the
// fifth entry of the optional header's data directory. Everything here is
// offsets into a file format, so it reads badly, but the alternative is
// shipping on CI's say-so.
export function extractAuthenticodeDer(buffer) {
  assert(buffer.length > 0x40 && buffer.readUInt16LE(0) === 0x5a4d, "not a PE binary (no MZ header)");
  const peOffset = buffer.readUInt32LE(0x3c);
  assert(buffer.readUInt32LE(peOffset) === 0x00004550, "not a PE binary (no PE signature)");
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  assert(magic === 0x10b || magic === 0x20b, `unknown PE optional header magic 0x${magic.toString(16)}`);
  // PE32+ widens four fields before the data directory; PE32 also carries an
  // extra BaseOfData. This is the only difference that matters here.
  const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : 96);
  const certificateEntry = dataDirectory + 4 * 8;
  const address = buffer.readUInt32LE(certificateEntry);
  const size = buffer.readUInt32LE(certificateEntry + 4);
  assert(address > 0 && size > 0, "binary carries no Authenticode certificate table — it is not signed");
  assert(address + size <= buffer.length, "certificate table runs past the end of the file");
  // WIN_CERTIFICATE: dwLength, wRevision, wCertificateType, then the blob.
  const declaredLength = buffer.readUInt32LE(address);
  const certificateType = buffer.readUInt16LE(address + 6);
  assert(certificateType === 0x0002, `unexpected certificate type 0x${certificateType.toString(16)}, expected PKCS#7`);
  return buffer.subarray(address + 8, address + Math.min(declaredLength, size));
}

export function authenticodeSubjects(der, openssl = "openssl") {
  const result = spawnSync(openssl, ["pkcs7", "-inform", "DER", "-print_certs", "-noout"], {
    input: der,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert(result.status === 0, `openssl could not read the Authenticode signature: ${result.stderr?.trim()}`);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("subject="))
    .map((line) => line.slice("subject=".length).trim());
}

function assertWindowsSignature(file, expectedSubject) {
  const subjects = authenticodeSubjects(extractAuthenticodeDer(readFileSync(file)));
  const expected = normalizeDistinguishedName(expectedSubject);
  const matched = subjects.some((subject) => normalizeDistinguishedName(subject) === expected);
  assert(
    matched,
    `${path.basename(file)} is signed by ${subjects.join(" | ") || "nobody"}, expected ${expectedSubject}`
  );
}

async function verifyLocalWindowsArtifacts({ root = rootDir } = {}) {
  const version = assertVersion(readJson(path.join(root, "package.json")).version);
  const dist = windowsDistDir(root);
  const platform = windowsPlatform();
  const feedName = windowsFeedFile(version);
  const feedPath = path.join(dist, feedName);
  assert(existsSync(feedPath), `missing ${path.relative(root, feedPath)}; run release:prepare:win first`);
  const feed = parseElectronBuilderFeed(readFileSync(feedPath, "utf8"));
  assert(feed.version === version, `Windows feed version ${feed.version ?? "missing"} does not match ${version}`);
  const feedNames = new Set(feed.files.map((file) => decodeURIComponent(file.url)));
  for (const name of expectedWindowsArtifacts(version)) {
    assert(feedNames.has(name), `Windows updater feed is missing ${name}`);
  }

  const files = [];
  for (const entry of feed.files) {
    const name = decodeURIComponent(entry.url);
    assert(!name.includes("/") && !name.includes(".."), `unsafe artifact name in feed: ${name}`);
    assert(name.includes(`-${version}-`), `artifact does not contain release version ${version}: ${name}`);
    const file = path.join(dist, name);
    assert(existsSync(file), `missing local artifact: ${name}`);
    const size = statSync(file).size;
    assert(size === entry.size, `${name} size ${size} does not match feed size ${entry.size}`);
    const sha512 = await hashFile(file);
    assert(sha512 === entry.sha512, `${name} SHA-512 does not match ${feedName}`);
    // The installer is the thing SmartScreen judges, so it is the thing whose
    // signature has to be proven here rather than assumed from the CI log.
    if (name.endsWith(".exe")) assertWindowsSignature(file, platform.codeSigning.subject);
    const record = { name, size, sha512 };
    const blockmap = `${file}.blockmap`;
    if (existsSync(blockmap)) {
      record.blockmap = path.basename(blockmap);
      record.blockmapSize = statSync(blockmap).size;
      record.blockmapSha512 = await hashFile(blockmap);
    }
    files.push(record);
  }
  return { version, files, feedPath, feedName, signerSubject: platform.codeSigning.subject };
}

function downloadSignedWindowsRelease(version) {
  const dist = windowsDistDir();
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // Named patterns, not a bare download of everything on the tag. The tag is a
  // rolling one, so a stale asset from an earlier version would otherwise be
  // downloaded alongside this one and quietly widen what gets published.
  const patterns = [
    ...expectedWindowsArtifacts(version).flatMap((name) => [name, `${name}.blockmap`]),
    windowsFeedFile(version),
  ];
  assert(patterns.length > 0, "no Windows artifacts to download");
  run("gh", [
    "release",
    "download",
    WINDOWS_RELEASE_TAG,
    "--repo",
    "zvndev/markie",
    "--dir",
    dist,
    "--clobber",
    ...patterns.flatMap((pattern) => ["--pattern", pattern]),
  ]);
}

async function prepareWindows() {
  const commit = assertReleaseGitState();
  const version = packageJson().version;
  downloadSignedWindowsRelease(version);
  const verified = await verifyLocalWindowsArtifacts();
  writeEvidence(verified.version, "local-windows.json", {
    schemaVersion: 1,
    version: verified.version,
    platform: "windows",
    commit,
    preparedAt: new Date().toISOString(),
    signerSubject: verified.signerSubject,
    files: verified.files,
    checks: ["feed-version", "artifact-sha512", "authenticode-subject"],
  });
  console.log(
    `[release] fetched and verified signed Windows artifacts for Markie ${verified.version}; nothing was uploaded`
  );
  console.log(`[release] installer is signed by ${verified.signerSubject}`);
}

// electron-builder's `publish` command reads the top-level publish block, which
// points at the macOS directory. Rather than override it on the command line —
// where a typo silently uploads Windows artifacts over the macOS feed — the
// Windows publish gets a config file of its own, generated from the manifest.
function windowsPublishConfigPath() {
  const platform = windowsPlatform();
  const manifest = releaseManifest();
  const file = path.join(windowsDistDir(), "publish-windows.json");
  writeJson(file, {
    appId: "com.zvn.markie",
    productName: "Markie",
    publish: [
      {
        provider: manifest.storage.provider,
        bucket: manifest.storage.bucket,
        endpoint: manifest.storage.endpoint,
        region: manifest.storage.region,
        path: path.posix.dirname(platform.feed.path),
      },
    ],
  });
  return file;
}

function publishWindowsFiles(files, version) {
  run(builderBin(), [
    "publish",
    "--config",
    windowsPublishConfigPath(),
    "--files",
    ...files,
    "--version",
    version,
    "--policy",
    "always",
  ]);
}

async function publishWindows(confirmVersion) {
  const version = packageJson().version;
  assert(confirmVersion === version, `pass --confirm-public-release=${version} to publish production`);
  const commit = assertReleaseGitState();
  assertPublishCredentials();
  const evidence = assertWindowsEvidence(version, commit);
  const local = await verifyLocalWindowsArtifacts();
  assertEvidenceMatchesArtifacts(evidence.files, local.files);

  const dist = windowsDistDir();
  const publicBase = releaseManifest().storage.publicBaseUrl.replace(/\/+$/, "");
  const artifactBaseUrl = `${publicBase}/${path.posix.dirname(windowsPlatform().feed.path)}`;

  // The feed as it stands before this release is saved for the same two reasons
  // it is on macOS: a rollback needs the exact bytes to restore, and the update
  // check needs to know which version an installed app is updating *from*. This
  // was missing, which is part of why the Windows update leg had no automation
  // to run even once there was a runner to run it on.
  const previousFeedText = await (
    await fetchRequired(`${artifactBaseUrl}/${path.posix.basename(windowsPlatform().feed.path)}`, {
      cache: "no-store",
    })
  ).text();
  const previousVersion = parseElectronBuilderFeed(previousFeedText).version;
  assertVersion(previousVersion);
  assert(
    compareVersions(version, previousVersion) > 0,
    `release ${version} must be newer than public Windows feed ${previousVersion}`
  );
  mkdirSync(evidenceDir(version), { recursive: true });
  writeFileSync(evidencePath(version, "previous-latest.yml"), previousFeedText);

  const artifactFiles = local.files.flatMap((file) =>
    file.blockmap ? [path.join(dist, file.name), path.join(dist, file.blockmap)] : [path.join(dist, file.name)]
  );
  publishWindowsFiles(artifactFiles, version);
  for (const file of local.files) {
    await verifyRemoteFile(`${artifactBaseUrl}/${encodeURIComponent(file.name)}`, file, true);
    if (!file.blockmap) continue;
    await verifyRemoteFile(
      `${artifactBaseUrl}/${encodeURIComponent(file.blockmap)}`,
      { url: file.blockmap, size: file.blockmapSize, sha512: file.blockmapSha512 },
      true
    );
  }
  // The feed goes last, exactly as it does for macOS: it is the pointer, and a
  // pointer published before what it points at is a broken update for everyone
  // who checks in between.
  publishWindowsFiles([local.feedPath], version);
  writeEvidence(version, "public-windows.json", {
    schemaVersion: 1,
    version,
    platform: "windows",
    commit,
    publishedAt: new Date().toISOString(),
    feedUrl: `${artifactBaseUrl}/${local.feedName}`,
    signerSubject: local.signerSubject,
    files: local.files,
    checks: ["remote-size", "remote-sha512", "authenticode-subject"],
  });
  console.log(`[release] Markie ${version} Windows artifacts are public at ${artifactBaseUrl}`);
  await mirrorStableAfterPublish("win", version, local.feedPath);
}

// The Windows twin of rollbackMac. It exists now because publishWindows (and
// promotion) save the previous windows/latest.yml before replacing it, which
// was the missing piece that kept this command out.
async function rollbackWindows(confirmVersion) {
  assert(confirmVersion, `pass --confirm-rollback=<version> to restore the feed saved before that release`);
  const version = assertVersion(confirmVersion);
  assertPublishCredentials();
  const target = earlyTarget("win");
  const previous = evidencePath(version, target.previousStableFile);
  assert(existsSync(previous), `missing ${path.relative(io.root, previous)}`);
  const rollbackDir = path.join(evidenceDir(version), "rollback");
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackFeed = path.join(rollbackDir, target.stableFeedFile);
  copyFileSync(previous, rollbackFeed);
  const previousVersion = assertVersion(parseElectronBuilderFeed(readFileSync(previous, "utf8")).version);
  io.publish("win", [rollbackFeed], previousVersion);
  await waitForFeedVersion(target.stableFeedUrl, previousVersion);
  await verifyPublicWindows({ expectedVersion: previousVersion, deep: false });
  console.log(`[release] restored the public Windows updater feed to ${previousVersion}`);
}

function assertWindowsEvidence(version, commit) {
  const file = evidencePath(version, "local-windows.json");
  assert(existsSync(file), `missing ${path.relative(rootDir, file)}; run release:prepare:win`);
  const evidence = readJson(file);
  assert(evidence.version === version, "local Windows release evidence version is stale");
  assert(evidence.commit === commit, "local Windows release evidence was produced for a different commit");
  return evidence;
}

export async function verifyPublicWindows({ expectedVersion, deep = false } = {}) {
  const version = assertVersion(expectedVersion ?? packageJson().version);
  const platform = windowsPlatform();
  const publicBase = releaseManifest().storage.publicBaseUrl.replace(/\/+$/, "");
  const artifactBaseUrl = `${publicBase}/${path.posix.dirname(platform.feed.path)}`;
  const feedUrl = `${publicBase}/${platform.feed.path}`;
  const response = await fetchRequired(`${feedUrl}?release-check=${Date.now()}`, { cache: "no-store" });
  const feed = parseElectronBuilderFeed(await response.text());
  assert(feed.version === version, `public Windows feed is ${feed.version ?? "missing"}, expected ${version}`);
  for (const name of expectedWindowsArtifacts(version)) {
    assert(feed.files.some((file) => decodeURIComponent(file.url) === name), `public Windows feed is missing ${name}`);
  }
  for (const entry of feed.files) {
    const name = decodeURIComponent(entry.url);
    await verifyRemoteFile(`${artifactBaseUrl}/${encodeURIComponent(name)}`, entry, deep);
  }
  return { version, feedUrl, artifactBaseUrl };
}

// ---------------------------------------------------------------------------
// Linux
//
// Built in CI like Windows, for a different reason: a Linux package has to be
// compiled and launched on Linux, and the release machine is a Mac. The local
// half is the same shape as Windows ("fetch what CI built, prove it is what it
// claims to be, publish that"), with one difference. Nothing is signed, by
// design, so there is no signature to prove provenance with. Instead the
// workflow writes build evidence (exact commit, run, checks passed, SHA-512 of
// each package) and a SHA512SUMS file next to the packages, and the release
// machine requires all three of feed, evidence and checksums to agree with the
// bytes on disk and the evidence's commit to be the commit being released.
// ---------------------------------------------------------------------------

const LINUX_RELEASE_TAG = "linux-built";

function linuxDistDir(root = io.root) {
  // Not dist/, for the reason dist-windows is not: prepare:mac deletes dist/.
  return path.join(root, "dist-linux");
}

function linuxPlatform(manifest = releaseManifest()) {
  const platform = manifest.platforms.find((entry) => entry.id === "linux-x64");
  assert(platform?.feed?.path, "release manifest needs a Linux updater feed path");
  return platform;
}

// The routes a Linux release serves: the AppImage and the deb, both resolved
// from linux/latest-linux.yml by the server.
function linuxRoutePlatforms(manifest = releaseManifest()) {
  const feedPath = linuxPlatform(manifest).feed.path;
  return manifest.platforms.filter((entry) => entry.os === "linux" && entry.feed?.path === feedPath);
}

/**
 * Whether the stable Linux feed may legitimately not exist yet. True while the
 * manifest marks Linux "ready" (built, wired into this flow, not yet released),
 * which is what lets the very first Linux release go out. Once Linux is flipped
 * to "public", a missing stable feed is an error again, as it is on macOS and
 * Windows.
 */
export function linuxAwaitsFirstRelease(manifest = releaseManifest()) {
  return linuxPlatform(manifest).status === "ready";
}

/** @param {{ root?: string, commit?: string | null }} [options] */
export async function verifyLocalLinuxArtifacts({ root = io.root, commit = null } = {}) {
  const version = assertVersion(readJson(path.join(root, "package.json")).version);
  const dist = linuxDistDir(root);
  const feedName = linuxFeedFile(version);
  const feedPath = path.join(dist, feedName);
  assert(existsSync(feedPath), `missing ${path.relative(root, feedPath)}; run release:prepare:linux first`);
  const feed = parseElectronBuilderFeed(readFileSync(feedPath, "utf8"));
  assert(feed.version === version, `Linux feed version ${feed.version ?? "missing"} does not match ${version}`);
  const feedNames = new Set(feed.files.map((file) => decodeURIComponent(file.url)));
  for (const name of expectedLinuxArtifacts(version)) {
    assert(feedNames.has(name), `Linux updater feed is missing ${name}`);
  }

  const files = [];
  for (const entry of feed.files) {
    const name = decodeURIComponent(entry.url);
    assert(!name.includes("/") && !name.includes(".."), `unsafe artifact name in feed: ${name}`);
    assert(name.includes(`-${version}-`), `artifact does not contain release version ${version}: ${name}`);
    const file = path.join(dist, name);
    assert(existsSync(file), `missing local artifact: ${name}`);
    const size = statSync(file).size;
    assert(size === entry.size, `${name} size ${size} does not match feed size ${entry.size}`);
    const sha512 = await hashFile(file);
    assert(sha512 === entry.sha512, `${name} SHA-512 does not match ${feedName}`);
    // An AppImage carries its blockmap inside the file and a deb has none, so
    // a separate .blockmap is not expected; one that is present still has to
    // be accounted for, because it would be uploaded.
    const record = { name, size, sha512 };
    const blockmap = `${file}.blockmap`;
    if (existsSync(blockmap)) {
      record.blockmap = path.basename(blockmap);
      record.blockmapSize = statSync(blockmap).size;
      record.blockmapSha512 = await hashFile(blockmap);
    }
    files.push(record);
  }
  const evidence = verifyLinuxEvidence({ dist, version, commit, files });
  return {
    version,
    files,
    feedPath,
    feedName,
    buildCommit: evidence.commit,
    buildRunUrl: evidence.runUrl ?? null,
    buildChecks: evidence.checks,
    signing: "unsigned-by-design",
  };
}

function downloadBuiltLinuxRelease(version) {
  const dist = linuxDistDir();
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // Named patterns only, as for Windows: the tag is rolling, and a stale asset
  // from an earlier version must not ride along into what gets published.
  const patterns = [
    ...expectedLinuxArtifacts(version),
    linuxFeedFile(version),
    linuxEvidenceFile(version),
    linuxChecksumFile(version),
  ];
  run("gh", [
    "release",
    "download",
    LINUX_RELEASE_TAG,
    "--repo",
    "zvndev/markie",
    "--dir",
    dist,
    "--clobber",
    ...patterns.flatMap((pattern) => ["--pattern", pattern]),
  ]);
}

async function prepareLinux() {
  const commit = assertReleaseGitState();
  const version = packageJson().version;
  downloadBuiltLinuxRelease(version);
  const verified = await verifyLocalLinuxArtifacts({ commit });
  writeEvidence(verified.version, "local-linux.json", {
    schemaVersion: 1,
    version: verified.version,
    platform: "linux",
    commit,
    preparedAt: new Date().toISOString(),
    signing: verified.signing,
    buildRunUrl: verified.buildRunUrl,
    buildChecks: verified.buildChecks,
    files: verified.files,
    checks: ["ci-exact-commit", "ci-launch-smoke", "feed-version", "artifact-sha512", "sha512sums", "unsigned-by-design"],
  });
  console.log(
    `[release] fetched and verified Linux packages for Markie ${verified.version}; nothing was uploaded`
  );
  console.log(`[release] built at ${verified.buildCommit} by ${verified.buildRunUrl ?? "an unrecorded run"}; unsigned by design`);
}

function assertLinuxEvidence(version, commit) {
  const file = evidencePath(version, "local-linux.json");
  assert(existsSync(file), `missing ${path.relative(io.root, file)}; run release:prepare:linux`);
  const evidence = readJson(file);
  assert(evidence.version === version, "local Linux release evidence version is stale");
  assert(evidence.commit === commit, "local Linux release evidence was produced for a different commit");
  return evidence;
}

// Its own generated config for the same reason Windows has one: the builder's
// top-level publish block points at mac/, and an override typed on a command
// line is one typo from writing Linux packages over the macOS feed.
function linuxPublishConfigPath() {
  const manifest = releaseManifest();
  const file = path.join(linuxDistDir(), "publish-linux.json");
  writeJson(file, {
    appId: "com.zvn.markie",
    productName: "Markie",
    publish: [
      {
        provider: manifest.storage.provider,
        bucket: manifest.storage.bucket,
        endpoint: manifest.storage.endpoint,
        region: manifest.storage.region,
        path: path.posix.dirname(linuxPlatform(manifest).feed.path),
      },
    ],
  });
  return file;
}

function publishLinuxFiles(files, version) {
  run(builderBin(), [
    "publish",
    "--config",
    linuxPublishConfigPath(),
    "--files",
    ...files,
    "--version",
    version,
    "--policy",
    "always",
  ]);
}

/** Has the deployed server been taught about Linux? Asked before Linux goes stable. */
async function assertServerKnowsLinux() {
  const { latestJsonUrl } = releaseUrls();
  const body = await (await fetchRequired(`${latestJsonUrl}?release-check=${Date.now()}`, { cache: "no-store" })).json();
  const ids = new Set([...(body.platforms ?? []).map((entry) => entry.id), ...(body.awaitingFirstRelease ?? [])]);
  const missing = linuxRoutePlatforms().filter((entry) => !ids.has(entry.id)).map((entry) => entry.id);
  assert(
    missing.length === 0,
    `the deployed server does not know ${missing.join(", ")}; deploy the server from this commit before Linux goes stable`
  );
}

// The server caches a resolved release for five minutes and a missing feed for
// one, so the routes can trail the feed by that much.
async function waitForLinuxRoutes(version, attempts = 72) {
  const manifest = releaseManifest();
  const siteUrl = manifest.siteUrl.replace(/\/+$/, "");
  const publicBase = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
  const directory = path.posix.dirname(linuxPlatform(manifest).feed.path);
  for (const entry of linuxRoutePlatforms(manifest)) {
    const expected = expectedLinuxArtifacts(version).find((name) => artifactPatternRegExp(entry.artifactPattern).test(name));
    assert(expected, `no ${version} artifact matches ${entry.artifactPattern}`);
    const expectedUrl = `${publicBase}/${directory}/${encodeURIComponent(expected)}`;
    let location = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(`${siteUrl}${entry.route}`, { redirect: "manual" });
        location = response.headers.get("location");
        if ([301, 302, 307, 308].includes(response.status) && location === expectedUrl) break;
      } catch {
        // Retry below.
      }
      location = null;
      await new Promise((resolve) => setTimeout(resolve, io.pollDelayMs));
    }
    assert(location === expectedUrl, `${siteUrl}${entry.route} did not reach ${expected}`);
  }
}

export async function verifyPublicLinux({ expectedVersion, deep = false, verifyWebsite = true } = {}) {
  const version = assertVersion(expectedVersion ?? packageJson().version);
  const target = earlyTarget("linux");
  const response = await fetchRequired(`${target.stableFeedUrl}?release-check=${Date.now()}`, { cache: "no-store" });
  const feed = parseElectronBuilderFeed(await response.text());
  assert(feed.version === version, `public Linux feed is ${feed.version ?? "missing"}, expected ${version}`);
  for (const name of expectedLinuxArtifacts(version)) {
    assert(feed.files.some((file) => decodeURIComponent(file.url) === name), `public Linux feed is missing ${name}`);
  }
  for (const entry of feed.files) {
    await verifyRemoteFile(`${target.artifactBaseUrl}/${encodeURIComponent(decodeURIComponent(entry.url))}`, entry, deep);
  }
  if (verifyWebsite) await waitForLinuxRoutes(version);
  return { version, feedUrl: target.stableFeedUrl, artifactBaseUrl: target.artifactBaseUrl };
}

/** Direct stable publish, for a release Kirby asked to skip early access. */
async function publishLinux(confirmVersion) {
  const version = packageJson().version;
  assert(confirmVersion === version, `pass --confirm-public-release=${version} to publish production`);
  const commit = assertReleaseGitState();
  assertPublishCredentials();
  const evidence = assertLinuxEvidence(version, commit);
  const local = await verifyLocalLinuxArtifacts({ commit });
  assertEvidenceMatchesArtifacts(evidence.files, local.files);
  const target = earlyTarget("linux");

  const previous = await fetchFeed(target.stableFeedUrl);
  assert(previous || target.allowsFirstRelease, `the stable Linux feed ${target.stableFeedUrl} is missing`);
  if (previous) {
    assertVersion(previous.version);
    assert(
      compareVersions(version, previous.version) > 0,
      `release ${version} must be newer than public Linux feed ${previous.version}`
    );
    mkdirSync(evidenceDir(version), { recursive: true });
    writeFileSync(evidencePath(version, target.previousStableFile), previous.text);
  }
  if (target.allowsFirstRelease) await assertServerKnowsLinux();

  await uploadAndVerifyArtifacts("linux", local, target.artifactBaseUrl);
  // The feed last, as everywhere else.
  io.publish("linux", [local.feedPath], version);
  await waitForFeedVersion(target.stableFeedUrl, version);
  await verifyPublicLinux({ expectedVersion: version, deep: false });
  writeEvidence(version, target.publicEvidenceFile, {
    schemaVersion: 1,
    version,
    platform: "linux",
    commit,
    publishedAt: new Date().toISOString(),
    feedUrl: target.stableFeedUrl,
    signing: "unsigned-by-design",
    files: local.files,
    checks: ["remote-size", "remote-sha512", "download-routes"],
  });
  console.log(`[release] Markie ${version} Linux packages are public at ${target.artifactBaseUrl}`);
  await mirrorStableAfterPublish("linux", version, local.feedPath);
}

async function rollbackLinux(confirmVersion) {
  assert(confirmVersion, `pass --confirm-rollback=<version> to restore the feed saved before that release`);
  const version = assertVersion(confirmVersion);
  assertPublishCredentials();
  const target = earlyTarget("linux");
  const previous = evidencePath(version, target.previousStableFile);
  // The first Linux release replaced nothing, so there is nothing to restore.
  // Withdrawing it means deleting linux/latest-linux.yml from the bucket, which
  // is a destructive storage operation this runner does not do.
  assert(
    existsSync(previous),
    `missing ${path.relative(io.root, previous)}; if ${version} was the first Linux release there is no earlier feed, ` +
      `and withdrawing it means deleting ${target.stableFeedUrl} by hand`
  );
  const rollbackDir = path.join(evidenceDir(version), "rollback");
  mkdirSync(rollbackDir, { recursive: true });
  const rollbackFeed = path.join(rollbackDir, target.stableFeedFile);
  copyFileSync(previous, rollbackFeed);
  const previousVersion = assertVersion(parseElectronBuilderFeed(readFileSync(previous, "utf8")).version);
  io.publish("linux", [rollbackFeed], previousVersion);
  await waitForFeedVersion(target.stableFeedUrl, previousVersion);
  await verifyPublicLinux({ expectedVersion: previousVersion, deep: false });
  console.log(`[release] restored the public Linux updater feed to ${previousVersion}`);
}

// ---------------------------------------------------------------------------
// Early access, soak, and promotion
//
// A release goes out in two steps. `publish <platform> --early` uploads the
// signed artifacts and writes only the early (beta) feed, so the people who
// turned on "Get new versions early" get it first. After the soak, `promote`
// writes the stable feed, pointing at the very same objects in the bucket.
// Nothing is rebuilt, re-signed, or re-uploaded, which is why early releases
// carry their final version number: the bytes early users ran are, by SHA-512,
// the bytes everyone else gets.
//
// The early feed and the stable feed are siblings in one directory
// (mac/beta-mac.yml beside mac/latest-mac.yml), so the artifact URLs written
// inside the feed resolve identically from either. A feed file does not name
// itself, so promoting is uploading the same YAML under the stable name.
// ---------------------------------------------------------------------------

const PROMOTE_LOCK_STALE_MS = 3 * 60 * 60 * 1000;

const sha512Text = (text) => createHash("sha512").update(text).digest("base64");
const isStableNumbered = (version) => releaseChannel(version) === "latest";

/**
 * Where one platform's early and stable feeds live, and the evidence file
 * names that go with them. Both feed paths come from the manifest; the early
 * one must sit in the same directory as stable, or promotion would point
 * stable users at artifacts that were never uploaded beside their feed.
 */
export function earlyTarget(platform, manifest = releaseManifest()) {
  assert(platform === "mac" || platform === "win" || platform === "linux", `unknown platform: ${platform}`);
  const publicBase = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
  const stablePath = {
    mac: () => publicMacPlatform(manifest).feed.path,
    win: () => windowsPlatform(manifest).feed.path,
    linux: () => linuxPlatform(manifest).feed.path,
  }[platform]();
  const earlyPath = {
    mac: manifest.betaChannel?.feed?.path,
    win: manifest.betaChannel?.windowsFeed?.path,
    linux: manifest.betaChannel?.linuxFeed?.path,
  }[platform];
  assert(earlyPath, `release manifest has no early feed for ${platform}`);
  const directory = path.posix.dirname(stablePath);
  assert(
    path.posix.dirname(earlyPath) === directory,
    `early feed ${earlyPath} must sit beside ${stablePath} so promotion reuses the same artifacts`
  );
  const stableFeedFile = path.posix.basename(stablePath);
  const earlyFeedFile = path.posix.basename(earlyPath);
  assert(stableFeedFile !== earlyFeedFile, "early and stable feeds must be different files");
  return {
    platform,
    label: { mac: "macOS", win: "Windows", linux: "Linux" }[platform],
    artifactBaseUrl: `${publicBase}/${directory}`,
    stableFeedFile,
    earlyFeedFile,
    stableFeedUrl: `${publicBase}/${stablePath}`,
    earlyFeedUrl: `${publicBase}/${earlyPath}`,
    previousStableFile: `previous-${stableFeedFile}`,
    previousEarlyFile: `previous-${earlyFeedFile}`,
    localEvidenceFile: { mac: "local.json", win: "local-windows.json", linux: "local-linux.json" }[platform],
    publicEvidenceFile: { mac: "public.json", win: "public-windows.json", linux: "public-linux.json" }[platform],
    // Only a platform awaiting its first release may have no stable feed yet.
    allowsFirstRelease: platform === "linux" && linuxAwaitsFirstRelease(manifest),
  };
}

/** A feed from the bucket, or null when the object does not exist yet. */
async function fetchFeed(url) {
  const response = await fetch(`${url}?release-check=${Date.now()}`, { cache: "no-store" });
  // Only a 404 means "no such feed". A 403 or 5xx is the bucket or CDN
  // misbehaving, and reading that as "missing" could retire a good release.
  if (response.status === 404) return null;
  assert(response.ok, `GET ${url} failed with ${response.status}`);
  const text = await response.text();
  return { text, ...parseElectronBuilderFeed(text) };
}

function earlyStatePath(version) {
  return evidencePath(version, EARLY_STATE_FILE);
}

function readEarlyState(version) {
  const file = earlyStatePath(version);
  return existsSync(file) ? readJson(file) : null;
}

function writeEarlyState(state) {
  mkdirSync(evidenceDir(state.version), { recursive: true });
  writeJson(earlyStatePath(state.version), state);
}

function listEarlyStates() {
  const dir = path.join(io.root, ".release");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, EARLY_STATE_FILE))
    .filter((file) => existsSync(file))
    .map((file) => readJson(file));
}

// The feed text is what the client trusts, so every entry in it has to be one
// of the smoke-tested files, byte for byte, and every smoke-tested file has to
// be in it.
function assertFeedMatchesEvidence(feed, files, label) {
  const listed = new Map(feed.files.map((entry) => [decodeURIComponent(entry.url), entry]));
  assert(listed.size === files.length, `${label} lists ${listed.size} artifacts, evidence has ${files.length}`);
  for (const file of files) {
    const entry = listed.get(file.name);
    assert(entry, `${label} does not list ${file.name}`);
    assert(entry.sha512 === file.sha512, `${label} SHA-512 for ${file.name} does not match the evidence`);
    assert(entry.size === file.size, `${label} size for ${file.name} does not match the evidence`);
  }
}

async function uploadAndVerifyArtifacts(platform, local, artifactBaseUrl) {
  const dist = path.dirname(local.feedPath);
  const files = local.files.flatMap((file) =>
    file.blockmap ? [path.join(dist, file.name), path.join(dist, file.blockmap)] : [path.join(dist, file.name)]
  );
  io.publish(platform, files, local.version);
  await verifyArtifactsInBucket(local.files, artifactBaseUrl);
}

// Full download and SHA-512 of every artifact and blockmap, compared with the
// evidence rather than with the feed: the feed is what is being checked.
async function verifyArtifactsInBucket(files, artifactBaseUrl) {
  for (const file of files) {
    await verifyRemoteFile(`${artifactBaseUrl}/${encodeURIComponent(file.name)}`, { url: file.name, size: file.size, sha512: file.sha512 }, true);
    if (!file.blockmap) continue;
    await verifyRemoteFile(
      `${artifactBaseUrl}/${encodeURIComponent(file.blockmap)}`,
      { url: file.blockmap, size: file.blockmapSize, sha512: file.blockmapSha512 },
      true
    );
  }
}

/**
 * Stage 2: publish the exact signed build to the early feed only.
 *
 * Same guards as a stable publish (exact version, clean pushed main, credentials,
 * exact-commit evidence that matches the files on disk), and the same order:
 * artifacts first, verified by download, the feed last. The stable feed, the
 * website, and latest.json are not touched.
 */
export async function publishEarly(platform, confirmVersion, { soakDays: soakFlag } = {}) {
  const target = earlyTarget(platform);
  const version = io.packageVersion();
  assert(confirmVersion === version, `pass --confirm-public-release=${version} to publish to early access`);
  assert(
    isStableNumbered(version),
    `--early publishes stable-numbered builds so the same bits can be promoted; ${version} is a prerelease, publish it without --early`
  );
  const commit = io.releaseGitState();
  io.publishCredentials();
  const evidence =
    platform === "win"
      ? assertWindowsEvidence(version, commit)
      : platform === "linux"
        ? assertLinuxEvidence(version, commit)
        : assertLocalEvidence(version, commit);
  const local = await io.verifyLocal(platform, { commit });
  assert(local.version === version, `local ${target.label} artifacts are ${local.version}, expected ${version}`);
  assertEvidenceMatchesArtifacts(evidence.files, local.files);

  const previousState = readEarlyState(version);
  assert(!previousState?.promotedAt, `${version} is already stable; publish a new version instead`);
  const soakDays =
    soakFlag !== undefined || !previousState
      ? resolveSoakDays(soakFlag, releaseManifest().betaChannel?.defaultSoakDays)
      : undefined;

  if (platform === "mac") await verifyWebsiteContract({ allowVersionMismatch: true });
  const stable = await fetchFeed(target.stableFeedUrl);
  // The first Linux release has no stable feed to be newer than.
  assert(stable || target.allowsFirstRelease, `the stable ${target.label} feed ${target.stableFeedUrl} is missing`);
  if (stable) {
    assertVersion(stable.version);
    assert(
      compareVersions(version, stable.version) > 0,
      `release ${version} must be newer than the stable ${target.label} feed ${stable.version}`
    );
  }
  const early = await fetchFeed(target.earlyFeedUrl);
  if (early) {
    assertVersion(early.version);
    assert(
      compareVersions(version, early.version) >= 0,
      `the early ${target.label} feed already names newer ${early.version}`
    );
  }
  // Save what the early feed held before this release, once. A re-run after a
  // failure finds its own version there and must not overwrite the real
  // previous feed with it, or rollback would restore the build it is rolling
  // back.
  const previousEarlyFile = evidencePath(version, target.previousEarlyFile);
  mkdirSync(evidenceDir(version), { recursive: true });
  if (early && early.version !== version) writeFileSync(previousEarlyFile, early.text);
  const previousEarlyVersion =
    early && early.version !== version
      ? early.version
      : (previousState?.platforms?.[platform]?.previousEarlyVersion ?? null);

  await uploadAndVerifyArtifacts(platform, local, target.artifactBaseUrl);

  const feedText = readFileSync(local.feedPath, "utf8");
  const feed = parseElectronBuilderFeed(feedText);
  assert(feed.version === version, `local ${target.label} feed is ${feed.version}, expected ${version}`);
  assertFeedMatchesEvidence(feed, local.files, `local ${target.label} feed`);
  const earlyDir = path.join(evidenceDir(version), "early");
  mkdirSync(earlyDir, { recursive: true });
  const earlyFeedPath = path.join(earlyDir, target.earlyFeedFile);
  writeFileSync(earlyFeedPath, feedText);
  io.publish(platform, [earlyFeedPath], version);
  await waitForFeedVersion(target.earlyFeedUrl, version);

  const publishedAt = io.now().toISOString();
  const state = recordEarlyPublish(previousState, {
    version,
    commit,
    platform,
    publishedAt,
    soakDays,
    approval: `confirm-public-release=${version}`,
    platformRecord: {
      earlyFeedUrl: target.earlyFeedUrl,
      stableFeedUrl: target.stableFeedUrl,
      feedSha512: sha512Text(feedText),
      previousEarlyVersion,
      previousStableVersion: stable?.version ?? null,
      ...(local.signerSubject ? { signerSubject: local.signerSubject } : {}),
      ...(local.signing ? { signing: local.signing } : {}),
      files: local.files,
    },
  });
  writeEarlyState(state);
  io.log(
    `[release] Markie ${version} is on the early ${target.label} feed; it promotes to stable at ${state.soakUntil} unless held`
  );
  return state;
}

class PromotionSuperseded extends Error {}

function acquirePromoteLock() {
  const dir = path.join(io.root, ".release");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "promote.lock");
  if (existsSync(lock)) {
    const age = io.now().getTime() - statSync(lock).mtimeMs;
    assert(age > PROMOTE_LOCK_STALE_MS, `another promotion holds ${path.relative(io.root, lock)}`);
    rmSync(lock, { force: true });
  }
  writeFileSync(lock, `${process.pid} ${io.now().toISOString()}\n`, { flag: "wx" });
  return () => rmSync(lock, { force: true });
}

/**
 * Stage 3: point the stable feeds at the build early users have been running.
 *
 * Refuses before the soak ends (unless `force`), when held, and when the early
 * feed in the bucket no longer names this version. Every artifact is
 * downloaded again and its SHA-512 compared with the evidence before any feed
 * changes, and the stable feeds are written last, after every platform has
 * passed. The same post-publish checks as a stable publish run afterwards.
 */
export async function promoteRelease(confirmVersion, { force = false } = {}) {
  assert(confirmVersion, "pass --confirm-promote=<version> to promote an early release to stable");
  const version = assertVersion(confirmVersion);
  let state = readEarlyState(version);
  const blocker = promotionBlocker(state, io.now(), { force });
  if (blocker) throw new Error(blocker);
  io.promoteGitState(state.commit);
  io.publishCredentials();
  const release = acquirePromoteLock();
  try {
    const plans = [];
    const platforms = Object.keys(state.platforms).sort();
    for (const platform of platforms) {
      const target = earlyTarget(platform);
      const record = state.platforms[platform];
      const savedPath = path.join(evidenceDir(version), "early", target.earlyFeedFile);
      assert(existsSync(savedPath), `missing ${path.relative(io.root, savedPath)}; was ${version} published early from here?`);
      const savedText = readFileSync(savedPath, "utf8");
      assert(sha512Text(savedText) === record.feedSha512, `saved early ${target.label} feed does not match ${EARLY_STATE_FILE}`);
      const saved = parseElectronBuilderFeed(savedText);
      assert(saved.version === version, `saved early ${target.label} feed names ${saved.version}`);
      assertFeedMatchesEvidence(saved, record.files, `saved early ${target.label} feed`);
      // Same commit means the same build, so the smoke-tested evidence still
      // here must agree with what was recorded at early publish.
      const localEvidence = evidencePath(version, target.localEvidenceFile);
      if (existsSync(localEvidence)) {
        const local = readJson(localEvidence);
        if (local.commit === state.commit) assertEvidenceMatchesArtifacts(local.files, record.files);
      }

      const early = await fetchFeed(target.earlyFeedUrl);
      // A missing feed is a reason to stop, not proof of anything, so it is
      // retried on the next run. Only a feed that names another version
      // retires this release.
      assert(early, `the early ${target.label} feed is missing; not promoting ${version}`);
      if (early.version !== version) {
        state = markSuperseded(state, io.now(), early.version);
        writeEarlyState(state);
        throw new PromotionSuperseded(
          `the early ${target.label} feed names ${early.version}, not ${version}; it will not be promoted`
        );
      }
      assert(sha512Text(early.text) === record.feedSha512, `the early ${target.label} feed for ${version} changed since it was published`);
      const stable = await fetchFeed(target.stableFeedUrl);
      assert(stable || target.allowsFirstRelease, `the stable ${target.label} feed is missing`);
      if (stable) assertVersion(stable.version);
      const order = stable ? compareVersions(version, stable.version) : 1;
      if (order < 0) {
        state = markSuperseded(state, io.now(), stable.version);
        writeEarlyState(state);
        throw new PromotionSuperseded(`stable ${target.label} is already at newer ${stable.version}`);
      }
      // Equal means an earlier run got this far for this platform. Only the
      // same bytes count as done; anything else under this version is a
      // different build and needs a human.
      const alreadyStable = order === 0;
      if (alreadyStable) {
        assert(sha512Text(stable.text) === record.feedSha512, `stable ${target.label} names ${version} with a different feed than early did`);
      }
      await verifyArtifactsInBucket(record.files, target.artifactBaseUrl);
      plans.push({ platform, target, savedText, stable, alreadyStable });
    }
    if (plans.some((plan) => plan.platform === "mac" && !plan.alreadyStable)) {
      await verifyWebsiteContract({ allowVersionMismatch: true });
    }
    // Linux going stable for the first time is the moment the website starts
    // offering it, so the server that answers has to know Linux exists.
    if (plans.some((plan) => plan.platform === "linux" && !plan.alreadyStable && plan.target.allowsFirstRelease)) {
      await assertServerKnowsLinux();
    }

    // Stable feeds last.
    for (const plan of plans) {
      if (plan.alreadyStable) continue;
      if (plan.stable) writeFileSync(evidencePath(version, plan.target.previousStableFile), plan.stable.text);
      const promoteDir = path.join(evidenceDir(version), "promote");
      mkdirSync(promoteDir, { recursive: true });
      const stableFeedPath = path.join(promoteDir, plan.target.stableFeedFile);
      writeFileSync(stableFeedPath, plan.savedText);
      io.publish(plan.platform, [stableFeedPath], version);
    }

    // The same post-publish checks a stable publish runs.
    const promotedAt = io.now().toISOString();
    for (const plan of plans) {
      await waitForFeedVersion(plan.target.stableFeedUrl, version);
      if (plan.platform === "mac") {
        await waitForWebsiteVersion(version, 72, io.pollDelayMs);
        const verified = await verifyPublicMac({ expectedVersion: version, deep: false });
        writeEvidence(version, plan.target.publicEvidenceFile, {
          schemaVersion: 1,
          version,
          platform: "mac",
          commit: state.commit,
          publishedAt: promotedAt,
          promotedFrom: "early",
          feedUrl: verified.urls.feedUrl,
          downloadPageUrl: verified.urls.downloadPageUrl,
          latestJsonUrl: verified.urls.latestJsonUrl,
          primaryUrl: verified.primaryUrl,
          checks: ["remote-size", "remote-sha512", "stable-download-route", "latest-release-json", "same-bits-as-early"],
        });
      } else if (plan.platform === "linux") {
        const verified = await verifyPublicLinux({ expectedVersion: version, deep: false });
        writeEvidence(version, plan.target.publicEvidenceFile, {
          schemaVersion: 1,
          version,
          platform: "linux",
          commit: state.commit,
          publishedAt: promotedAt,
          promotedFrom: "early",
          feedUrl: verified.feedUrl,
          signing: "unsigned-by-design",
          files: state.platforms.linux.files,
          checks: ["remote-size", "remote-sha512", "download-routes", "same-bits-as-early"],
        });
      } else {
        const verified = await verifyPublicWindows({ expectedVersion: version, deep: false });
        writeEvidence(version, plan.target.publicEvidenceFile, {
          schemaVersion: 1,
          version,
          platform: "windows",
          commit: state.commit,
          publishedAt: promotedAt,
          promotedFrom: "early",
          feedUrl: verified.feedUrl,
          signerSubject: state.platforms.win.signerSubject ?? null,
          files: state.platforms.win.files,
          checks: ["remote-size", "remote-sha512", "same-bits-as-early"],
        });
      }
    }
    state = markPromoted(state, io.now());
    writeEarlyState(state);
    io.log(`[release] promoted Markie ${version} to stable on ${platforms.join(", ")} with the early build's exact bytes`);
    return state;
  } finally {
    release();
  }
}

export function holdRelease(version, held, { reason } = {}) {
  assert(version, `pass --version=<version> to ${held ? "hold" : "unhold"} an early release`);
  assertVersion(version);
  const state = setHold(readEarlyState(version), held, { now: io.now(), reason });
  writeEarlyState(state);
  io.log(
    held
      ? `[release] held Markie ${version}; it will not promote until release:unhold`
      : `[release] released the hold on Markie ${version}; it promotes at ${state.soakUntil} or the next scheduler run after`
  );
  return state;
}

/**
 * The scheduler entry point. Safe to run every hour: when nothing is due it
 * reads local state only, touches neither git nor the network, and prints one
 * line. A due release is promoted through the same promoteRelease a human
 * would run. Every run appends its line to .release/promote-due.log.
 */
export async function promoteDue() {
  const plan = planPromoteDue(listEarlyStates(), io.now());
  let line = plan.summary;
  let failed = false;
  if (plan.due) {
    try {
      await promoteRelease(plan.due.version);
      line = `promoted ${plan.due.version}`;
    } catch (error) {
      if (error instanceof PromotionSuperseded) {
        line = `${plan.due.version} superseded: ${error.message}`;
      } else {
        line = `${plan.due.version} promotion failed: ${error.message}`;
        failed = true;
      }
    }
  }
  const dir = path.join(io.root, ".release");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "promote-due.log"), `${io.now().toISOString()} ${line}\n`);
  io.log(`[release] promote-due: ${line}`);
  return { line, failed };
}

/**
 * Stage 2 rollback: take a build off the early feed before it reaches stable.
 * Restores the early feed saved before it was published, or, when there was
 * none, points the early feed at current stable so early users follow stable
 * until the next early release.
 */
export async function rollbackEarly(confirmVersion) {
  assert(confirmVersion, "pass --confirm-rollback=<version> to take that build off the early feed");
  const version = assertVersion(confirmVersion);
  let state = readEarlyState(version);
  assert(state, `no early release is recorded for ${version}`);
  assert(
    !state.promotedAt,
    `${version} is already stable; use release:rollback:mac / release:rollback:win / release:rollback:linux for the stable feed`
  );
  io.publishCredentials();
  for (const platform of Object.keys(state.platforms).sort()) {
    const target = earlyTarget(platform);
    const live = await fetchFeed(target.earlyFeedUrl);
    if (live?.version !== version) {
      io.log(`[release] the early ${target.label} feed names ${live?.version ?? "nothing"}, not ${version}; left alone`);
      continue;
    }
    const previousFile = evidencePath(version, target.previousEarlyFile);
    const restoreText = existsSync(previousFile)
      ? readFileSync(previousFile, "utf8")
      : (await fetchFeed(target.stableFeedUrl))?.text;
    if (!restoreText && target.allowsFirstRelease) {
      // Nothing earlier exists to point early users at, and deleting the feed
      // is a destructive storage operation this runner does not do. Withdrawn
      // still means it never promotes; early users keep it until the next one.
      io.log(
        `[release] the early ${target.label} feed has no earlier release to return to; ${version} stays there for ` +
          `early users until the next release, and will not be promoted`
      );
      continue;
    }
    assert(restoreText, `nothing to restore the early ${target.label} feed to`);
    const restoreVersion = assertVersion(parseElectronBuilderFeed(restoreText).version);
    const rollbackDir = path.join(evidenceDir(version), "early-rollback");
    mkdirSync(rollbackDir, { recursive: true });
    const file = path.join(rollbackDir, target.earlyFeedFile);
    writeFileSync(file, restoreText);
    io.publish(platform, [file], restoreVersion);
    await waitForFeedVersion(target.earlyFeedUrl, restoreVersion);
    io.log(`[release] the early ${target.label} feed is back on ${restoreVersion}`);
  }
  state = markWithdrawn(state, io.now());
  writeEarlyState(state);
  return state;
}

/**
 * After a direct stable publish, make sure early users are not left behind.
 * electron-updater on the early channel reads only the early feed, so a stable
 * hotfix that skips early access would never reach them. When the early feed
 * is missing or older, it gets the same feed stable just got. A newer early
 * build is left alone.
 */
export async function mirrorStableToEarly(platform, version, feedPath) {
  if (!isStableNumbered(version)) return { mirrored: false, reason: "prerelease" };
  const target = earlyTarget(platform);
  const early = await fetchFeed(target.earlyFeedUrl);
  if (early && compareVersions(early.version, version) >= 0) {
    return { mirrored: false, reason: `early feed already names ${early.version}` };
  }
  const dir = path.join(evidenceDir(version), "early-mirror");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, target.earlyFeedFile);
  copyFileSync(feedPath, file);
  io.publish(platform, [file], version);
  await waitForFeedVersion(target.earlyFeedUrl, version);
  io.log(`[release] early ${target.label} feed now names ${version} too, so early users get this release`);
  return { mirrored: true };
}

async function mirrorStableAfterPublish(platform, version, feedPath) {
  try {
    await mirrorStableToEarly(platform, version, feedPath);
  } catch (error) {
    throw new Error(
      `stable ${version} is public and verified, but the early feed could not be brought up to it: ${error.message}`
    );
  }
}

function assertPromoteGitState(commit) {
  // Promotion rebuilds nothing, so HEAD does not have to be the release
  // commit; main will usually have moved on. What it does need is the
  // manifest that decides where feeds go, which is why tracked files must be
  // clean, and proof that the build came from main.
  assert(gitOutput(["branch", "--show-current"]) === "main", "promotion must run from main");
  assert(gitOutput(["status", "--porcelain", "--untracked-files=no"]) === "", "tracked files must be clean");
  run("git", ["fetch", "--quiet", "origin", "main"], { quiet: true });
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"], {
    cwd: rootDir,
    stdio: "ignore",
  });
  assert(result.status === 0, `release commit ${commit} is not on origin/main`);
}

async function earlyStatus() {
  const result = {};
  for (const platform of ["mac", "win", "linux"]) {
    try {
      const target = earlyTarget(platform);
      result[`${platform}EarlyFeedVersion`] = (await fetchFeed(target.earlyFeedUrl))?.version ?? null;
    } catch {
      result[`${platform}EarlyFeedVersion`] = null;
    }
  }
  const plan = planPromoteDue(listEarlyStates(), io.now());
  result.earlyPipeline = plan.summary;
  return result;
}

function flagValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export async function runReleaseCli(args = process.argv.slice(2)) {
  loadLocalEnv();
  const [command, target, ...flags] = args;
  if (command === "status") return status();
  // Commands that act on a recorded release rather than a platform build.
  const releaseFlags = args.slice(1);
  if (command === "promote") {
    return promoteRelease(flagValue(releaseFlags, "confirm-promote"), {
      force: releaseFlags.includes("--now"),
    });
  }
  if (command === "promote-due") {
    const { failed } = await promoteDue();
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === "hold" || command === "unhold") {
    return holdRelease(flagValue(releaseFlags, "version"), command === "hold", {
      reason: flagValue(releaseFlags, "reason"),
    });
  }
  if (command === "rollback-early") return rollbackEarly(flagValue(releaseFlags, "confirm-rollback"));
  if (command === "version") {
    const version = assertVersion(target);
    const files = setReleaseVersion(version);
    console.log(`[release] set Markie ${version} in ${files.map((file) => path.relative(rootDir, file)).join(", ")}`);
    return;
  }
  assert(target === "mac" || target === "win" || target === "linux", "supported release targets: mac, win, linux");

  if (target === "linux") {
    if (command === "prepare") return prepareLinux();
    if (command === "verify-local") {
      const verified = await verifyLocalLinuxArtifacts();
      console.log(
        `[release] local Markie ${verified.version} Linux packages match the feed, the build evidence and SHA512SUMS (unsigned by design)`
      );
      return;
    }
    if (command === "publish") {
      if (flags.includes("--early")) {
        return publishEarly("linux", flagValue(flags, "confirm-public-release"), {
          soakDays: flagValue(flags, "soak-days"),
        });
      }
      return publishLinux(flagValue(flags, "confirm-public-release"));
    }
    if (command === "rollback") return rollbackLinux(flagValue(flags, "confirm-rollback"));
    if (command === "verify-public") {
      const verified = await verifyPublicLinux({
        expectedVersion: flagValue(flags, "version") ?? packageJson().version,
        deep: flags.includes("--deep"),
      });
      console.log(
        `[release] public Markie ${verified.version} Linux release is valid${flags.includes("--deep") ? " with full SHA-512 checks" : ""}`
      );
      return;
    }
    throw new Error(
      "usage: release.mjs prepare linux | verify-local linux | " +
        "publish linux [--early [--soak-days=<n>]] --confirm-public-release=<semver> | " +
        "rollback linux --confirm-rollback=<semver> | verify-public linux [--version=<semver>] [--deep]"
    );
  }

  if (target === "win") {
    if (command === "prepare") return prepareWindows();
    if (command === "verify-local") {
      const verified = await verifyLocalWindowsArtifacts();
      console.log(
        `[release] local Markie ${verified.version} Windows artifacts match the feed and are signed by ${verified.signerSubject}`
      );
      return;
    }
    if (command === "publish") {
      if (flags.includes("--early")) {
        return publishEarly("win", flagValue(flags, "confirm-public-release"), {
          soakDays: flagValue(flags, "soak-days"),
        });
      }
      return publishWindows(flagValue(flags, "confirm-public-release"));
    }
    if (command === "rollback") return rollbackWindows(flagValue(flags, "confirm-rollback"));
    if (command === "verify-public") {
      const verified = await verifyPublicWindows({
        expectedVersion: flagValue(flags, "version") ?? packageJson().version,
        deep: flags.includes("--deep"),
      });
      console.log(
        `[release] public Markie ${verified.version} Windows release is valid${flags.includes("--deep") ? " with full SHA-512 checks" : ""}`
      );
      return;
    }
    throw new Error(
      "usage: release.mjs prepare win | verify-local win | " +
        "publish win [--early [--soak-days=<n>]] --confirm-public-release=<semver> | " +
        "rollback win --confirm-rollback=<semver> | verify-public win [--version=<semver>] [--deep]"
    );
  }

  if (command === "prepare") return prepareMac();
  if (command === "verify-local") {
    const verified = await verifyLocalMacArtifacts({ verifyTrust: true });
    console.log(`[release] local Markie ${verified.version} artifacts are signed, notarized, and internally consistent`);
    return;
  }
  if (command === "publish") {
    if (flags.includes("--early")) {
      return publishEarly("mac", flagValue(flags, "confirm-public-release"), {
        soakDays: flagValue(flags, "soak-days"),
      });
    }
    return publishMac(flagValue(flags, "confirm-public-release"));
  }
  if (command === "verify-public") {
    const verified = await verifyPublicMac({
      expectedVersion: flagValue(flags, "version") ?? packageJson().version,
      deep: flags.includes("--deep"),
    });
    console.log(`[release] public Markie ${verified.version} release is valid${flags.includes("--deep") ? " with full SHA-512 checks" : ""}`);
    return;
  }
  if (command === "rollback") return rollbackMac(flagValue(flags, "confirm-rollback"));
  throw new Error(
    "usage: release.mjs status | version <semver> | prepare mac | verify-local mac | " +
      "publish mac [--early [--soak-days=<n>]] --confirm-public-release=<semver> | " +
      "verify-public mac [--version=<semver>] [--deep] | rollback mac --confirm-rollback=<semver> | " +
      "prepare win | verify-local win | publish win [--early] --confirm-public-release=<semver> | " +
      "rollback win --confirm-rollback=<semver> | verify-public win [--version=<semver>] [--deep] | " +
      "prepare linux | verify-local linux | publish linux [--early] --confirm-public-release=<semver> | " +
      "rollback linux --confirm-rollback=<semver> | verify-public linux [--version=<semver>] [--deep] | " +
      "promote --confirm-promote=<semver> [--now] | promote-due | hold --version=<semver> [--reason=<text>] | " +
      "unhold --version=<semver> | rollback-early --confirm-rollback=<semver>"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runReleaseCli().catch((error) => {
    console.error(`[release] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
