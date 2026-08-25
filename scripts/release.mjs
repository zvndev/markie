import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

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
  console.log(`[release] ${command} ${(options.displayArgs ?? args).join(" ")}`);
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
  return path.join(rootDir, ".release", version);
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

function appBuilderBin() {
  const name = process.arch === "arm64" ? "app-builder_arm64" : "app-builder_amd64";
  const local = path.join(rootDir, "node_modules/app-builder-bin/mac", name);
  assert(existsSync(local), "app-builder is not installed; run npm ci");
  return local;
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
    run(appBuilderBin(), ["blockmap", "--input", file, "--output", blockmap], { capture: true });
  }
  await refreshMacFeedIntegrity(version);
}

async function prepareMac() {
  assert(process.platform === "darwin", "macOS releases must be prepared on macOS");
  const commit = assertReleaseGitState();
  assertMacReleaseCredentials();
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
  run("npm", ["run", "electron:smoke:mac:launch"]);
  run("node", ["scripts/desktop-launch-smoke.mjs", "--platform", "mac", "--arch", "x64"]);
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
  for (const route of publicDownloadRoutes()) {
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

async function waitForPublicFeed(version, attempts = 12) {
  const { feedUrl } = releaseUrls();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${feedUrl}?release-check=${Date.now()}`, { cache: "no-store" });
      if (response.ok && parseElectronBuilderFeed(await response.text()).version === version) return;
    } catch {
      // Retry propagation failures below.
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`public updater feed did not reach ${version}`);
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
  console.log(`[release] final human check: open the previous Markie release and confirm Check for Updates shows ${version}`);
}

async function rollbackMac(confirmVersion) {
  const version = packageJson().version;
  assert(confirmVersion === version, `pass --confirm-rollback=${version} to restore the previous feed`);
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
  console.log(JSON.stringify(result, null, 2));
}

function flagValue(args, name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export async function runReleaseCli(args = process.argv.slice(2)) {
  loadLocalEnv();
  const [command, target, ...flags] = args;
  if (command === "status") return status();
  if (command === "version") {
    const version = assertVersion(target);
    const files = setReleaseVersion(version);
    console.log(`[release] set Markie ${version} in ${files.map((file) => path.relative(rootDir, file)).join(", ")}`);
    return;
  }
  assert(target === "mac", "supported release target: mac");
  if (command === "prepare") return prepareMac();
  if (command === "verify-local") {
    const verified = await verifyLocalMacArtifacts({ verifyTrust: true });
    console.log(`[release] local Markie ${verified.version} artifacts are signed, notarized, and internally consistent`);
    return;
  }
  if (command === "publish") return publishMac(flagValue(flags, "confirm-public-release"));
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
      "publish mac --confirm-public-release=<semver> | verify-public mac [--version=<semver>] [--deep] | " +
      "rollback mac --confirm-rollback=<semver>"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runReleaseCli().catch((error) => {
    console.error(`[release] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
