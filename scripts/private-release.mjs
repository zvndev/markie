/** Owner-authorized private lane only. No GitHub or public-storage write path.
 * Builder configuration: https://www.electron.build/configuration/
 * Generic updater: https://www.electron.build/publish/
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PRIVATE_PREFIX = "/private-releases/super-nightly/";
export const PRIVATE_FEED = "super-nightly-mac.yml";
export const PRIVATE_GATEWAY_ORIGIN = "https://markie-super-nightly-production.up.railway.app";
const LIMIT = 512 * 1024 * 1024;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = (bytes) => createHash("sha512").update(bytes).digest("base64");
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.root ?? rootDir, env: options.env ?? process.env, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", shell: false });
  assert(!result.error && result.status === 0, `Private release command failed: ${path.basename(command)}`);
  return result.stdout?.trim() ?? "";
}

export function readPrivateProvenance(root = rootDir) {
  return { gitCommit: run("git", ["rev-parse", "HEAD"], { root, capture: true }), gitDirty: run("git", ["status", "--porcelain", "--untracked-files=all"], { root, capture: true }) !== "" };
}

export function privateApiOrigin(value) {
  assert(typeof value === "string" && value.length < 300, "MARKIE_PRIVATE_API_ORIGIN is required.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Private API origin must be an HTTPS origin."); }
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash && value.replace(/\/$/, "") === url.origin, "Private API origin must be a canonical HTTPS origin, not a path or credential URL.");
  assert(!/(?:^|\.)(?:localhost|local|internal|github\.com|githubusercontent\.com|amazonaws\.com|backblazeb2\.com|r2\.dev|markiedocs\.com)$/.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":"), "Public storage, public product hosts and local addresses are forbidden private destinations.");
  assert(url.origin === PRIVATE_GATEWAY_ORIGIN, "Private destination must match the reviewed private gateway origin.");
  return url.origin;
}

export function privateOutputDirectory(root, requested, version) {
  const allowed = path.join(root, ".release", "private-artifacts");
  const output = requested ? path.resolve(requested) : path.join(allowed, version);
  assert(!requested || path.isAbsolute(requested), "Private output override must be absolute.");
  assert(!inside(root, output) || inside(allowed, output), "Private output must be outside the repository or under ignored .release/private-artifacts.");
  assert(output !== root && output !== path.parse(output).root, "Private output must be a dedicated artifact directory.");
  let existing = output;
  while (!existsSync(existing)) existing = path.dirname(existing);
  assert(realpathSync(existing) === existing, "Private output may not traverse a symlink.");
  return output;
}

export function privateSettings(env = process.env, root = rootDir, provenance = readPrivateProvenance(root)) {
  const version = env.MARKIE_PRIVATE_VERSION;
  assert(typeof version === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-super-nightly\.(?:0|[1-9]\d*)$/.test(version), "MARKIE_PRIVATE_VERSION must be a super-nightly prerelease version.");
  assert(/^[a-f0-9]{40}$/.test(provenance.gitCommit) && provenance.gitDirty === false, "Private release requires a clean exact Git commit.");
  assert(!env.MARKIE_PRIVATE_GIT_COMMIT || env.MARKIE_PRIVATE_GIT_COMMIT === provenance.gitCommit, "Private commit does not match the checked-out source.");
  const archs = (env.MARKIE_PRIVATE_ARCHS ?? "arm64").split(",");
  assert(archs.length >= 1 && archs.length <= 2 && new Set(archs).size === archs.length && archs.every((a) => ["arm64", "x64"].includes(a)), "Private macOS architectures must be arm64 and/or x64.");
  const apiOrigin = privateApiOrigin(env.MARKIE_PRIVATE_API_ORIGIN);
  const signingTeamId = env.MARKIE_PRIVATE_SIGNING_TEAM_ID ?? env.APPLE_TEAM_ID;
  assert(typeof signingTeamId === "string" && /^[A-Z0-9]{10}$/.test(signingTeamId), "A reviewed 10-character Developer ID signing team is required.");
  assert(!env.MARKIE_PRIVATE_SIGNING_TEAM_ID || !env.APPLE_TEAM_ID || env.MARKIE_PRIVATE_SIGNING_TEAM_ID === env.APPLE_TEAM_ID, "Private signing and notarization teams must agree.");
  return { version, apiOrigin, gitCommit: provenance.gitCommit, gitDirty: false, channel: "super-nightly", signingTeamId, archs, output: privateOutputDirectory(root, env.MARKIE_PRIVATE_OUTPUT_DIR, version) };
}

export function privateMarker(settings) {
  return { channel: "super-nightly", apiOrigin: settings.apiOrigin, gitCommit: settings.gitCommit, gitDirty: false, version: settings.version };
}

export function privateBuilderArgs() {
  // No passthrough arguments: --publish always / config overrides cannot escape.
  return ["--config", "electron-builder.private.cjs", "--mac", "--publish", "never"];
}

export function privateBuildEnvironment(env, signing = false) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    const signingKey = /^(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK|CSC_KEY_PASSWORD|CSC_NAME)$/.test(key);
    if ((/OWNER|PUBLISH.*KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|FORBIDDEN/i.test(key) && !(signing && signingKey)) || /^(?:GH_|GITHUB_|AWS_|S3_|B2_)/.test(key)) delete clean[key];
  }
  return clean;
}

export function forbiddenPrivateValues(env = process.env) {
  const values = Object.entries(env).filter(([key, value]) => /OWNER|PUBLISH.*KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY/i.test(key) && typeof value === "string" && value.length >= 8).map(([, value]) => value);
  if (env.MARKIE_PRIVATE_SCAN_FORBIDDEN_JSON) {
    const extra = JSON.parse(env.MARKIE_PRIVATE_SCAN_FORBIDDEN_JSON);
    assert(Array.isArray(extra) && extra.every((v) => typeof v === "string" && v.length >= 4), "Invalid private forbidden-value scan configuration.");
    values.push(...extra);
  }
  return [...new Set(values)];
}

export function scanPrivateBytes(name, bytes, forbidden = []) {
  assert(bytes.length <= LIMIT, "Packaged entry exceeds private artifact scan limit.");
  const text = bytes.toString("utf8");
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text), `Credential pattern in packaged entry: ${name}`);
  for (const value of forbidden) assert(!bytes.includes(Buffer.from(value)), `Forbidden private value in packaged entry: ${name}`);
}

export function productionPackageNames(root = rootDir) {
  const names = new Set(), visited = new Set();
  const visit = (packageFile) => {
    const file = realpathSync(packageFile);
    if (visited.has(file)) return;
    visited.add(file);
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      let resolved;
      try { resolved = createRequire(file).resolve(`${name}/package.json`); }
      catch { assert(pkg.optionalDependencies?.[name], `Cannot resolve production dependency: ${name}`); continue; }
      names.add(name);
      visit(resolved);
    }
  };
  visit(path.join(root, "package.json"));
  return names;
}

export function assertPrivateEntryName(name, productionNames) {
  assert(name && !name.startsWith("/") && !name.split("/").some((part) => part === ".." || part === ".") && !/[\\\x00-\x1f]/.test(name), "Unsafe packaged entry name.");
  assert(!/(?:^|\/)(?:\.env[^/]*|\.git|__tests__|tests?|coverage|\.DS_Store)(?:\/|$)|\.(?:map|pem|p12|pfx)$|\.(?:test|spec)\.[^/]+$/i.test(name), `Non-runtime/private file in package: ${name}`);
  assert(name === "package.json" || /^(?:electron|out)\//.test(name) || name.startsWith("node_modules/"), `Unexpected application inclusion: ${name}`);
  if (name.startsWith("node_modules/")) {
    for (const suffix of name.split("node_modules/").slice(1)) {
      const pieces = suffix.split("/"), packageName = pieces[0].startsWith("@") ? pieces.slice(0, 2).join("/") : pieces[0];
      assert(productionNames.has(packageName), `Non-production dependency in package: ${packageName}`);
    }
  }
}

export function verifyPrivateEntries(entries, settings, options = {}) {
  const names = options.productionNames ?? productionPackageNames(options.root);
  const forbidden = options.forbidden ?? forbiddenPrivateValues();
  let pkg;
  for (const { name, data } of entries) {
    assertPrivateEntryName(name, names);
    assert(!(options.ignoredFiles ?? []).includes(name), `Git-ignored source file in package: ${name}`);
    scanPrivateBytes(name, data, forbidden);
    if (name === "package.json") pkg = JSON.parse(data.toString("utf8"));
  }
  assert(pkg?.version === settings.version && pkg.main === "electron/main.js", "Packaged application version/entry point mismatch.");
  assert(JSON.stringify(pkg.markiePrivateRelease) === JSON.stringify(privateMarker(settings)), "Packaged private marker/provenance mismatch.");
  return entries.length;
}

function walkFiles(directory, prefix = "") {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name), relative = prefix + name, stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), "Application resources may not contain symlinked private inputs.");
    return stat.isDirectory() ? walkFiles(file, relative + "/") : [{ name: relative, data: readFileSync(file) }];
  });
}

export function privateUpdateConfig(settings) {
  return { provider: "generic", url: settings.apiOrigin + PRIVATE_PREFIX, channel: "super-nightly", updaterCacheDirName: "markie-super-nightly-updater" };
}

export function verifyPrivateBundle(appPath, settings, options = {}) {
  const resources = path.join(appPath, "Contents", "Resources"), archive = path.join(resources, "app.asar");
  const asar = require("@electron/asar");
  const productionNames = options.productionNames ?? productionPackageNames(options.root);
  assert(existsSync(archive), "Private application archive is missing.");
  const unpacked = new Set();
  const entries = asar.listPackage(archive).flatMap((rawName) => {
    const name = rawName.replace(/^\//, ""), info = asar.statFile(archive, name, false);
    if (info.files) return [];
    assert(!info.link, "Application archive links are not allowed.");
    if (info.unpacked) unpacked.add(name);
    return [{ name, data: asar.extractFile(archive, name) }];
  });
  verifyPrivateEntries(entries, settings, { ...options, productionNames });
  const update = yaml.load(readFileSync(path.join(resources, "app-update.yml"), "utf8"), { schema: yaml.JSON_SCHEMA });
  assert(JSON.stringify(update) === JSON.stringify(privateUpdateConfig(settings)), "Private updater must point only at the authenticated gateway.");
  const resourceEntries = walkFiles(resources).filter((entry) => entry.name !== "app.asar");
  for (const entry of resourceEntries) {
    if (entry.name.startsWith("app.asar.unpacked/")) {
      const name = entry.name.slice("app.asar.unpacked/".length);
      assert(unpacked.has(name), `Unindexed unpacked resource: ${entry.name}`);
      assertPrivateEntryName(name, productionNames);
    } else assert(!entry.name.startsWith("app.asar"), `Unexpected archive sibling: ${entry.name}`);
    assert(!/^(?:mcp|server|src|scripts)\//.test(entry.name), `Standalone source/runtime bypass in resources: ${entry.name}`);
    assert(!/\.map$|(?:^|\/)\.env|\.(?:test|spec)\./.test(entry.name), `Unexpected resource: ${entry.name}`);
    scanPrivateBytes(entry.name, entry.data, options.forbidden ?? forbiddenPrivateValues());
  }
  return { entries: entries.length };
}

export function createPrivateBuilderConfig(env = process.env, root = rootDir, provenance) {
  const settings = privateSettings(env, root, provenance);
  const base = require(path.join(root, "electron-builder.config.cjs"));
  const excluded = run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "electron"], { root, capture: true }).split("\n").filter(Boolean);
  const forbidden = forbiddenPrivateValues(env);
  const preflight = require(path.join(root, "build", "preflight.cjs"));
  return {
    ...base, publish: null, forceCodeSigning: true, extraResources: [], win: { ...base.win, publish: null }, linux: { ...base.linux, publish: null },
    mac: { ...base.mac, publish: null, target: [{ target: "zip", arch: settings.archs }] },
    directories: { ...base.directories, output: settings.output },
    extraMetadata: { version: settings.version, markiePrivateRelease: privateMarker(settings) },
    files: [...base.files, "!**/.env*", "!**/*.map", "!**/*.test.*", "!**/*.spec.*", "!**/{test,tests,__tests__,coverage}/**", "!**/*.pem", "!**/*.p12", "!**/*.pfx", ...excluded.map((name) => `!${name}`)],
    afterPack: async (context) => {
      assert(context.electronPlatformName === "darwin", "This private packaging lane is macOS-only.");
      const app = path.join(context.appOutDir, "Markie.app"), resources = path.join(app, "Contents", "Resources");
      writeFileSync(path.join(resources, "app-update.yml"), yaml.dump(privateUpdateConfig(settings)));
      verifyPrivateBundle(app, settings, { root, forbidden, ignoredFiles: excluded });
      await preflight(context);
    },
  };
}

export function privateArtifactName(name, settings) {
  const escaped = settings.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Markie-${escaped}-(?:${settings.archs.join("|")})\\.zip(?:\\.blockmap)?$`).test(name);
}

export function privateUploadUrl(settings, name) {
  assert(name === PRIVATE_FEED || privateArtifactName(name, settings), "Only the private feed and versioned immutable artifacts may be uploaded.");
  const origin = privateApiOrigin(settings.apiOrigin), url = new URL(PRIVATE_PREFIX + name, origin);
  assert(url.origin === origin && url.pathname === PRIVATE_PREFIX + name, "Private upload destination escaped its trusted prefix.");
  return url.href;
}

export function createPrivateFeed(settings) {
  assert(!readdirSync(settings.output).some((name) => /\.dmg(?:\.blockmap)?$/i.test(name)), "DMG artifacts are not supported by this private ZIP-only lane.");
  const files = readdirSync(settings.output).filter((name) => privateArtifactName(name, settings) && !name.endsWith(".blockmap")).sort().map((name) => {
    const data = readFileSync(path.join(settings.output, name));
    assert(data.length > 0 && data.length <= LIMIT, "Private artifact exceeds gateway size bounds.");
    return { url: name, sha512: digest(data), size: data.length };
  });
  for (const arch of settings.archs) assert(files.some((file) => file.url.endsWith(`-${arch}.zip`)), "A signed update ZIP is required for each private architecture.");
  const first = files.find((file) => file.url.endsWith(".zip"));
  const feed = { version: settings.version, files, path: first.url, sha512: first.sha512, releaseDate: new Date().toISOString() };
  writeFileSync(path.join(settings.output, PRIVATE_FEED), yaml.dump(feed));
  return feed;
}

export function verifyPrivateFeed(feed, settings) {
  assert(feed && feed.version === settings.version && Array.isArray(feed.files) && feed.files.length > 0 && feed.files.length <= 12, "Private feed version/files are invalid.");
  assert(Object.keys(feed).every((key) => ["version", "files", "path", "sha512", "releaseDate"].includes(key)), "Unexpected private feed metadata.");
  const seen = new Set();
  for (const file of feed.files) {
    assert(file && Object.keys(file).every((key) => ["url", "sha512", "size"].includes(key)) && privateArtifactName(file.url, settings) && !file.url.endsWith(".blockmap") && !seen.has(file.url), "Unsafe or duplicate private feed artifact.");
    seen.add(file.url);
    assert(Number.isSafeInteger(file.size) && file.size > 0 && file.size <= LIMIT && typeof file.sha512 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512), "Invalid private artifact integrity.");
  }
  for (const arch of settings.archs) assert(feed.files.some((file) => file.url.endsWith(`-${arch}.zip`)), "Missing architecture update ZIP.");
  const legacy = feed.files.find((file) => file.url === feed.path);
  assert(legacy?.url.endsWith(".zip") && legacy.sha512 === feed.sha512, "Private legacy feed path/hash must match its ZIP entry.");
  return feed;
}

export async function inspectZipPaths(file, settings) {
  // Resolve through the declared builder dependency, not a removed transitive
  // reader. Open.file reads the central directory; only symlink bodies buffer.
  const unzipper = createRequire(require.resolve("app-builder-lib"))("unzipper");
  const directory = await unzipper.Open.file(file);
  assert(directory.files.length > 0 && directory.files.length < 50000, "Private ZIP entry count exceeds bounds.");
  let total = 0;
  const seen = new Set();
  for (const entry of directory.files) {
    const name = entry.path;
    assert(typeof name === "string" && !seen.has(name) && !name.split("/").some((part) => part === ".." || part === ".") && name.startsWith("Markie.app/") && !/[\\\x00-\x1f]/.test(name), "Unsafe private ZIP entry.");
    seen.add(name);
    assert(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && !(entry.flags & 1), "Invalid or encrypted private ZIP entry.");
    total += entry.uncompressedSize;
    assert(total <= 4 * LIMIT, "Private ZIP expands beyond verification limit.");
    if (((entry.externalFileAttributes >>> 16) & 0o170000) !== 0o120000) continue;
    assert(entry.uncompressedSize < 4096, "Oversized private ZIP symlink.");
    const stream = entry.stream(), chunks = [];
    let received = 0;
    try {
      for await (const chunk of stream) {
        received += chunk.length;
        assert(received <= Math.min(entry.uncompressedSize, 4095), "Private ZIP symlink payload exceeds its declared bounded size.");
        chunks.push(chunk);
      }
    } finally { stream.destroy(); }
    const bytes = Buffer.concat(chunks, received);
    assert(bytes.length === entry.uncompressedSize && bytes.length < 4096, "Private ZIP symlink size mismatch.");
    const target = bytes.toString("utf8"), resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
    assert(!path.posix.isAbsolute(target) && !/[\\\x00-\x1f]/.test(target) && resolved.startsWith("Markie.app/"), "Private ZIP symlink escapes application.");
  }
  assert(settings.channel === "super-nightly", "Unexpected private ZIP channel.");
}

export function verifyPrivateSigningAuthority(output, settings) {
  assert(typeof settings.signingTeamId === "string" && /^[A-Z0-9]{10}$/.test(settings.signingTeamId), "Private verification requires the reviewed signing team.");
  assert(/(?:^|\r?\n)Authority=Developer ID Application:/.test(output), "Private app requires Developer ID Application signing.");
  const team = output.match(/(?:^|\r?\n)TeamIdentifier=([A-Z0-9]{10})(?:\r?\n|$)/)?.[1];
  assert(team === settings.signingTeamId, "Private application signing team does not match the reviewed team.");
}

export async function verifyPrivateRelease(settings, options = {}) {
  assert(!readdirSync(settings.output).some((name) => /\.dmg(?:\.blockmap)?$/i.test(name)), "DMG artifacts are not supported by this private ZIP-only lane.");
  const feedPath = path.join(settings.output, PRIVATE_FEED), feedBytes = readFileSync(feedPath);
  assert(feedBytes.length < 65536, "Private feed exceeds bounds.");
  const feed = verifyPrivateFeed(yaml.load(feedBytes.toString("utf8"), { schema: yaml.JSON_SCHEMA }), settings), files = [];
  for (const entry of feed.files) {
    const file = path.join(settings.output, entry.url);
    assert(lstatSync(file).isFile() && statSync(file).size === entry.size, "Private artifact size/type mismatch.");
    const data = readFileSync(file);
    assert(digest(data) === entry.sha512, "Private artifact SHA-512 mismatch.");
    assert(entry.url.endsWith(".zip"), "This private release lane verifies ZIP archives only.");
    {
      assert(process.platform === "darwin", "Private signed ZIP verification requires macOS.");
      await inspectZipPaths(file, settings);
      const temporary = mkdtempSync(path.join(tmpdir(), "markie-private-verify-"));
      try {
        run("/usr/bin/ditto", ["-x", "-k", file, temporary]);
        const app = path.join(temporary, "Markie.app");
        verifyPrivateBundle(app, settings, options);
        run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
        const authority = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
        assert(authority.status === 0, "Private signing authority inspection failed.");
        verifyPrivateSigningAuthority(authority.stderr, settings);
        run("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
        run("/usr/bin/xcrun", ["stapler", "validate", app]);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    files.push({ name: entry.url, file, size: entry.size, sha512: entry.sha512 });
    const blockmap = file + ".blockmap";
    if (existsSync(blockmap)) {
      assert(lstatSync(blockmap).isFile() && statSync(blockmap).size > 0 && statSync(blockmap).size <= LIMIT, "Invalid private blockmap.");
      const bytes = readFileSync(blockmap);
      files.push({ name: entry.url + ".blockmap", file: blockmap, size: bytes.length, sha512: digest(bytes) });
    }
  }
  files.push({ name: PRIVATE_FEED, file: feedPath, size: feedBytes.length, sha512: digest(feedBytes) });
  return { version: settings.version, gitCommit: settings.gitCommit, files };
}

export async function publishPrivateFiles(settings, verified, key, fetchImpl = fetch) {
  assert(typeof key === "string" && key.length >= 32 && !/[\r\n]/.test(key), "A server-only private publisher key is required.");
  assert(verified.version === settings.version && verified.gitCommit === settings.gitCommit && verified.files.at(-1)?.name === PRIVATE_FEED, "Private publication needs matching verified artifacts and feed-last ordering.");
  assert(new Set(verified.files.map((file) => file.name)).size === verified.files.length, "Duplicate private upload entry.");
  for (const entry of verified.files) {
    const body = readFileSync(entry.file);
    assert(body.length > 0 && body.length <= LIMIT && body.length === entry.size && digest(body) === entry.sha512, "Private artifact changed after verification.");
    const url = privateUploadUrl(settings, entry.name);
    const response = await fetchImpl(url, { method: "PUT", redirect: "error", credentials: "omit", headers: { "x-markie-publish-key": key, "x-markie-sha512": entry.sha512, "Content-Length": String(entry.size), "Content-Type": entry.name === PRIVATE_FEED ? "application/yaml" : "application/octet-stream", ...(entry.name === PRIVATE_FEED ? {} : { "If-None-Match": "*" }) }, body });
    assert(response.ok, `Private upload failed (${response.status}); feed promotion stopped.`);
  }
  return { uploaded: verified.files.length };
}

export async function runPrivateReleaseCli(args = process.argv.slice(2), env = process.env, root = rootDir) {
  assert(args.length === 1 && ["build", "verify", "publish-private"].includes(args[0]), "Usage: node scripts/private-release.mjs <build|verify|publish-private>; configure private origin/version/output via environment.");
  const settings = privateSettings(env, root);
  if (args[0] === "build") {
    mkdirSync(settings.output, { recursive: true });
    assert(readdirSync(settings.output).length === 0, "Private build output must be empty; choose a new immutable version/output.");
    run("npm", ["run", "build"], { root, env: privateBuildEnvironment(env) });
    run(path.join(root, "node_modules", ".bin", "electron-builder"), privateBuilderArgs(), { root, env: privateBuildEnvironment(env, true) });
    createPrivateFeed(settings);
  }
  const verified = await verifyPrivateRelease(settings, { root, forbidden: forbiddenPrivateValues(env) });
  if (args[0] === "publish-private") await publishPrivateFiles(settings, verified, env.MARKIE_PRIVATE_PUBLISH_KEY);
  return { command: args[0], version: settings.version, gitCommit: settings.gitCommit, files: verified.files.map(({ name, size, sha512 }) => ({ name, size, sha512 })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPrivateReleaseCli().then((result) => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error("Private release failed closed. Inspect configuration/artifact verification; no public fallback is available."); process.exitCode = 1; });
}
