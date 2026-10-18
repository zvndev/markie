import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createPrivateBuilderConfig, createPrivateFeed, forbiddenPrivateValues, PRIVATE_FEED, PRIVATE_GATEWAY_ORIGIN, PRIVATE_PREFIX, privateApiOrigin, privateArtifactName, privateBuildEnvironment, privateBuilderArgs, privateMarker, privateOutputDirectory, privateSettings, privateUpdateConfig, privateUploadUrl, productionPackageNames, publishPrivateFiles, scanPrivateBytes, verifyPrivateBundle, verifyPrivateEntries, verifyPrivateFeed, verifyPrivateSigningAuthority } from "./private-release.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const provenance = { gitCommit: "a".repeat(40), gitDirty: false };
const env = { MARKIE_PRIVATE_API_ORIGIN: PRIVATE_GATEWAY_ORIGIN, MARKIE_PRIVATE_VERSION: "0.8.1-super-nightly.1", MARKIE_PRIVATE_ARCHS: "arm64", MARKIE_PRIVATE_SIGNING_TEAM_ID: "TEAMID1234" };
const hash = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");
const temporaries: string[] = [];
function temporary() { const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "markie-private-test-"))); temporaries.push(directory); return directory; }
function settings(directory?: string) { return privateSettings({ ...env, ...(directory ? { MARKIE_PRIVATE_OUTPUT_DIR: directory } : {}) }, root, provenance); }
function packageEntry(config = settings()) { return { name: "package.json", data: Buffer.from(JSON.stringify({ version: config.version, main: "electron/main.js", markiePrivateRelease: privateMarker(config) })) }; }
afterEach(() => { for (const directory of temporaries.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("guarded private Super-nightly packaging", () => {
  it("requires the reviewed HTTPS gateway, never public storage or a credential/path URL", () => {
    expect(privateApiOrigin(PRIVATE_GATEWAY_ORIGIN)).toBe(PRIVATE_GATEWAY_ORIGIN);
    for (const candidate of [undefined, "http://localhost", "https://markiedocs.com", "https://s3.amazonaws.com", "https://github.com", "https://unreviewed.example", PRIVATE_GATEWAY_ORIGIN + "/private-releases/", PRIVATE_GATEWAY_ORIGIN + "?key=no", PRIVATE_GATEWAY_ORIGIN.replace("https://", "https://user:pass@")]) expect(() => privateApiOrigin(candidate)).toThrow();
  });

  it("requires a clean exact commit and channel-specific version without rewriting source versions", () => {
    const before = readFileSync(path.join(root, "package.json"));
    expect(settings().gitCommit).toBe(provenance.gitCommit);
    expect(settings().version).toBe(env.MARKIE_PRIVATE_VERSION);
    expect(() => privateSettings(env, root, { ...provenance, gitDirty: true })).toThrow(/clean/);
    expect(() => privateSettings({ ...env, MARKIE_PRIVATE_VERSION: "0.8.1-beta.1" }, root, provenance)).toThrow(/super-nightly/);
    expect(() => privateSettings({ ...env, MARKIE_PRIVATE_GIT_COMMIT: "b".repeat(40) }, root, provenance)).toThrow(/commit/);
    expect(readFileSync(path.join(root, "package.json"))).toEqual(before);
  });

  it("uses only ignored dedicated artifacts or an explicit absolute outside-repository directory", () => {
    expect(settings().output).toContain(path.join(".release", "private-artifacts"));
    expect(privateOutputDirectory(root, temporary(), env.MARKIE_PRIVATE_VERSION)).not.toContain(root);
    for (const candidate of [root, path.join(root, "out"), path.join(root, "private-artifacts"), "/", "relative-output"]) expect(() => privateOutputDirectory(root, candidate, env.MARKIE_PRIVATE_VERSION)).toThrow();
  });

  it("clones the real config with no publishing target, MCP resource or source/version mutation", () => {
    const original = require(path.join(root, "electron-builder.config.cjs"));
    const oldPublish = JSON.stringify(original.publish), oldFiles = [...original.files];
    const config = createPrivateBuilderConfig(env, root, provenance);
    expect(config.appId).toBe("com.zvn.markie");
    expect(config.productName).toBe("Markie");
    expect(config.publish).toBeNull(); expect(config.mac.publish).toBeNull(); expect(config.win.publish).toBeNull(); expect(config.linux.publish).toBeNull();
    expect(config.mac.hardenedRuntime).toBe(true); expect(config.mac.notarize).toBe(true);
    expect(config.forceCodeSigning).toBe(true);
    expect(config.mac.target).toEqual([{ target: "zip", arch: ["arm64"] }]);
    expect(config.extraResources).toEqual([]);
    expect(config.extraMetadata).toEqual({ version: env.MARKIE_PRIVATE_VERSION, markiePrivateRelease: privateMarker(settings()) });
    expect(config.files).toContain("!**/.env*"); expect(config.files).toContain("!**/*.map");
    expect(JSON.stringify(original.publish)).toBe(oldPublish); expect(original.files).toEqual(oldFiles);
    expect(privateBuilderArgs()).toEqual(["--config", "electron-builder.private.cjs", "--mac", "--publish", "never"]);
  });

  it("does not hand owner/publisher/public-upload secrets to renderer or builder processes", () => {
    const source = { ...env, MARKIE_PRIVATE_OWNER_UID: "fixture-owner-only", MARKIE_PRIVATE_PUBLISH_KEY: "fixture-publish-only-secret-123456", GH_TOKEN: "fixture-github-secret", AWS_SECRET_ACCESS_KEY: "fixture-public-secret", APPLE_APP_SPECIFIC_PASSWORD: "fixture-signing-only" };
    const renderer = privateBuildEnvironment(source), builder = privateBuildEnvironment(source, true);
    expect(renderer).not.toHaveProperty("APPLE_APP_SPECIFIC_PASSWORD");
    expect(builder.APPLE_APP_SPECIFIC_PASSWORD).toBe(source.APPLE_APP_SPECIFIC_PASSWORD);
    for (const clean of [renderer, builder]) for (const key of ["MARKIE_PRIVATE_OWNER_UID", "MARKIE_PRIVATE_PUBLISH_KEY", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY"]) expect(clean).not.toHaveProperty(key);
    expect(forbiddenPrivateValues(source)).toContain(source.MARKIE_PRIVATE_OWNER_UID);
    expect(() => scanPrivateBytes("out/main.js", Buffer.from(source.MARKIE_PRIVATE_OWNER_UID), forbiddenPrivateValues(source))).toThrow(/Forbidden/);
    expect(() => scanPrivateBytes("out/main.js", Buffer.from("-----BEGIN PRIVATE KEY-----"))).toThrow(/Credential/);
  });

  it("allows only runtime trees and resolved production dependencies; rejects tests, source maps and private files", () => {
    const config = settings(), options = { productionNames: new Set(["electron-updater"]), forbidden: [] };
    expect(verifyPrivateEntries([packageEntry(config), { name: "electron/main.js", data: Buffer.from("runtime") }, { name: "node_modules/electron-updater/out/main.js", data: Buffer.from("runtime") }], config, options)).toBe(3);
    for (const name of [".env", "out/.env.local", "out/bundle.js.map", "electron/auth.test.js", "src/app.tsx", "scripts/private-release.mjs", "node_modules/react/index.js", "node_modules/electron-updater/test/example.js", "../outside"]) expect(() => verifyPrivateEntries([packageEntry(config), { name, data: Buffer.from("fixture") }], config, options)).toThrow();
    expect(() => verifyPrivateEntries([packageEntry(config), { name: "electron/ignored.js", data: Buffer.from("fixture") }], config, { ...options, ignoredFiles: ["electron/ignored.js"] })).toThrow(/ignored/);
    expect(productionPackageNames(root).has("electron-updater")).toBe(true);
    expect(productionPackageNames(root).has("react")).toBe(false);
  });

  it("inspects real ASAR contents and refuses public updater configuration or bundled owner identifiers", async () => {
    const directory = temporary(), app = path.join(directory, "Markie.app"), resources = path.join(app, "Contents", "Resources"), source = path.join(directory, "source"), config = settings();
    mkdirSync(resources, { recursive: true }); mkdirSync(path.join(source, "electron"), { recursive: true });
    writeFileSync(path.join(source, "package.json"), packageEntry(config).data);
    writeFileSync(path.join(source, "electron", "main.js"), "runtime");
    await require("@electron/asar").createPackage(source, path.join(resources, "app.asar"));
    writeFileSync(path.join(resources, "app-update.yml"), JSON.stringify(privateUpdateConfig(config)));
    expect(verifyPrivateBundle(app, config, { root, forbidden: [] }).entries).toBe(2);
    writeFileSync(path.join(resources, "app-update.yml"), JSON.stringify({ provider: "generic", url: "https://markiedocs.com/releases/" }));
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: [] })).toThrow(/updater/);
    writeFileSync(path.join(resources, "app-update.yml"), JSON.stringify(privateUpdateConfig(config)));
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: ["runtime"] })).toThrow(/Forbidden/);
    mkdirSync(path.join(resources, "mcp")); writeFileSync(path.join(resources, "mcp", "markie-mcp.mjs"), "standalone runtime");
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: [] })).toThrow(/bypass/);
  });

  it("checks all unpacked files against flagged ASAR entries and rejects unindexed/private siblings", async () => {
    const directory = temporary(), app = path.join(directory, "Markie.app"), resources = path.join(app, "Contents", "Resources"), source = path.join(directory, "source"), config = settings();
    mkdirSync(resources, { recursive: true }); mkdirSync(path.join(source, "electron"), { recursive: true });
    writeFileSync(path.join(source, "package.json"), packageEntry(config).data);
    writeFileSync(path.join(source, "electron", "main.js"), "runtime");
    await require("@electron/asar").createPackageWithOptions(source, path.join(resources, "app.asar"), { unpack: "**/main.js" });
    writeFileSync(path.join(resources, "app-update.yml"), JSON.stringify(privateUpdateConfig(config)));
    expect(verifyPrivateBundle(app, config, { root, forbidden: [] }).entries).toBe(2);
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: ["runtime"] })).toThrow(/Forbidden/);
    const injected = path.join(resources, "app.asar.unpacked", "fixture.env");
    writeFileSync(injected, "unindexed-forbidden-sentinel");
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: ["unindexed-forbidden-sentinel"] })).toThrow(/Unindexed/);
    rmSync(injected);
    writeFileSync(path.join(resources, "app.asar-backup"), "unindexed-forbidden-sentinel");
    expect(() => verifyPrivateBundle(app, config, { root, forbidden: [] })).toThrow(/archive sibling/);
  });

  it("requires and verifies the reviewed Developer ID team rather than any Developer ID certificate", () => {
    expect(settings().signingTeamId).toBe("TEAMID1234");
    expect(() => privateSettings({ ...env, MARKIE_PRIVATE_SIGNING_TEAM_ID: undefined }, root, provenance)).toThrow(/signing team/);
    expect(() => privateSettings({ ...env, MARKIE_PRIVATE_SIGNING_TEAM_ID: "short" }, root, provenance)).toThrow(/signing team/);
    expect(() => privateSettings({ ...env, APPLE_TEAM_ID: "OTHER12345" }, root, provenance)).toThrow(/teams must agree/);
    const authority = "Authority=Developer ID Application: Fixture Organization\nTeamIdentifier=TEAMID1234\n";
    expect(() => verifyPrivateSigningAuthority(authority, settings())).not.toThrow();
    expect(() => verifyPrivateSigningAuthority(authority.replace("TEAMID1234", "OTHER12345"), settings())).toThrow(/reviewed team/);
    expect(() => verifyPrivateSigningAuthority("TeamIdentifier=TEAMID1234\n", settings())).toThrow(/Developer ID/);
  });

  it("creates a hash/size-checked private feed containing versioned basenames only", () => {
    const config = settings(temporary()), zip = `Markie-${config.version}-arm64.zip`;
    writeFileSync(path.join(config.output, zip), "fixture signed archive");
    const feed = createPrivateFeed(config);
    expect(verifyPrivateFeed(feed, config)).toBe(feed);
    expect(feed.files[0]).toEqual({ url: zip, size: 22, sha512: hash(Buffer.from("fixture signed archive")) });
    expect(privateArtifactName(zip, config)).toBe(true);
    expect(privateArtifactName("Markie-0.8.0-arm64.zip", config)).toBe(false);
    expect(privateArtifactName(zip.replace(".zip", ".dmg"), config)).toBe(false);
    expect(() => privateUploadUrl(config, zip.replace(".zip", ".dmg"))).toThrow();
    expect(() => verifyPrivateFeed({ ...feed, files: [{ ...feed.files[0], url: zip.replace(".zip", ".dmg") }] }, config)).toThrow();
    for (const url of ["../outside.zip", "https://public.example/artifact.zip", "latest-mac.yml"]) expect(() => verifyPrivateFeed({ ...feed, files: [{ ...feed.files[0], url }] }, config)).toThrow();
    expect(() => verifyPrivateFeed({ ...feed, files: [feed.files[0], feed.files[0]] }, config)).toThrow(/duplicate/);
    expect(() => verifyPrivateFeed({ ...feed, path: "public.zip" }, config)).toThrow();
    writeFileSync(path.join(config.output, zip.replace(".zip", ".dmg")), "unsupported fixture disk image");
    expect(() => createPrivateFeed(config)).toThrow(/ZIP-only/);
  });

  it("sends immutable artifacts first and feed last only to the trusted prefix, with required digest/length and no redirects", async () => {
    const config = settings(temporary()), names = [`Markie-${config.version}-arm64.zip`, `Markie-${config.version}-arm64.zip.blockmap`, PRIVATE_FEED];
    const files = names.map((name) => { const file = path.join(config.output, name), bytes = Buffer.from(name); writeFileSync(file, bytes); return { name, file, size: bytes.length, sha512: hash(bytes) }; });
    const verified = { version: config.version, gitCommit: config.gitCommit, files }, key = "fixture-publisher-key-" + "x".repeat(32);
    const fetcher = vi.fn(async () => new Response("", { status: 201 }));
    await publishPrivateFiles(config, verified, key, fetcher);
    expect(fetcher.mock.calls).toHaveLength(3);
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    for (const [index, [url, request]] of calls.entries()) {
      expect(url).toBe(config.apiOrigin + PRIVATE_PREFIX + names[index]);
      expect(request.redirect).toBe("error"); expect(request.credentials).toBe("omit");
      expect(request.headers).toMatchObject({ "x-markie-publish-key": key, "x-markie-sha512": files[index].sha512, "Content-Length": String(files[index].size) });
    }
    expect(calls[0][1].headers).toHaveProperty("If-None-Match", "*");
    expect(calls[2][1].headers).not.toHaveProperty("If-None-Match");
    expect(() => privateUploadUrl(config, "latest-mac.yml")).toThrow();
    expect(() => privateUploadUrl(config, "../public.zip")).toThrow();
  });

  it("halts promotion on upload failure or changed bytes without sending the feed", async () => {
    const config = settings(temporary()), names = [`Markie-${config.version}-arm64.zip`, PRIVATE_FEED];
    const files = names.map((name) => { const file = path.join(config.output, name), bytes = Buffer.from(name); writeFileSync(file, bytes); return { name, file, size: bytes.length, sha512: hash(bytes) }; });
    const verified = { version: config.version, gitCommit: config.gitCommit, files }, key = "x".repeat(32);
    const failure = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(publishPrivateFiles(config, verified, key, failure)).rejects.toThrow(/stopped/);
    expect(failure).toHaveBeenCalledTimes(1);
    writeFileSync(files[0].file, "changed");
    const fetcher = vi.fn(async () => new Response("", { status: 201 }));
    await expect(publishPrivateFiles(config, verified, key, fetcher)).rejects.toThrow(/changed/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
