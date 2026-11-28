// The Mac cutover handoff check, minus the parts that need a Rust build, a
// signed app and a window. Every fixture is made up.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertHarnessPackage,
  assertSafeAppPath,
  assertSafeSourceApp,
  buildLocalFeed,
  findIntelZip,
  startFeedServer,
} from "./lib/handoff-harness.mjs";
import { updaterChoice } from "./lib/mac-cutover.mjs";

const require = createRequire(import.meta.url);
const sha = (body: string) => createHash("sha512").update(body).digest("base64");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "markie-handoff-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rustFolder(version: string) {
  const rust = path.join(dir, "rust", version);
  mkdirSync(rust, { recursive: true });
  const files = [`Markie-${version}-arm64.zip`, `Markie-${version}-arm64.dmg`].map((name) => {
    const body = `rust:${name}`;
    writeFileSync(path.join(rust, name), body);
    return { name, size: body.length, sha512: sha(body) };
  });
  writeFileSync(path.join(rust, "release.json"), JSON.stringify({ version, gitCommit: "4".repeat(40), files }));
  return rust;
}

function intelFolder(...versions: string[]) {
  const intel = path.join(dir, "intel");
  mkdirSync(intel, { recursive: true });
  for (const version of versions) writeFileSync(path.join(intel, `Markie-${version}-x64.zip`), `electron-x64:${version}`);
  return intel;
}

describe("where the handoff check may run", () => {
  it("runs only a copy inside its own work folder", () => {
    const work = path.join(dir, "work");
    mkdirSync(path.join(work, "Applications", "Markie.app"), { recursive: true });
    expect(assertSafeAppPath(path.join(work, "Applications", "Markie.app"), { workDir: work, home: path.join(dir, "home") })).toMatch(
      /work\/Applications\/Markie\.app$/
    );
    expect(() => assertSafeAppPath(path.join(dir, "elsewhere", "Markie.app"), { workDir: work })).toThrow(/must be a copy inside/);
    expect(() => assertSafeAppPath(work, { workDir: work })).toThrow(/must be a copy inside/);
  });

  it("refuses Kirby's installed Markie, as the app under test or as the source", () => {
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, "Applications", "Markie.app", "Contents"), { recursive: true });
    writeFileSync(path.join(home, "Applications", "Markie.app", "Contents", "Info.plist"), "<plist/>");
    expect(() => assertSafeAppPath("/Applications/Markie.app", { workDir: dir })).toThrow(/installed Markie is never the app under test/);
    expect(() => assertSafeAppPath(path.join(home, "Applications", "Markie.app"), { workDir: dir, home })).toThrow(/installed Markie/);
    expect(() => assertSafeSourceApp("/Applications/Markie.app")).toThrow(/not from an installed Markie/);
    expect(() => assertSafeSourceApp(path.join(home, "Applications", "Markie.app"), { home })).toThrow(/not from an installed Markie/);

    const built = path.join(dir, "dist-harness", "mac-arm64", "Markie.app");
    mkdirSync(path.join(built, "Contents"), { recursive: true });
    writeFileSync(path.join(built, "Contents", "Info.plist"), "<plist/>");
    expect(assertSafeSourceApp(built, { home })).toMatch(/dist-harness\/mac-arm64\/Markie\.app$/);
  });

  it("updates only from a harness build of the expected version", () => {
    expect(() => assertHarnessPackage(JSON.stringify({ version: "0.9.7" }), "0.9.7")).toThrow(/not an update-harness build/);
    expect(() => assertHarnessPackage(JSON.stringify({ version: "0.9.6", markieUpdateHarness: true }), "0.9.7")).toThrow(/expected 0\.9\.7/);
    expect(assertHarnessPackage(JSON.stringify({ version: "0.9.7", markieUpdateHarness: true }), "0.9.7").version).toBe("0.9.7");
  });

  it("builds the 0.9.7 it updates from with the marker and no public feed", () => {
    const previous = process.env.MARKIE_HARNESS_FROM_VERSION;
    delete process.env.MARKIE_HARNESS_FROM_VERSION;
    const configPath = require.resolve("../electron-builder.update-harness.cjs");
    delete require.cache[configPath];
    const config = require(configPath);
    if (previous !== undefined) process.env.MARKIE_HARNESS_FROM_VERSION = previous;
    expect(config.extraMetadata).toEqual({ version: "0.9.7", markieUpdateHarness: true });
    expect(config.publish).toBeNull();
    expect(config.mac.publish).toBeNull();
    expect(config.mac.notarize).toBe(false);
    expect(config.mac.target).toEqual([{ target: "dir", arch: ["arm64"] }]);
    expect(config.directories.output).toBe("dist-harness");
    // The public config never carries the marker.
    expect(require("../electron-builder.config.cjs").extraMetadata).toBeUndefined();
  });
});

describe("the local feed", () => {
  it("is what mac/ will hold: the Rust rc for arm64, an Electron x64 ZIP as the bridge", async () => {
    const feed = await buildLocalFeed({
      rustDir: rustFolder("0.10.0-rc.1"),
      intelDir: intelFolder("0.9.9", "0.10.0"),
      outDir: path.join(dir, "out"),
      cutoverVersion: "0.10.0",
    });
    expect(feed.version).toBe("0.10.0-rc.1");
    // The newest x64 ZIP in the folder is the bridge.
    expect(feed.intelZip.name).toBe("Markie-0.10.0-x64.zip");
    // An installed Electron 0.9.7 on Apple Silicon is offered the rc and takes
    // the Rust ZIP; on Intel it would take the bridge.
    expect(updaterChoice(feed.feedText, { arm64Mac: true, currentVersion: "0.9.7" })).toMatchObject({
      offered: true,
      file: "Markie-0.10.0-rc.1-arm64.zip",
    });
    expect(updaterChoice(feed.feedText, { arm64Mac: false, currentVersion: "0.9.7" }).file).toBe("Markie-0.10.0-x64.zip");
  });

  it("refuses an Intel build that does not read mac-intel/ as the bridge", async () => {
    await expect(
      buildLocalFeed({ rustDir: rustFolder("0.10.0-rc.1"), intelDir: intelFolder("0.9.7"), outDir: path.join(dir, "out"), cutoverVersion: "0.10.0" })
    ).rejects.toThrow(/older than the cutover/);
    await expect(findIntelZip(path.join(dir, "rust"))).rejects.toThrow(/no Markie-<version>-x64\.zip/);
  });

  it("is served on the loopback interface only, inside its folder, with ranges", async () => {
    const feed = await buildLocalFeed({
      rustDir: rustFolder("0.10.0-rc.1"),
      intelDir: intelFolder("0.10.0"),
      outDir: path.join(dir, "out"),
      cutoverVersion: "0.10.0",
    });
    const server = await startFeedServer({ root: path.join(dir, "out") });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await (await fetch(`${server.url}/mac/latest-mac.yml`)).text()).toBe(feed.feedText);
      const zip = await fetch(`${server.url}/mac/Markie-0.10.0-rc.1-arm64.zip`, { headers: { range: "bytes=0-3" } });
      expect(zip.status).toBe(206);
      expect(await zip.text()).toBe("rust");
      expect((await fetch(`${server.url}/mac/Markie-0.10.0-rc.1-arm64.zip`, { method: "HEAD" })).headers.get("content-length")).toBe(
        String("rust:Markie-0.10.0-rc.1-arm64.zip".length)
      );
      expect((await fetch(`${server.url}/mac/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
      expect((await fetch(`${server.url}/nothing-here`)).status).toBe(404);
      expect(server.requests.map((r) => r.path)).toContain("/mac/Markie-0.10.0-rc.1-arm64.zip");
    } finally {
      await server.close();
    }
  });
});
