// The Mac cutover (0.10.0): Apple Silicon moves to Markie RS through mac/,
// Intel stays on Electron through mac-intel/. Every fixture here is made up:
// fake bytes, a fake bucket, a fake website. electron-updater's file choice is
// its real code from node_modules, not a copy of it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoElectronArm64,
  bridgeFromFeed,
  buildCutoverFeeds,
  isElectronBundle,
  macCutoverConfig,
  parseCodesignDetails,
  readRustRelease,
  updaterChoice,
} from "../scripts/lib/mac-cutover.mjs";
import {
  guardMacUpload,
  parseElectronBuilderFeed,
  promoteRelease,
  publishEarly,
  rollbackEarly,
  setReleaseIo,
  stageMacCutover,
  verifyLocalMacArtifacts,
  verifyPublicMac,
} from "../scripts/release.mjs";
import { currentManifest, preCutoverManifest } from "../scripts/lib/release-test-manifest";

const manifest = currentManifest();
const cutover = macCutoverConfig(manifest)!;
const PUBLIC = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
const SITE = manifest.siteUrl.replace(/\/+$/, "");
const COMMIT = "2222222222222222222222222222222222222222";
const RUST_COMMIT = "3333333333333333333333333333333333333333";
const T0 = new Date("2026-12-01T12:00:00.000Z");

const sha = (data: Buffer | string) => createHash("sha512").update(data).digest("base64");
const record = (name: string, body = `bytes:${name}`) => ({ name, size: Buffer.byteLength(body), sha512: sha(body) });

// ---------------------------------------------------------------------------
// The feeds, and what electron-updater does with them
// ---------------------------------------------------------------------------

const rust = (v: string) => ({ version: v, files: [record(`Markie-${v}-arm64.zip`), record(`Markie-${v}-arm64.dmg`)] });
const intel = (v: string) => ({ version: v, files: [record(`Markie-${v}-x64.zip`), record(`Markie-${v}-x64.dmg`)] });
const names = (text: string) => parseElectronBuilderFeed(text).files.map((entry) => entry.url);

describe("the cutover feed writer", () => {
  it("reads the cutover out of the real manifest", () => {
    expect(cutover).toMatchObject({
      version: "0.10.0",
      armDir: "mac",
      intelDir: "mac-intel",
      armFeedPath: "mac/latest-mac.yml",
      intelFeedPath: "mac-intel/latest-mac.yml",
      armEarlyPath: "mac/beta-mac.yml",
      intelEarlyPath: "mac-intel/beta-mac.yml",
      bundleId: "com.zvn.markie",
      teamId: "3VU8SG5TD9",
    });
    expect(macCutoverConfig(preCutoverManifest())).toBeNull();
  });

  it("writes mac/ with the Rust arm64 build plus the Intel bridge, and mac-intel/ with Intel only", () => {
    const { mac, macIntel, bridge } = buildCutoverFeeds({
      rust: rust("0.10.0"),
      intel: intel("0.10.0"),
      cutoverVersion: "0.10.0",
      releaseDate: "2026-12-01T00:00:00.000Z",
    });
    expect(mac!.version).toBe("0.10.0");
    expect(names(mac!.text)).toEqual(["Markie-0.10.0-arm64.zip", "Markie-0.10.0-arm64.dmg", "Markie-0.10.0-x64.zip"]);
    // The legacy single-file fields point at the Rust ZIP.
    expect(mac!.text).toMatch(/^path: Markie-0\.10\.0-arm64\.zip$/m);
    expect(names(macIntel!.text)).toEqual(["Markie-0.10.0-x64.zip", "Markie-0.10.0-x64.dmg"]);
    expect(macIntel!.text).not.toMatch(/arm64/);
    // In a joint release the bridge is this release's own x64 ZIP, same bytes.
    expect(bridge).toEqual(intel("0.10.0").files[0]);
    expect((parseElectronBuilderFeed(mac!.text).files[2] as { sha512?: string }).sha512).toBe(intel("0.10.0").files[0].sha512);
  });

  it("refuses a mac/ feed with no x64 entry, and a bridge from before the cutover", () => {
    expect(() => buildCutoverFeeds({ rust: rust("0.10.3"), cutoverVersion: "0.10.0" })).toThrow(/Intel bridge/);
    expect(() =>
      buildCutoverFeeds({ rust: rust("0.10.3"), bridge: record("Markie-0.9.7-x64.zip"), cutoverVersion: "0.10.0" })
    ).toThrow(/older than the cutover/);
    expect(() =>
      buildCutoverFeeds({ rust: rust("0.10.3"), bridge: record("Markie-0.10.0-arm64.zip"), cutoverVersion: "0.10.0" })
    ).toThrow(/Electron x64 ZIP/);
    expect(() => buildCutoverFeeds({ intel: intel("0.9.8"), cutoverVersion: "0.10.0" })).toThrow(/older than the cutover/);
  });
});

describe("electron-updater's own file choice", () => {
  const joint = buildCutoverFeeds({ rust: rust("0.10.0"), intel: intel("0.10.0"), cutoverVersion: "0.10.0" });

  it("sends Apple Silicon to the Rust ZIP and Intel to the Electron x64 ZIP from one mac/ feed", () => {
    const arm = updaterChoice(joint.mac!.text, { arm64Mac: true, currentVersion: "0.9.7" });
    expect(arm).toMatchObject({ offered: true, file: "Markie-0.10.0-arm64.zip" });
    expect(arm.url).toBe("https://updates.invalid/mac/Markie-0.10.0-arm64.zip");
    const x64 = updaterChoice(joint.mac!.text, { arm64Mac: false, currentVersion: "0.9.7" });
    expect(x64).toMatchObject({ offered: true, file: "Markie-0.10.0-x64.zip" });
  });

  it("keeps Intel builds on Intel from mac-intel/, Rosetta included", () => {
    expect(updaterChoice(joint.macIntel!.text, { arm64Mac: false, currentVersion: "0.10.0" })).toMatchObject({
      offered: false,
      file: "Markie-0.10.0-x64.zip",
    });
    // An Intel build run under Rosetta on Apple Silicon counts as an arm64 Mac
    // to electron-updater; with no arm64 file in mac-intel/ it still gets x64.
    expect(updaterChoice(joint.macIntel!.text, { arm64Mac: true }).file).toBe("Markie-0.10.0-x64.zip");
  });

  it("would strand every old Intel install if mac/ ever lost its x64 entry", () => {
    // Why buildCutoverFeeds insists on the bridge: the real updater drops
    // arm64 files on Intel and finds nothing left to download.
    const rustOnly = `version: 0.10.3
files:
  - url: Markie-0.10.3-arm64.zip
    sha512: ${record("z").sha512}
    size: 9
path: Markie-0.10.3-arm64.zip
`;
    expect(updaterChoice(rustOnly, { arm64Mac: false, currentVersion: "0.9.7" })).toMatchObject({ offered: true, file: null });
  });
});

describe("the Intel bridge after the Rust version moves past Intel's", () => {
  it("carries the bridge forward byte for byte through Rust-only releases", () => {
    const first = buildCutoverFeeds({ rust: rust("0.10.0"), intel: intel("0.10.0"), cutoverVersion: "0.10.0" });
    let feed = parseElectronBuilderFeed(first.mac!.text);
    for (const next of ["0.10.3", "0.11.0", "1.0.0"]) {
      const bridge = bridgeFromFeed(feed, "0.10.0");
      expect(bridge).toMatchObject({ name: "Markie-0.10.0-x64.zip", version: "0.10.0", sha512: intel("0.10.0").files[0].sha512 });
      const { mac, macIntel } = buildCutoverFeeds({ rust: rust(next), bridge, cutoverVersion: "0.10.0" });
      // Rust-only: mac-intel/ is not written.
      expect(macIntel).toBeNull();
      expect(mac!.version).toBe(next);
      expect(names(mac!.text)).toEqual([`Markie-${next}-arm64.zip`, `Markie-${next}-arm64.dmg`, "Markie-0.10.0-x64.zip"]);

      // An Intel Mac still on 0.9.7 is offered the Rust version and downloads
      // the 0.10.0 Intel bridge, which then reads mac-intel/.
      expect(updaterChoice(mac!.text, { arm64Mac: false, currentVersion: "0.9.7" })).toMatchObject({
        offered: true,
        file: "Markie-0.10.0-x64.zip",
      });
      // Apple Silicon, Electron 0.9.7 or Markie RS, gets the new Rust build.
      expect(updaterChoice(mac!.text, { arm64Mac: true, currentVersion: "0.9.7" }).file).toBe(`Markie-${next}-arm64.zip`);
      feed = parseElectronBuilderFeed(mac!.text);
    }
  });

  it("moves the bridge forward only with a joint release", () => {
    // Intel shipped 0.10.1 on its own (mac-intel/ only), then 0.10.4 shipped
    // both: the bridge becomes 0.10.4's ZIP.
    const intelOnly = buildCutoverFeeds({ intel: intel("0.10.1"), cutoverVersion: "0.10.0" });
    expect(intelOnly.mac).toBeNull();
    expect(intelOnly.bridge).toBeNull();
    const joint = buildCutoverFeeds({ rust: rust("0.10.4"), intel: intel("0.10.4"), cutoverVersion: "0.10.0" });
    expect(bridgeFromFeed(parseElectronBuilderFeed(joint.mac!.text), "0.10.0")?.name).toBe("Markie-0.10.4-x64.zip");
  });

  it("finds no bridge in a feed from before the cutover", () => {
    const old = parseElectronBuilderFeed(
      ["Markie-0.9.7-arm64.zip", "Markie-0.9.7-x64.zip", "Markie-0.9.7-arm64.dmg", "Markie-0.9.7-x64.dmg"].reduce(
        (text, name) => `${text}  - url: ${name}\n    sha512: ${record(name).sha512}\n    size: 9\n`,
        "version: 0.9.7\nfiles:\n"
      )
    );
    expect(bridgeFromFeed(old, "0.10.0")).toBeNull();
  });
});

describe("refusing an Electron arm64 build under the cutover", () => {
  const rustFiles = rust("0.10.0").files;

  it("lets through the Rust bytes and their blockmaps, and nothing else arm64", () => {
    expect(() => assertNoElectronArm64([...rustFiles, { name: "Markie-0.10.0-arm64.zip.blockmap" }], rustFiles)).not.toThrow();
    expect(() => assertNoElectronArm64([record("Markie-0.10.0-x64.zip")], [])).not.toThrow();
    // Same name, Electron's bytes.
    expect(() => assertNoElectronArm64([record("Markie-0.10.0-arm64.zip", "electron arm64 build")], rustFiles)).toThrow(
      /refusing Markie-0\.10\.0-arm64\.zip.*never published/
    );
    // Any arm64 file at all toward mac-intel/.
    expect(() => assertNoElectronArm64(rustFiles, [])).toThrow(/refusing/);
  });

  it("recognises an Electron bundle inside a ZIP", () => {
    expect(isElectronBundle(["Markie.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"])).toBe(true);
    expect(isElectronBundle(["Markie.app/Contents/MacOS/markie", "Markie.app/Contents/Info.plist"])).toBe(false);
  });

  it("reads the signing identity codesign prints", () => {
    expect(
      parseCodesignDetails("Executable=/x/Markie.app/Contents/MacOS/markie\nIdentifier=com.zvn.markie\nFormat=app bundle\nTeamIdentifier=3VU8SG5TD9\n")
    ).toEqual({ identifier: "com.zvn.markie", teamId: "3VU8SG5TD9" });
  });
});

// ---------------------------------------------------------------------------
// The Rust release folder
// ---------------------------------------------------------------------------

function writeRustFolder(dir: string, version: string, { salt = "rust", extra = {} as Record<string, unknown> } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = [`Markie-${version}-arm64.zip`, `Markie-${version}-arm64.dmg`].map((name) => {
    const body = `${salt}:${name}`;
    writeFileSync(path.join(dir, name), body);
    return record(name, body);
  });
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, gitCommit: RUST_COMMIT, files, ...extra }));
  return files;
}

describe("the Rust release folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "markie-rust-folder-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads release.json and checks every byte against it", async () => {
    writeRustFolder(dir, "0.10.0");
    const release = await readRustRelease(dir, { expectVersion: "0.10.0" });
    expect(release.version).toBe("0.10.0");
    expect(release.gitCommit).toBe(RUST_COMMIT);
    expect(release.files.map((file) => file.name)).toEqual(["Markie-0.10.0-arm64.zip", "Markie-0.10.0-arm64.dmg"]);
  });

  it("refuses a file that does not match, a stray file, a version mismatch, or a prerelease", async () => {
    writeRustFolder(dir, "0.10.0");
    writeFileSync(path.join(dir, "Markie-0.10.0-arm64.zip"), "something else entirely");
    await expect(readRustRelease(dir)).rejects.toThrow(/does not match|bytes/);

    writeRustFolder(dir, "0.10.0", { extra: { files: [record("Markie-0.10.0-arm64.zip"), record("Markie-0.10.0-x64.zip")] } });
    await expect(readRustRelease(dir)).rejects.toThrow(/must list exactly/);

    writeRustFolder(dir, "0.10.0");
    await expect(readRustRelease(dir, { expectVersion: "0.10.1" })).rejects.toThrow(/expected 0\.10\.1/);

    writeRustFolder(dir, "0.10.0-rc.1");
    await expect(readRustRelease(dir)).rejects.toThrow(/prerelease/);
    await expect(readRustRelease(dir, { allowPrerelease: true })).resolves.toMatchObject({ version: "0.10.0-rc.1" });
  });
});

// ---------------------------------------------------------------------------
// The release runner, end to end, against a fake bucket and website
// ---------------------------------------------------------------------------

const fakeBlockmap = async (file: string, out: string) => writeFileSync(out, `blockmap:${path.basename(file)}`);

function writeIntelBuild(root: string, version: string) {
  const dist = path.join(root, "dist");
  mkdirSync(dist, { recursive: true });
  for (const name of [`Markie-${version}-x64.zip`, `Markie-${version}-x64.dmg`]) {
    writeFileSync(path.join(dist, name), `electron-x64:${name}`);
    writeFileSync(path.join(dist, `${name}.blockmap`), `blockmap:${name}`);
  }
}

/** What release:prepare:mac leaves behind under the cutover, minus building and signing. */
async function prepareCutover(
  root: string,
  { mode, version, packageVersion = version, bridge = null }: { mode: string; version: string; packageVersion?: string; bridge?: unknown }
) {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: packageVersion }));
  rmSync(path.join(root, "dist"), { recursive: true, force: true });
  if (mode !== "rust-only") writeIntelBuild(root, version);
  let rustRelease = null;
  if (mode !== "intel-only") {
    const rustDir = path.join(root, "rust-release", version);
    writeRustFolder(rustDir, version);
    rustRelease = await readRustRelease(rustDir);
  }
  await stageMacCutover({ root, cutover, mode, version, rust: rustRelease, bridge, releaseDate: T0.toISOString(), blockmap: fakeBlockmap });
  const local = await verifyLocalMacArtifacts({ root });
  const targets = Object.fromEntries(
    Object.entries((local as unknown as { targets: Record<string, { files: unknown[]; carriedFiles: unknown[] }> }).targets).map(
      ([name, target]) => [name, { files: target.files, carriedFiles: target.carriedFiles }]
    )
  );
  mkdirSync(path.join(root, ".release", version), { recursive: true });
  writeFileSync(path.join(root, ".release", version, "local.json"), JSON.stringify({ version, commit: COMMIT, mode, targets }));
  return local;
}

function feedYaml(version: string, files: { name: string; size: number; sha512: string }[]) {
  return (
    `version: ${version}\nfiles:\n` +
    files.map((f) => `  - url: ${f.name}\n    sha512: ${f.sha512}\n    size: ${f.size}`).join("\n") +
    `\npath: ${files[0].name}\nsha512: ${files[0].sha512}\n`
  );
}

/** The bucket, plus the parts of markiedocs.com that read it, deployed with the cutover. */
function makeWorld({ serverKnowsCutover = true } = {}) {
  const objects = new Map<string, Buffer>();
  const uploads: { platform: string; key: string }[] = [];
  const dirFor = (platform: string) => ({ mac: "mac", "mac-intel": "mac-intel", win: "windows", linux: "linux" })[platform]!;
  const put = (key: string, data: string | Buffer) => objects.set(`${PUBLIC}/${key}`, Buffer.from(data));
  const text = (key: string) => objects.get(`${PUBLIC}/${key}`)?.toString("utf8") ?? null;
  const version = (key: string) => text(key)?.match(/^version:\s*(\S+)/m)?.[1] ?? null;
  const listed = (key: string, pattern: RegExp) => (text(key) ?? "").match(pattern)?.[0] ?? null;

  const publish = (platform: string, files: string[]) => {
    for (const file of files) {
      const key = `${dirFor(platform)}/${path.basename(file)}`;
      put(key, readFileSync(file));
      uploads.push({ platform, key });
    }
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split("?")[0];
    const method = init?.method ?? "GET";
    if (url.startsWith(`${PUBLIC}/`)) {
      const body = objects.get(url);
      if (!body) return new Response("not found", { status: 404 });
      return new Response(method === "HEAD" ? null : new Uint8Array(body), {
        status: 200,
        headers: { "content-length": String(body.length) },
      });
    }
    // The server: Apple Silicon from mac/, Intel from mac-intel/ (or mac/
    // while mac-intel/ does not exist), as server/src/public.ts resolves them.
    const armDmg = listed("mac/latest-mac.yml", /Markie-[^\s]+-arm64\.dmg/);
    const intelKey = text("mac-intel/latest-mac.yml") && serverKnowsCutover ? "mac-intel/latest-mac.yml" : "mac/latest-mac.yml";
    const intelDmg = listed(intelKey, /Markie-[^\s]+-x64\.dmg/);
    const winExe = listed("windows/latest.yml", /Markie-[^\s]+-x64\.exe/);
    const at = (key: string, name: string | null) => (name ? `${PUBLIC}/${path.posix.dirname(key)}/${encodeURIComponent(name)}` : null);
    if (url === `${SITE}/download/latest.json`) {
      return Response.json({
        schemaVersion: 2,
        channel: "stable",
        version: version("mac/latest-mac.yml"),
        downloadPageUrl: `${SITE}/download`,
        platforms: [
          { id: "mac-arm64", version: version("mac/latest-mac.yml"), downloadUrl: `${SITE}/download/mac`, artifactUrl: at("mac/latest-mac.yml", armDmg) },
          { id: "mac-x64", version: version(intelKey), downloadUrl: `${SITE}/download/mac-intel`, artifactUrl: at(intelKey, intelDmg) },
          { id: "windows-x64", downloadUrl: `${SITE}/download/windows`, artifactUrl: at("windows/latest.yml", winExe) },
        ],
        awaitingFirstRelease: ["linux-x64", "linux-x64-deb"],
        macCutover: serverKnowsCutover ? cutover.version : null,
      });
    }
    if (url === `${SITE}/download`) return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    const routes: Record<string, string | null> = {
      [`${SITE}/download/mac`]: at("mac/latest-mac.yml", armDmg),
      [`${SITE}/download/mac-intel`]: at(intelKey, intelDmg),
      [`${SITE}/download/windows`]: at("windows/latest.yml", winExe),
    };
    if (url in routes && routes[url]) return new Response(null, { status: 302, headers: { location: routes[url]! } });
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  };

  return { objects, uploads, put, text, version, publish, fetch: fetchImpl as typeof fetch };
}

/** Production today: 0.9.7 on one dual-arch mac/ feed, Windows beside it. */
function seedPreCutover(world: ReturnType<typeof makeWorld>) {
  const files = ["Markie-0.9.7-arm64.zip", "Markie-0.9.7-x64.zip", "Markie-0.9.7-arm64.dmg", "Markie-0.9.7-x64.dmg"].map((name) => {
    world.put(`mac/${name}`, `old:${name}`);
    return record(name, `old:${name}`);
  });
  world.put("mac/latest-mac.yml", feedYaml("0.9.7", files));
  const exe = record("Markie-0.9.7-x64.exe", "old:exe");
  world.put("windows/Markie-0.9.7-x64.exe", "old:exe");
  world.put("windows/latest.yml", feedYaml("0.9.7", [exe]));
}

describe("a cutover release through early access, promotion and verification", () => {
  let root: string;
  let world: ReturnType<typeof makeWorld>;
  let restoreIo: () => void;
  let previousFetch: typeof fetch;
  let logs: string[];

  const start = (options?: { serverKnowsCutover?: boolean }) => {
    world = makeWorld(options);
    seedPreCutover(world);
    globalThis.fetch = world.fetch;
    restoreIo = setReleaseIo({
      root,
      now: () => new Date(T0),
      pollDelayMs: 0,
      releaseGitState: () => COMMIT,
      promoteGitState: () => {},
      publishCredentials: () => {},
      verifyLocal: async () => verifyLocalMacArtifacts({ root }),
      publish: world.publish,
      log: (line: string) => void logs.push(line),
    });
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "markie-cutover-"));
    logs = [];
    previousFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreIo?.();
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("ships 0.10.0: Rust to mac/, Intel to mac-intel/, the bridge to both, Intel's feed first", async () => {
    start();
    await prepareCutover(root, { mode: "joint", version: "0.10.0" });
    const state = await publishEarly("mac", "0.10.0");

    expect(Object.keys(state.platforms).sort()).toEqual(["mac", "mac-intel"]);
    expect(names(world.text("mac/beta-mac.yml")!)).toEqual(["Markie-0.10.0-arm64.zip", "Markie-0.10.0-arm64.dmg", "Markie-0.10.0-x64.zip"]);
    expect(names(world.text("mac-intel/beta-mac.yml")!)).toEqual(["Markie-0.10.0-x64.zip", "Markie-0.10.0-x64.dmg"]);
    // Stable is untouched by early access.
    expect(world.version("mac/latest-mac.yml")).toBe("0.9.7");
    expect(world.text("mac-intel/latest-mac.yml")).toBeNull();

    const keys = world.uploads.map((upload) => upload.key);
    // Artifacts first, then mac-intel's feed, then mac's.
    expect(keys.slice(-2)).toEqual(["mac-intel/beta-mac.yml", "mac/beta-mac.yml"]);
    expect(keys.filter((key) => key.endsWith(".yml"))).toHaveLength(2);
    // The bridge travels with the release to mac/, and the Intel files to mac-intel/.
    expect(keys).toContain("mac/Markie-0.10.0-x64.zip");
    expect(keys).toContain("mac-intel/Markie-0.10.0-x64.zip");
    expect(keys).toContain("mac-intel/Markie-0.10.0-x64.dmg");
    expect(keys).not.toContain("mac/Markie-0.10.0-x64.dmg");
    // The only arm64 bytes in the bucket are the Rust release's.
    expect(keys.filter((key) => key.includes("arm64") && !key.endsWith(".blockmap"))).toEqual([
      "mac/Markie-0.10.0-arm64.zip",
      "mac/Markie-0.10.0-arm64.dmg",
    ]);
    expect(world.text("mac/Markie-0.10.0-arm64.zip")).toBe("rust:Markie-0.10.0-arm64.zip");

    const promoted = await promoteRelease("0.10.0", { force: true });
    expect(promoted.promotedAt).toBeTruthy();
    expect(world.text("mac/latest-mac.yml")).toBe(world.text("mac/beta-mac.yml"));
    expect(world.text("mac-intel/latest-mac.yml")).toBe(world.text("mac-intel/beta-mac.yml"));
    const stableWrites = world.uploads.map((upload) => upload.key).filter((key) => key.endsWith("latest-mac.yml"));
    expect(stableWrites).toEqual(["mac-intel/latest-mac.yml", "mac/latest-mac.yml"]);
    // The feed promotion replaced is saved for a rollback, under its own name.
    expect(readFileSync(path.join(root, ".release/0.10.0/previous-latest-mac.yml"), "utf8")).toMatch(/^version: 0\.9\.7/m);
    expect(existsSync(path.join(root, ".release/0.10.0/previous-mac-intel-latest-mac.yml"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, ".release/0.10.0/public-mac-intel.json"), "utf8"))).toMatchObject({
      platform: "mac-intel",
      intelUrl: `${PUBLIC}/mac-intel/Markie-0.10.0-x64.dmg`,
    });

    const verified = await verifyPublicMac({ expectedVersion: "0.10.0", expectedIntelVersion: "0.10.0", deep: true });
    expect(verified).toMatchObject({
      version: "0.10.0",
      intelVersion: "0.10.0",
      primaryUrl: `${PUBLIC}/mac/Markie-0.10.0-arm64.dmg`,
      intelUrl: `${PUBLIC}/mac-intel/Markie-0.10.0-x64.dmg`,
      legacy: false,
    });
  });

  it("then ships Rust 0.10.3 alone, carrying the 0.10.0 bridge and leaving mac-intel/ alone", async () => {
    start();
    await prepareCutover(root, { mode: "joint", version: "0.10.0" });
    await publishEarly("mac", "0.10.0");
    await promoteRelease("0.10.0", { force: true });
    const intelBefore = world.text("mac-intel/latest-mac.yml");
    const uploadsBefore = world.uploads.length;

    const stable = parseElectronBuilderFeed(world.text("mac/latest-mac.yml")!);
    const bridge = bridgeFromFeed(stable, cutover.version);
    // package.json stays on the Electron version; the release is keyed by Rust's.
    await prepareCutover(root, { mode: "rust-only", version: "0.10.3", packageVersion: "0.10.0", bridge });
    const state = await publishEarly("mac", "0.10.3");
    expect(Object.keys(state.platforms)).toEqual(["mac"]);
    expect(state.platforms.mac.carriedFiles).toEqual([
      { name: "Markie-0.10.0-x64.zip", size: bridge!.size, sha512: bridge!.sha512 },
    ]);
    const newKeys = world.uploads.slice(uploadsBefore).map((upload) => upload.key);
    expect(newKeys.some((key) => key.includes("x64"))).toBe(false);
    expect(newKeys.some((key) => key.startsWith("mac-intel/"))).toBe(false);

    await promoteRelease("0.10.3", { force: true });
    expect(world.version("mac/latest-mac.yml")).toBe("0.10.3");
    expect(names(world.text("mac/latest-mac.yml")!)).toEqual([
      "Markie-0.10.3-arm64.zip",
      "Markie-0.10.3-arm64.dmg",
      "Markie-0.10.0-x64.zip",
    ]);
    expect(world.text("mac-intel/latest-mac.yml")).toBe(intelBefore);
    // The real updater, on the public feeds: an Intel Mac still on 0.9.7 lands
    // on the 0.10.0 bridge, Apple Silicon on Rust 0.10.3.
    expect(updaterChoice(world.text("mac/latest-mac.yml")!, { arm64Mac: false, currentVersion: "0.9.7" })).toMatchObject({
      offered: true,
      file: "Markie-0.10.0-x64.zip",
    });
    await expect(verifyPublicMac({ expectedVersion: "0.10.3", expectedIntelVersion: "0.10.0", deep: true })).resolves.toMatchObject({
      version: "0.10.3",
      intelVersion: "0.10.0",
    });
  });

  it("refuses to promote before the server knows the cutover, and writes no stable feed", async () => {
    start({ serverKnowsCutover: false });
    await prepareCutover(root, { mode: "joint", version: "0.10.0" });
    await publishEarly("mac", "0.10.0");
    await expect(promoteRelease("0.10.0", { force: true })).rejects.toThrow(/does not know the 0\.10\.0 Mac cutover/);
    expect(world.version("mac/latest-mac.yml")).toBe("0.9.7");
    expect(world.text("mac-intel/latest-mac.yml")).toBeNull();
  });

  it("lets only the cutover release create mac-intel/", async () => {
    start();
    await prepareCutover(root, { mode: "intel-only", version: "0.10.1" });
    await expect(publishEarly("mac", "0.10.1")).rejects.toThrow(/only the cutover release 0\.10\.0 may create it/);
    expect(world.uploads).toHaveLength(0);
  });

  it("refuses an Electron arm64 ZIP staged in place of the Rust one", async () => {
    start();
    await prepareCutover(root, { mode: "joint", version: "0.10.0" });
    // Swap in other bytes under the Rust name, and make the staged feed agree
    // with them, so only the Rust allowlist stands in the way.
    const dir = path.join(root, "dist/cutover/mac");
    const zip = path.join(dir, "Markie-0.10.0-arm64.zip");
    // Staging hard-links where it can; replace the file rather than write
    // through the link into the Rust folder.
    rmSync(zip);
    writeFileSync(zip, "an Electron arm64 build");
    const feedPath = path.join(dir, "latest-mac.yml");
    const swapped = record("Markie-0.10.0-arm64.zip", "an Electron arm64 build");
    writeFileSync(
      feedPath,
      readFileSync(feedPath, "utf8")
        .replace(/(url: Markie-0\.10\.0-arm64\.zip\n\s+sha512: )\S+(\n\s+size: )\d+/, `$1${swapped.sha512}$2${swapped.size}`)
    );
    await expect(verifyLocalMacArtifacts({ root })).rejects.toThrow(/refusing Markie-0\.10\.0-arm64\.zip/);
    // And at the upload itself, whatever the verifier said.
    expect(() => guardMacUpload("mac", [zip], { root })).toThrow(/never published/);
    const rustZip = path.join(root, "rust-release/0.10.0/Markie-0.10.0-arm64.zip");
    expect(() => guardMacUpload("mac", [rustZip], { root })).not.toThrow();
    expect(() => guardMacUpload("mac-intel", [rustZip], { root })).toThrow(/refusing/);
    await expect(publishEarly("mac", "0.10.0")).rejects.toThrow(/refusing|smoke-tested/);
    expect(world.uploads).toHaveLength(0);
  });

  it("takes both feeds off early access on rollback, mac/ first", async () => {
    start();
    await prepareCutover(root, { mode: "joint", version: "0.10.0" });
    await publishEarly("mac", "0.10.0");
    await rollbackEarly("0.10.0");
    // No earlier early feed: mac/ follows stable again; mac-intel/ has nothing
    // earlier to return to and keeps the withdrawn build for early users.
    expect(world.version("mac/beta-mac.yml")).toBe("0.9.7");
    expect(world.version("mac-intel/beta-mac.yml")).toBe("0.10.0");
    await expect(promoteRelease("0.10.0", { force: true })).rejects.toThrow(/withdrawn/);
  });
});
