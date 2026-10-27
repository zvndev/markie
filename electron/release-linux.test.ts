// The Linux leg of the release pipeline, end to end, against a fake bucket and
// a fake website, the same way release-early.test.ts covers macOS and
// Windows. Nothing here reaches Backblaze, GitHub, or git.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  earlyTarget,
  expectedLinuxArtifacts,
  linuxAwaitsFirstRelease,
  promoteRelease,
  publishEarly,
  releasedReadyRoutes,
  rollbackEarly,
  setReleaseIo,
  verifyLocalLinuxArtifacts,
  verifyLocalMacArtifacts,
} from "../scripts/release.mjs";
import {
  REQUIRED_LINUX_CHECKS,
  buildLinuxEvidence,
  formatSha512Sums,
  linuxChecksumFile,
  linuxEvidenceFile,
  parseSha512Sums,
  verifyLinuxEvidence,
} from "../scripts/linux-build-evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "server/download-manifest.json"), "utf8"));
const PUBLIC = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
const SITE = manifest.siteUrl.replace(/\/+$/, "");
const COMMIT = "1111111111111111111111111111111111111111";
const OTHER_COMMIT = "2222222222222222222222222222222222222222";
const T0 = new Date("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;

const sha = (data: Buffer | string) => createHash("sha512").update(data).digest("base64");

interface FileRecord {
  name: string;
  size: number;
  sha512: string;
}

function feedYaml(version: string, files: FileRecord[]) {
  return (
    `version: ${version}\nfiles:\n` +
    files.map((f) => `  - url: ${f.name}\n    sha512: ${f.sha512}\n    size: ${f.size}`).join("\n") +
    `\npath: ${files[0].name}\nsha512: ${files[0].sha512}\nreleaseDate: '2026-10-28T00:00:00.000Z'\n`
  );
}

const macNames = (v: string) => [
  `Markie-${v}-arm64.zip`,
  `Markie-${v}-x64.zip`,
  `Markie-${v}-arm64.dmg`,
  `Markie-${v}-x64.dmg`,
];

/** What the Linux release workflow uploads to the linux-built tag. */
function ciLinuxBuild(dist: string, version: string, { commit = COMMIT, salt = "a" } = {}) {
  mkdirSync(dist, { recursive: true });
  const files = expectedLinuxArtifacts(version).map((name: string) => {
    const body = Buffer.from(`linux:${name}:${salt}`);
    writeFileSync(path.join(dist, name), body);
    return { name, size: body.length, sha512: sha(body) };
  });
  writeFileSync(path.join(dist, "latest-linux.yml"), feedYaml(version, files));
  const evidence = buildLinuxEvidence({
    dist,
    version,
    commit,
    runUrl: "https://github.com/zvndev/markie/actions/runs/1",
    checks: REQUIRED_LINUX_CHECKS,
    builtAt: T0.toISOString(),
  });
  writeFileSync(path.join(dist, linuxEvidenceFile(version)), JSON.stringify(evidence));
  writeFileSync(path.join(dist, linuxChecksumFile(version)), formatSha512Sums(evidence.files));
  return files;
}

/** What release:prepare:linux (and prepare:mac, for the mixed case) leave behind. */
function prepare(
  root: string,
  version: string,
  { commit = COMMIT, buildCommit = commit, salt = "a" }: { commit?: string; buildCommit?: string; salt?: string } = {}
) {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  const distLinux = path.join(root, "dist-linux");
  rmSync(distLinux, { recursive: true, force: true });
  const linux = ciLinuxBuild(distLinux, version, { commit: buildCommit, salt });
  const evidence = path.join(root, ".release", version);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, "local-linux.json"), JSON.stringify({ version, commit, files: linux }));

  const dist = path.join(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const mac = macNames(version).map((name) => {
    const body = Buffer.from(`artifact:${name}:${salt}`);
    const blockmap = Buffer.from(`blockmap:${name}:${salt}`);
    writeFileSync(path.join(dist, name), body);
    writeFileSync(path.join(dist, `${name}.blockmap`), blockmap);
    return {
      name,
      size: body.length,
      sha512: sha(body),
      blockmap: `${name}.blockmap`,
      blockmapSize: blockmap.length,
      blockmapSha512: sha(blockmap),
    };
  });
  writeFileSync(path.join(dist, "latest-mac.yml"), feedYaml(version, mac));
  writeFileSync(path.join(evidence, "local.json"), JSON.stringify({ version, commit, files: mac }));
  return { linux, mac };
}

/** A bucket plus the parts of markiedocs.com that read it. */
function makeWorld() {
  const objects = new Map<string, Buffer>();
  const uploads: { platform: string; name: string; version: string }[] = [];
  const state = { serverKnowsLinux: true };
  const dirFor = (platform: string) => ({ win: "windows", linux: "linux" })[platform] ?? "mac";
  const put = (key: string, data: string | Buffer) => objects.set(`${PUBLIC}/${key}`, Buffer.from(data));
  const text = (key: string) => objects.get(`${PUBLIC}/${key}`)?.toString("utf8") ?? null;
  const feedVersion = (key: string) => text(key)?.match(/^version:\s*(\S+)/m)?.[1] ?? null;

  const publish = (platform: string, files: string[], version: string) => {
    for (const file of files) {
      put(`${dirFor(platform)}/${path.basename(file)}`, readFileSync(file));
      uploads.push({ platform, name: path.basename(file), version });
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
    const macVersion = feedVersion("mac/latest-mac.yml");
    const linuxVersion = feedVersion("linux/latest-linux.yml");
    const artifact = (dir: string, name: string) => `${PUBLIC}/${dir}/${encodeURIComponent(name)}`;
    const linuxIds = ["linux-x64", "linux-x64-deb"];
    if (url === `${SITE}/download/latest.json`) {
      return Response.json({
        schemaVersion: 2,
        channel: "stable",
        version: macVersion,
        downloadPageUrl: `${SITE}/download`,
        platforms: [
          {
            id: "mac-arm64",
            downloadUrl: `${SITE}/download/mac`,
            artifactUrl: artifact("mac", `Markie-${macVersion}-arm64.dmg`),
          },
          { id: "mac-x64", downloadUrl: `${SITE}/download/mac-intel` },
          { id: "windows-x64", downloadUrl: `${SITE}/download/windows` },
          ...(state.serverKnowsLinux && linuxVersion
            ? [
                { id: "linux-x64", downloadUrl: `${SITE}/download/linux` },
                { id: "linux-x64-deb", downloadUrl: `${SITE}/download/linux-deb` },
              ]
            : []),
        ],
        // An older server has never heard of this field.
        ...(state.serverKnowsLinux ? { awaitingFirstRelease: linuxVersion ? [] : linuxIds } : {}),
      });
    }
    if (url === `${SITE}/download`) {
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    }
    const routes: Record<string, string> = {
      [`${SITE}/download/mac`]: artifact("mac", `Markie-${macVersion}-arm64.dmg`),
      [`${SITE}/download/mac-intel`]: artifact("mac", `Markie-${macVersion}-x64.dmg`),
      [`${SITE}/download/windows`]: artifact("windows", "Markie-0.8.0-x64.exe"),
    };
    if (state.serverKnowsLinux && linuxVersion) {
      routes[`${SITE}/download/linux`] = artifact("linux", `Markie-${linuxVersion}-x86_64.AppImage`);
      routes[`${SITE}/download/linux-deb`] = artifact("linux", `Markie-${linuxVersion}-amd64.deb`);
    }
    if (routes[url]) return new Response(null, { status: 302, headers: { location: routes[url] } });
    if (url.startsWith(`${SITE}/download/`)) return new Response("coming soon", { status: 404 });
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  };

  return { objects, uploads, state, put, text, feedVersion, publish, fetch: fetchImpl as typeof fetch };
}

/** Production today: macOS and Windows have stable feeds, Linux has none. */
function seedStable(world: ReturnType<typeof makeWorld>, version = "0.9.1") {
  const mac = macNames(version).map((name) => ({ name, size: 1, sha512: "old" }));
  world.put("mac/latest-mac.yml", feedYaml(version, mac));
  world.put("windows/latest.yml", feedYaml(version, [{ name: `Markie-${version}-x64.exe`, size: 1, sha512: "old" }]));
}

let root: string;
let world: ReturnType<typeof makeWorld>;
let clock: Date;
let logs: string[];
let restoreIo: () => void;
let previousFetch: typeof fetch;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "markie-linux-release-"));
  world = makeWorld();
  seedStable(world);
  clock = new Date(T0);
  logs = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = world.fetch;
  restoreIo = setReleaseIo({
    root,
    now: () => new Date(clock),
    pollDelayMs: 0,
    releaseGitState: () => COMMIT,
    promoteGitState: () => {},
    publishCredentials: () => {},
    verifyLocal: async (platform: string, { commit }: { commit?: string } = {}) =>
      platform === "linux" ? verifyLocalLinuxArtifacts({ root, commit }) : verifyLocalMacArtifacts({ root }),
    publish: world.publish,
    log: (line: string) => void logs.push(line),
  });
});

afterEach(() => {
  restoreIo();
  globalThis.fetch = previousFetch;
  rmSync(root, { recursive: true, force: true });
});

const earlyState = (version: string) =>
  JSON.parse(readFileSync(path.join(root, ".release", version, "early.json"), "utf8"));

describe("Linux build evidence", () => {
  it("records the commit, the checks and every package's SHA-512, unsigned by design", () => {
    const dist = path.join(root, "ci");
    const files = ciLinuxBuild(dist, "0.9.2");
    const evidence = JSON.parse(readFileSync(path.join(dist, linuxEvidenceFile("0.9.2")), "utf8"));
    expect(evidence).toMatchObject({ version: "0.9.2", commit: COMMIT, signing: "unsigned-by-design", files });
    expect(evidence.checks).toEqual(REQUIRED_LINUX_CHECKS);
    // sha512sum's own format, so a user can run `sha512sum -c` on it.
    const sums = parseSha512Sums(readFileSync(path.join(dist, linuxChecksumFile("0.9.2")), "utf8"));
    expect(sums.get("Markie-0.9.2-x86_64.AppImage")).toBe(Buffer.from(files[0].sha512, "base64").toString("hex"));
    expect(verifyLinuxEvidence({ dist, version: "0.9.2", commit: COMMIT, files })).toMatchObject({ commit: COMMIT });
  });

  it("refuses a build that skipped a check, or whose feed does not match the packages", () => {
    const dist = path.join(root, "ci");
    ciLinuxBuild(dist, "0.9.2");
    expect(() =>
      buildLinuxEvidence({ dist, version: "0.9.2", commit: COMMIT, checks: ["package-smoke"] })
    ).toThrow(/did not pass: xvfb-launch-smoke-unpacked/);
    writeFileSync(path.join(dist, "Markie-0.9.2-amd64.deb"), "swapped after the feed was written");
    expect(() => buildLinuxEvidence({ dist, version: "0.9.2", commit: COMMIT, checks: REQUIRED_LINUX_CHECKS })).toThrow(
      /amd64\.deb is \d+ bytes/
    );
  });

  it("refuses a build of another commit, and checksums that disagree", () => {
    const dist = path.join(root, "ci");
    const files = ciLinuxBuild(dist, "0.9.2");
    expect(() => verifyLinuxEvidence({ dist, version: "0.9.2", commit: OTHER_COMMIT, files })).toThrow(
      /not the release commit/
    );
    writeFileSync(path.join(dist, linuxChecksumFile("0.9.2")), `${"0".repeat(128)}  Markie-0.9.2-x86_64.AppImage\n`);
    expect(() => verifyLinuxEvidence({ dist, version: "0.9.2", commit: COMMIT, files })).toThrow(/disagrees/);
  });
});

describe("earlyTarget for Linux", () => {
  it("puts beta-linux.yml beside latest-linux.yml and allows a first release while Linux is ready", () => {
    const linux = earlyTarget("linux");
    expect([linux.stableFeedFile, linux.earlyFeedFile]).toEqual(["latest-linux.yml", "beta-linux.yml"]);
    expect(linux.artifactBaseUrl).toBe(`${PUBLIC}/linux`);
    expect(linux.localEvidenceFile).toBe("local-linux.json");
    expect(linux.allowsFirstRelease).toBe(true);
    expect(linuxAwaitsFirstRelease()).toBe(true);
    // macOS and Windows never may.
    expect(earlyTarget("mac").allowsFirstRelease).toBe(false);
    expect(earlyTarget("win").allowsFirstRelease).toBe(false);
  });

  it("stops allowing a missing stable feed once Linux is public", () => {
    const published = {
      ...manifest,
      platforms: manifest.platforms.map((entry: { id: string }) =>
        entry.id === "linux-x64" ? { ...entry, status: "public" } : entry
      ),
    };
    expect(earlyTarget("linux", published).allowsFirstRelease).toBe(false);
  });
});

describe("the first Linux release", () => {
  it("publishes early with no stable Linux feed yet, packages first and the early feed last", async () => {
    prepare(root, "0.9.2");
    const state = await publishEarly("linux", "0.9.2");

    expect(world.feedVersion("linux/beta-linux.yml")).toBe("0.9.2");
    expect(world.text("linux/latest-linux.yml")).toBeNull();
    expect(world.uploads.map((u) => u.name)).toEqual([
      "Markie-0.9.2-x86_64.AppImage",
      "Markie-0.9.2-amd64.deb",
      "beta-linux.yml",
    ]);
    // Same bytes as CI built, by SHA-512.
    expect(world.objects.get(`${PUBLIC}/linux/Markie-0.9.2-amd64.deb`)).toEqual(
      readFileSync(path.join(root, "dist-linux/Markie-0.9.2-amd64.deb"))
    );
    expect(state.platforms.linux).toMatchObject({
      previousStableVersion: null,
      previousEarlyVersion: null,
      signing: "unsigned-by-design",
    });
  });

  it("refuses a CI build of a different commit than the one being released", async () => {
    prepare(root, "0.9.2", { buildCommit: OTHER_COMMIT });
    await expect(publishEarly("linux", "0.9.2")).rejects.toThrow(/not the release commit/);
    expect(world.uploads).toHaveLength(0);
  });

  it("refuses packages that changed after prepare", async () => {
    prepare(root, "0.9.2");
    writeFileSync(path.join(root, "dist-linux/Markie-0.9.2-x86_64.AppImage"), "tampered");
    await expect(publishEarly("linux", "0.9.2")).rejects.toThrow(/size|SHA-512/);
    expect(world.uploads).toHaveLength(0);
  });

  it("will not promote until the deployed server knows Linux, then goes live with the same bytes", async () => {
    prepare(root, "0.9.2");
    await publishEarly("linux", "0.9.2");
    world.state.serverKnowsLinux = false;
    await expect(promoteRelease("0.9.2", { force: true })).rejects.toThrow(/deploy the server/);
    expect(world.text("linux/latest-linux.yml")).toBeNull();

    world.state.serverKnowsLinux = true;
    const before = world.uploads.length;
    await promoteRelease("0.9.2", { force: true });
    expect(world.uploads.slice(before)).toEqual([{ platform: "linux", name: "latest-linux.yml", version: "0.9.2" }]);
    expect(world.text("linux/latest-linux.yml")).toBe(world.text("linux/beta-linux.yml"));
    // Nothing was stable before, so there is nothing to save for a rollback.
    expect(existsSync(path.join(root, ".release/0.9.2/previous-latest-linux.yml"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, ".release/0.9.2/public-linux.json"), "utf8"))).toMatchObject({
      platform: "linux",
      promotedFrom: "early",
      signing: "unsigned-by-design",
    });
    expect(earlyState("0.9.2").promotedAt).toBe(T0.toISOString());
  });

  it("promotes Linux with macOS on one soak clock, and the website contract then covers Linux", async () => {
    prepare(root, "0.9.2");
    await publishEarly("mac", "0.9.2");
    await publishEarly("linux", "0.9.2");
    clock = new Date(T0.getTime() + 3 * DAY + 1);
    const before = world.uploads.length;
    await promoteRelease("0.9.2");
    expect(world.uploads.slice(before).map((u) => `${u.platform}/${u.name}`)).toEqual([
      "linux/latest-linux.yml",
      "mac/latest-mac.yml",
    ]);
    expect((await releasedReadyRoutes()).map((route: { id: string }) => route.id)).toEqual([
      "linux-x64",
      "linux-x64-deb",
    ]);
  });

  it("leaves Linux out of the website contract while it has no stable feed", async () => {
    expect(await releasedReadyRoutes()).toEqual([]);
  });

  it("withdraws a first early release without pretending there is something to go back to", async () => {
    prepare(root, "0.9.2");
    await publishEarly("linux", "0.9.2");
    const state = await rollbackEarly("0.9.2");
    expect(state.withdrawnAt).toBe(T0.toISOString());
    expect(world.feedVersion("linux/beta-linux.yml")).toBe("0.9.2");
    expect(logs.join("\n")).toMatch(/no earlier release to return to/);
    await expect(promoteRelease("0.9.2", { force: true })).rejects.toThrow(/withdrawn/);
  });
});

describe("the second Linux release", () => {
  it("must be newer than stable, and saves the stable feed it replaces", async () => {
    prepare(root, "0.9.2");
    await publishEarly("linux", "0.9.2");
    await promoteRelease("0.9.2", { force: true });

    prepare(root, "0.9.2", { salt: "b" });
    await expect(publishEarly("linux", "0.9.2")).rejects.toThrow(/already stable|must be newer/);

    prepare(root, "0.9.3", { salt: "c" });
    await publishEarly("linux", "0.9.3");
    await promoteRelease("0.9.3", { force: true });
    expect(world.feedVersion("linux/latest-linux.yml")).toBe("0.9.3");
    expect(readFileSync(path.join(root, ".release/0.9.3/previous-latest-linux.yml"), "utf8")).toMatch(
      /version: 0\.9\.2/
    );
  });
});
