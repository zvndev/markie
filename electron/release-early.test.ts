// The three-stage release pipeline, end to end, against a fake bucket and a
// fake website. Nothing here reaches Backblaze, Railway, Apple, or git: fetch
// is replaced for the duration of each test, uploads land in a Map, and the
// clock is a variable.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  earlyTarget,
  holdRelease,
  mirrorStableToEarly,
  promoteDue,
  promoteRelease,
  publishEarly,
  rollbackEarly,
  setReleaseIo,
  verifyLocalMacArtifacts,
} from "../scripts/release.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "server/download-manifest.json"), "utf8"));
const PUBLIC = manifest.storage.publicBaseUrl.replace(/\/+$/, "");
const SITE = manifest.siteUrl.replace(/\/+$/, "");
const COMMIT = "1111111111111111111111111111111111111111";
const T0 = new Date("2026-10-20T12:00:00.000Z");
const DAY = 86_400_000;

const sha = (data: Buffer | string) => createHash("sha512").update(data).digest("base64");

interface FileRecord {
  name: string;
  size: number;
  sha512: string;
  blockmap?: string;
  blockmapSize?: number;
  blockmapSha512?: string;
}

function feedYaml(version: string, files: FileRecord[]) {
  return (
    `version: ${version}\nfiles:\n` +
    files.map((f) => `  - url: ${f.name}\n    sha512: ${f.sha512}\n    size: ${f.size}`).join("\n") +
    `\npath: ${files[0].name}\nsha512: ${files[0].sha512}\nreleaseDate: '2026-10-20T00:00:00.000Z'\n`
  );
}

function writeArtifacts(dir: string, names: string[], salt: string): FileRecord[] {
  mkdirSync(dir, { recursive: true });
  return names.map((name) => {
    const body = Buffer.from(`artifact:${name}:${salt}`);
    const blockmapBody = Buffer.from(`blockmap:${name}:${salt}`);
    writeFileSync(path.join(dir, name), body);
    writeFileSync(path.join(dir, `${name}.blockmap`), blockmapBody);
    return {
      name,
      size: body.length,
      sha512: sha(body),
      blockmap: `${name}.blockmap`,
      blockmapSize: blockmapBody.length,
      blockmapSha512: sha(blockmapBody),
    };
  });
}

const macNames = (v: string) => [
  `Markie-${v}-arm64.zip`,
  `Markie-${v}-x64.zip`,
  `Markie-${v}-arm64.dmg`,
  `Markie-${v}-x64.dmg`,
];
const winNames = (v: string) => [`Markie-${v}-x64.exe`];

/** What release:prepare:mac and release:prepare:win leave behind, minus the signing. */
function prepare(root: string, version: string, { commit = COMMIT, salt = "a" } = {}) {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  const dist = path.join(root, "dist");
  rmSync(dist, { recursive: true, force: true });
  const mac = writeArtifacts(dist, macNames(version), salt);
  writeFileSync(path.join(dist, "latest-mac.yml"), feedYaml(version, mac));
  const distWin = path.join(root, "dist-windows");
  rmSync(distWin, { recursive: true, force: true });
  const win = writeArtifacts(distWin, winNames(version), salt);
  writeFileSync(path.join(distWin, "latest.yml"), feedYaml(version, win));
  const evidence = path.join(root, ".release", version);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(path.join(evidence, "local.json"), JSON.stringify({ version, commit, files: mac }));
  writeFileSync(
    path.join(evidence, "local-windows.json"),
    JSON.stringify({ version, commit, files: win, signerSubject: "CN=ZVN DEV LLC" })
  );
  return { mac, win };
}

/** A bucket plus the parts of markiedocs.com that read it. */
function makeWorld() {
  const objects = new Map<string, Buffer>();
  const uploads: { platform: string; name: string; version: string }[] = [];
  let fetchCount = 0;
  const dirFor = (platform: string) => (platform === "win" ? "windows" : "mac");
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
    fetchCount += 1;
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
    const winVersion = feedVersion("windows/latest.yml");
    const artifact = (dir: string, name: string) => `${PUBLIC}/${dir}/${encodeURIComponent(name)}`;
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
        ],
      });
    }
    if (url === `${SITE}/download`) {
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    }
    const routes: Record<string, string> = {
      [`${SITE}/download/mac`]: artifact("mac", `Markie-${macVersion}-arm64.dmg`),
      [`${SITE}/download/mac-intel`]: artifact("mac", `Markie-${macVersion}-x64.dmg`),
      [`${SITE}/download/windows`]: artifact("windows", `Markie-${winVersion}-x64.exe`),
    };
    if (routes[url]) return new Response(null, { status: 302, headers: { location: routes[url] } });
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  };

  return {
    objects,
    uploads,
    put,
    text,
    feedVersion,
    publish,
    fetch: fetchImpl as typeof fetch,
    get fetchCount() {
      return fetchCount;
    },
  };
}

/** A previous stable release already in the bucket, as production has today. */
function seedStable(world: ReturnType<typeof makeWorld>, version = "0.8.0") {
  const mac = macNames(version).map((name) => ({ name, size: 1, sha512: "old" }));
  world.put("mac/latest-mac.yml", feedYaml(version, mac));
  const win = winNames(version).map((name) => ({ name, size: 1, sha512: "old" }));
  world.put("windows/latest.yml", feedYaml(version, win));
}

let root: string;
let world: ReturnType<typeof makeWorld>;
let clock: Date;
let logs: string[];
let gitChecks: string[];
let restoreIo: () => void;
let previousFetch: typeof fetch;

function hashDir(dir: string, names: string[]): FileRecord[] {
  return names.map((name) => {
    const body = readFileSync(path.join(dir, name));
    const blockmap = readFileSync(path.join(dir, `${name}.blockmap`));
    return {
      name,
      size: body.length,
      sha512: sha(body),
      blockmap: `${name}.blockmap`,
      blockmapSize: blockmap.length,
      blockmapSha512: sha(blockmap),
    };
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "markie-early-"));
  world = makeWorld();
  seedStable(world);
  clock = new Date(T0);
  logs = [];
  gitChecks = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = world.fetch;
  restoreIo = setReleaseIo({
    root,
    now: () => new Date(clock),
    pollDelayMs: 0,
    releaseGitState: () => COMMIT,
    promoteGitState: (commit: string) => void gitChecks.push(commit),
    publishCredentials: () => {},
    verifyLocal: async (platform: string) => {
      const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
      if (platform === "mac") return verifyLocalMacArtifacts({ root });
      const dist = path.join(root, "dist-windows");
      return {
        version,
        feedPath: path.join(dist, "latest.yml"),
        feedName: "latest.yml",
        signerSubject: "CN=ZVN DEV LLC",
        files: hashDir(dist, winNames(version)),
      };
    },
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

describe("publish --early", () => {
  it("uploads the build and writes only the early feed", async () => {
    prepare(root, "0.9.0");
    const state = await publishEarly("mac", "0.9.0");

    expect(world.feedVersion("mac/beta-mac.yml")).toBe("0.9.0");
    // Stable, and so the website and latest.json, are untouched.
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");
    // The early feed is byte-for-byte the feed electron-builder wrote for the
    // stable-numbered build, which is what makes it promotable unchanged.
    expect(world.text("mac/beta-mac.yml")).toBe(readFileSync(path.join(root, "dist/latest-mac.yml"), "utf8"));
    // The feed is the last thing uploaded.
    expect(world.uploads.at(-1)).toMatchObject({ name: "beta-mac.yml" });
    expect(world.uploads.filter((u) => u.name.endsWith(".yml"))).toHaveLength(1);

    expect(state).toMatchObject({
      version: "0.9.0",
      commit: COMMIT,
      soakDays: 3,
      publishedAt: T0.toISOString(),
      soakUntil: new Date(T0.getTime() + 3 * DAY).toISOString(),
      held: false,
      promotedAt: null,
    });
    expect(state.platforms.mac.files).toHaveLength(4);
    expect(state.platforms.mac.previousEarlyVersion).toBeNull();
    expect(earlyState("0.9.0")).toEqual(state);
  });

  it("takes a soak override", async () => {
    prepare(root, "0.9.0");
    const state = await publishEarly("mac", "0.9.0", { soakDays: "0.5" });
    expect(state.soakUntil).toBe(new Date(T0.getTime() + DAY / 2).toISOString());
  });

  it("saves the previous early feed, including a legacy beta, for rollback", async () => {
    world.put("mac/beta-mac.yml", feedYaml("0.9.0-beta.2", [{ name: "x", size: 1, sha512: "y" }]));
    prepare(root, "0.9.0");
    const state = await publishEarly("mac", "0.9.0");
    expect(state.platforms.mac.previousEarlyVersion).toBe("0.9.0-beta.2");
    expect(readFileSync(path.join(root, ".release/0.9.0/previous-beta-mac.yml"), "utf8")).toMatch(
      /0\.9\.0-beta\.2/
    );
  });

  it("refuses without the exact confirmation, for a prerelease, or when not newer than stable", async () => {
    prepare(root, "0.9.0");
    await expect(publishEarly("mac", "0.9.1")).rejects.toThrow(/--confirm-public-release=0\.9\.0/);
    prepare(root, "0.9.0-beta.1");
    await expect(publishEarly("mac", "0.9.0-beta.1")).rejects.toThrow(/prerelease/);
    prepare(root, "0.8.0");
    await expect(publishEarly("mac", "0.8.0")).rejects.toThrow(/must be newer than the stable/);
    expect(world.uploads).toHaveLength(0);
  });

  it("refuses artifacts that are not the smoke-tested evidence", async () => {
    prepare(root, "0.9.0");
    writeFileSync(path.join(root, "dist/Markie-0.9.0-arm64.zip.blockmap"), "swapped");
    await expect(publishEarly("mac", "0.9.0")).rejects.toThrow(/do not match the smoke-tested/);
    expect(world.uploads).toHaveLength(0);
  });

  it("covers Windows through the same path, writing windows/beta.yml", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    clock = new Date(T0.getTime() + DAY);
    const state = await publishEarly("win", "0.9.0");
    expect(world.feedVersion("windows/beta.yml")).toBe("0.9.0");
    expect(world.feedVersion("windows/latest.yml")).toBe("0.8.0");
    // The later platform restarts the shared clock.
    expect(state.soakUntil).toBe(new Date(T0.getTime() + 4 * DAY).toISOString());
    expect(Object.keys(state.platforms).sort()).toEqual(["mac", "win"]);
  });
});

describe("promote", () => {
  it("refuses during the soak, then promotes the same bytes with --now", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    await expect(promoteRelease("0.9.0")).rejects.toThrow(/soaking until/);
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");

    const uploadsBefore = world.uploads.length;
    await promoteRelease("0.9.0", { force: true });
    expect(world.text("mac/latest-mac.yml")).toBe(world.text("mac/beta-mac.yml"));
    // Promotion uploads exactly one object, the stable feed: nothing rebuilt
    // or re-uploaded.
    expect(world.uploads.slice(uploadsBefore)).toEqual([
      { platform: "mac", name: "latest-mac.yml", version: "0.9.0" },
    ]);
    expect(gitChecks).toEqual([COMMIT]);
    const state = earlyState("0.9.0");
    expect(state.promotedAt).toBe(T0.toISOString());
    expect(readFileSync(path.join(root, ".release/0.9.0/previous-latest-mac.yml"), "utf8")).toMatch(
      /version: 0\.8\.0/
    );
    expect(JSON.parse(readFileSync(path.join(root, ".release/0.9.0/public.json"), "utf8"))).toMatchObject({
      version: "0.9.0",
      promotedFrom: "early",
    });
    await expect(promoteRelease("0.9.0", { force: true })).rejects.toThrow(/already promoted/);
  });

  it("requires the confirmation flag", async () => {
    await expect(promoteRelease(undefined)).rejects.toThrow(/--confirm-promote/);
  });

  it("refuses a held release even with --now", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    holdRelease("0.9.0", true, { reason: "crash on launch" });
    clock = new Date(T0.getTime() + 10 * DAY);
    await expect(promoteRelease("0.9.0", { force: true })).rejects.toThrow(/held \(crash on launch\)/);
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");
  });

  it("re-verifies every artifact and writes no stable feed when one changed in the bucket", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    world.put("mac/Markie-0.9.0-x64.dmg", "tampered");
    await expect(promoteRelease("0.9.0", { force: true })).rejects.toThrow(/size|SHA-512/);
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");
    expect(earlyState("0.9.0").promotedAt).toBeNull();
  });

  it("refuses and records it when the early feed no longer names the version", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    world.put("mac/beta-mac.yml", feedYaml("0.9.1", [{ name: "z", size: 1, sha512: "z" }]));
    await expect(promoteRelease("0.9.0", { force: true })).rejects.toThrow(/names 0\.9\.1, not 0\.9\.0/);
    expect(earlyState("0.9.0")).toMatchObject({ supersededBy: "0.9.1" });
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");
  });

  it("promotes Windows and macOS together, stable feeds after every artifact check", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    await publishEarly("win", "0.9.0");
    clock = new Date(T0.getTime() + 3 * DAY);
    const before = world.uploads.length;
    await promoteRelease("0.9.0");
    expect(world.uploads.slice(before).map((u) => `${u.platform}/${u.name}`)).toEqual([
      "mac/latest-mac.yml",
      "win/latest.yml",
    ]);
    expect(world.text("windows/latest.yml")).toBe(world.text("windows/beta.yml"));
    expect(existsSync(path.join(root, ".release/0.9.0/previous-latest.yml"))).toBe(true);
    expect(existsSync(path.join(root, ".release/0.9.0/public-windows.json"))).toBe(true);
  });

  it("finishes a promotion that stopped after one stable feed was written", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    await publishEarly("win", "0.9.0");
    // As if an earlier run wrote the macOS stable feed and then died.
    world.put("mac/latest-mac.yml", world.text("mac/beta-mac.yml") ?? "");
    const before = world.uploads.length;
    await promoteRelease("0.9.0", { force: true });
    expect(world.uploads.slice(before).map((u) => u.name)).toEqual(["latest.yml"]);
  });
});

describe("promote-due", () => {
  it("does nothing, quietly and offline, when nothing is due", async () => {
    const result = await promoteDue();
    expect(result).toEqual({ line: "nothing pending", failed: false });
    expect(logs).toEqual(["[release] promote-due: nothing pending"]);
    expect(world.fetchCount).toBe(0);
    expect(readFileSync(path.join(root, ".release/promote-due.log"), "utf8")).toBe(
      `${T0.toISOString()} nothing pending\n`
    );
  });

  it("waits out the soak, promotes once, and is a no-op after", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    logs = [];
    const fetchesBefore = world.fetchCount;

    clock = new Date(T0.getTime() + 2 * DAY);
    expect((await promoteDue()).line).toMatch(/^0\.9\.0 soaking until .* \(24h left\)$/);
    expect(world.fetchCount).toBe(fetchesBefore);

    clock = new Date(T0.getTime() + 3 * DAY + 1);
    expect((await promoteDue()).line).toBe("promoted 0.9.0");
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.9.0");

    clock = new Date(T0.getTime() + 4 * DAY);
    const uploads = world.uploads.length;
    expect((await promoteDue()).line).toBe("nothing pending");
    expect(world.uploads.length).toBe(uploads);
  });

  it("respects a hold until it is lifted", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    holdRelease("0.9.0", true, { reason: "waiting on a fix" });
    clock = new Date(T0.getTime() + 5 * DAY);
    expect((await promoteDue()).line).toBe("0.9.0 held (waiting on a fix)");
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");
    holdRelease("0.9.0", false);
    expect((await promoteDue()).line).toBe("promoted 0.9.0");
  });

  it("restarts the clock when a newer early release replaces the old one", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    clock = new Date(T0.getTime() + 2 * DAY);
    prepare(root, "0.9.1", { salt: "b" });
    await publishEarly("mac", "0.9.1");

    clock = new Date(T0.getTime() + 3.5 * DAY);
    const line = (await promoteDue()).line;
    expect(line).toMatch(/^0\.9\.1 soaking until/);
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.8.0");

    clock = new Date(T0.getTime() + 5 * DAY);
    expect((await promoteDue()).line).toBe("promoted 0.9.1");
    expect(world.feedVersion("mac/latest-mac.yml")).toBe("0.9.1");
  });

  it("stops retrying a release whose early feed was replaced behind its back", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    world.put("mac/beta-mac.yml", feedYaml("0.9.2", [{ name: "z", size: 1, sha512: "z" }]));
    clock = new Date(T0.getTime() + 4 * DAY);
    const first = await promoteDue();
    expect(first.failed).toBe(false);
    expect(first.line).toMatch(/^0\.9\.0 superseded/);
    expect((await promoteDue()).line).toBe("nothing pending");
  });

  it("retries rather than retiring a release when the early feed is briefly missing", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    const feed = world.text("mac/beta-mac.yml") ?? "";
    world.objects.delete(`${PUBLIC}/mac/beta-mac.yml`);
    clock = new Date(T0.getTime() + 4 * DAY);
    const first = await promoteDue();
    expect(first.failed).toBe(true);
    expect(first.line).toMatch(/early macOS feed is missing/);
    expect(earlyState("0.9.0").supersededAt).toBeNull();
    world.put("mac/beta-mac.yml", feed);
    expect((await promoteDue()).line).toBe("promoted 0.9.0");
  });

  it("reports a real failure with a non-zero result", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    world.put("mac/Markie-0.9.0-arm64.dmg", "tampered");
    clock = new Date(T0.getTime() + 4 * DAY);
    const result = await promoteDue();
    expect(result.failed).toBe(true);
    expect(result.line).toMatch(/^0\.9\.0 promotion failed:/);
  });
});

describe("rollback-early", () => {
  it("restores the previous early feed and blocks promotion", async () => {
    world.put("mac/beta-mac.yml", feedYaml("0.8.5", [{ name: "p", size: 1, sha512: "p" }]));
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    await rollbackEarly("0.9.0");
    expect(world.feedVersion("mac/beta-mac.yml")).toBe("0.8.5");
    expect(earlyState("0.9.0").withdrawnAt).toBe(T0.toISOString());
    clock = new Date(T0.getTime() + 9 * DAY);
    await expect(promoteRelease("0.9.0")).rejects.toThrow(/withdrawn/);
    expect((await promoteDue()).line).toBe("nothing pending");
  });

  it("points early users at current stable when there was no early feed before", async () => {
    prepare(root, "0.9.0");
    await publishEarly("win", "0.9.0");
    await rollbackEarly("0.9.0");
    expect(world.text("windows/beta.yml")).toBe(world.text("windows/latest.yml"));
  });

  it("refuses once the release is stable", async () => {
    prepare(root, "0.9.0");
    await publishEarly("mac", "0.9.0");
    await promoteRelease("0.9.0", { force: true });
    await expect(rollbackEarly("0.9.0")).rejects.toThrow(/already stable/);
  });
});

describe("mirrorStableToEarly", () => {
  it("brings a missing or older early feed up to a direct stable release", async () => {
    prepare(root, "0.9.0");
    const feed = path.join(root, "dist/latest-mac.yml");
    expect(await mirrorStableToEarly("mac", "0.9.0", feed)).toEqual({ mirrored: true });
    expect(world.text("mac/beta-mac.yml")).toBe(readFileSync(feed, "utf8"));
  });

  it("leaves a newer early build alone, and ignores prereleases", async () => {
    world.put("mac/beta-mac.yml", feedYaml("0.9.5", [{ name: "n", size: 1, sha512: "n" }]));
    prepare(root, "0.9.0");
    const feed = path.join(root, "dist/latest-mac.yml");
    expect((await mirrorStableToEarly("mac", "0.9.0", feed)).mirrored).toBe(false);
    expect((await mirrorStableToEarly("mac", "0.9.6-beta.1", feed)).mirrored).toBe(false);
    expect(world.feedVersion("mac/beta-mac.yml")).toBe("0.9.5");
  });
});

describe("earlyTarget", () => {
  it("keeps each early feed beside its stable feed, under the name the client asks for", () => {
    const mac = earlyTarget("mac");
    expect([mac.stableFeedFile, mac.earlyFeedFile]).toEqual(["latest-mac.yml", "beta-mac.yml"]);
    expect(mac.earlyFeedUrl).toBe(`${PUBLIC}/mac/beta-mac.yml`);
    const win = earlyTarget("win");
    expect([win.stableFeedFile, win.earlyFeedFile]).toEqual(["latest.yml", "beta.yml"]);
    expect(win.artifactBaseUrl).toBe(`${PUBLIC}/windows`);
  });

  it("refuses an early feed in a different directory from stable", () => {
    const moved = {
      ...manifest,
      betaChannel: { ...manifest.betaChannel, feed: { path: "beta/beta-mac.yml" } },
    };
    expect(() => earlyTarget("mac", moved)).toThrow(/must sit beside/);
  });
});
