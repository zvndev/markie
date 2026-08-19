import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertVersion,
  macFeedFile,
  releaseChannel,
  assertEvidenceMatchesArtifacts,
  compareVersions,
  parseElectronBuilderFeed,
  notarytoolSubmitPlan,
  refreshMacFeedIntegrity,
  releaseUrls,
  setReleaseVersion,
  unsafeUntrackedFiles,
  waitForWebsiteVersion,
} from "../scripts/release.mjs";

const SAMPLE_FEED = `version: 0.2.10
files:
  - url: Markie-0.2.10-arm64.zip
    sha512: arm-hash==
    size: 123
  - url: Markie-0.2.10-x64.dmg
    sha512: intel-hash==
    size: 456
path: Markie-0.2.10-arm64.zip
sha512: arm-hash==
`;

describe("release workflow", () => {
  it("parses the generated updater feed without a second YAML dependency", () => {
    expect(parseElectronBuilderFeed(SAMPLE_FEED)).toEqual({
      version: "0.2.10",
      files: [
        { url: "Markie-0.2.10-arm64.zip", sha512: "arm-hash==", size: 123 },
        { url: "Markie-0.2.10-x64.dmg", sha512: "intel-hash==", size: 456 },
      ],
    });
  });

  it("derives public release URLs from the canonical manifest", () => {
    expect(
      releaseUrls({
        schemaVersion: 2,
        channel: "stable",
        siteUrl: "https://markie.example.com",
        latestManifestRoute: "/download/latest.json",
        storage: {
          provider: "s3",
          bucket: "markie-releases",
          endpoint: "https://s3.example.com",
          region: "test",
          publicBaseUrl: "https://cdn.example.com/markie-releases",
        },
        primaryPlatformId: "mac-arm64",
        platforms: [
          {
            id: "mac-arm64",
            route: "/download/mac",
            status: "public",
            feed: { path: "stable/mac/latest-mac.yml" },
          },
        ],
      })
    ).toEqual({
      feedUrl: "https://cdn.example.com/markie-releases/stable/mac/latest-mac.yml",
      artifactBaseUrl: "https://cdn.example.com/markie-releases/stable/mac",
      downloadPageUrl: "https://markie.example.com/download",
      downloadUrl: "https://markie.example.com/download/mac",
      latestJsonUrl: "https://markie.example.com/download/latest.json",
    });
  });

  it("points a beta release at its own feed, beside stable in the same bucket", () => {
    const manifest = {
      schemaVersion: 2,
      channel: "stable",
      siteUrl: "https://markie.example.com",
      latestManifestRoute: "/download/latest.json",
      storage: {
        provider: "s3",
        bucket: "markie-releases",
        endpoint: "https://s3.example.com",
        region: "test",
        publicBaseUrl: "https://cdn.example.com/markie-releases",
      },
      primaryPlatformId: "mac-arm64",
      platforms: [
        {
          id: "mac-arm64",
          route: "/download/mac",
          status: "public",
          feed: { path: "stable/mac/latest-mac.yml" },
        },
      ],
    };

    const beta = releaseUrls(manifest, "0.5.0-beta.1");
    expect(beta.feedUrl).toBe(
      "https://cdn.example.com/markie-releases/stable/mac/beta-mac.yml"
    );
    // Same directory, so artifacts and bucket are shared and there is no second
    // manifest entry to drift.
    expect(beta.artifactBaseUrl).toBe("https://cdn.example.com/markie-releases/stable/mac");
    // And the public, human-facing routes stay pointed at stable: a beta is
    // never something the website can offer.
    expect(beta.downloadUrl).toBe("https://markie.example.com/download/mac");
    expect(releaseUrls(manifest, "0.5.0").feedUrl).toBe(
      "https://cdn.example.com/markie-releases/stable/mac/latest-mac.yml"
    );
  });

  it("updates every app-owned version file through one command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "markie-release-version-"));
    mkdirSync(path.join(root, "mcp/.claude-plugin"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"version":"0.2.9"}\n');
    writeFileSync(
      path.join(root, "package-lock.json"),
      '{"version":"0.2.9","packages":{"":{"version":"0.2.9"}}}\n'
    );
    writeFileSync(path.join(root, "mcp/package.json"), '{"version":"0.2.9"}\n');
    // the Claude Code plugin manifest is user-visible on install and drifted
    // to a stale version once, so it must move with the release too
    writeFileSync(
      path.join(root, "mcp/.claude-plugin/plugin.json"),
      '{"name":"markie","version":"0.2.9"}\n'
    );

    setReleaseVersion("0.2.10", root);

    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe("0.2.10");
    expect(JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"))).toMatchObject({
      version: "0.2.10",
      packages: { "": { version: "0.2.10" } },
    });
    expect(JSON.parse(readFileSync(path.join(root, "mcp/package.json"), "utf8")).version).toBe("0.2.10");
    expect(
      JSON.parse(readFileSync(path.join(root, "mcp/.claude-plugin/plugin.json"), "utf8")).version
    ).toBe("0.2.10");
  });

  it("bumps every version file to a beta prerelease too", () => {
    // release:version is the only supported way to move versions, so a beta
    // that it refuses is a beta that cannot be cut at all.
    const root = mkdtempSync(path.join(tmpdir(), "markie-release-beta-"));
    mkdirSync(path.join(root, "mcp/.claude-plugin"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"version":"0.4.0"}\n');
    writeFileSync(
      path.join(root, "package-lock.json"),
      '{"version":"0.4.0","packages":{"":{"version":"0.4.0"}}}\n'
    );
    writeFileSync(path.join(root, "mcp/package.json"), '{"version":"0.4.0"}\n');
    writeFileSync(
      path.join(root, "mcp/.claude-plugin/plugin.json"),
      '{"name":"markie","version":"0.4.0"}\n'
    );

    setReleaseVersion("0.5.0-beta.1", root);

    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(
      "0.5.0-beta.1"
    );
    expect(
      JSON.parse(readFileSync(path.join(root, "mcp/.claude-plugin/plugin.json"), "utf8")).version
    ).toBe("0.5.0-beta.1");
  });

  it("rejects non-release versions", () => {
    expect(() => assertVersion("0.2")).toThrow(/invalid release version/);
    expect(() => assertVersion("v0.2.10")).toThrow(/invalid release version/);
  });

  it("accepts a beta prerelease but not arbitrary prerelease tags", () => {
    // Only the tag the beta channel actually publishes is a release version.
    // Anything else would silently pick a feed name nothing writes to.
    expect(assertVersion("0.5.0-beta.1")).toBe("0.5.0-beta.1");
    expect(() => assertVersion("0.5.0-alpha.1")).toThrow(/invalid release version/);
    expect(() => assertVersion("0.5.0-beta")).toThrow(/invalid release version/);
    expect(() => assertVersion("0.5.0-beta.1.2")).toThrow(/invalid release version/);
  });

  it("routes each version to its own channel and feed file", () => {
    expect(releaseChannel("0.5.0")).toBe("latest");
    expect(releaseChannel("0.5.0-beta.1")).toBe("beta");
    expect(macFeedFile("0.5.0")).toBe("latest-mac.yml");
    expect(macFeedFile("0.5.0-beta.1")).toBe("beta-mac.yml");
  });

  it("never lets a beta publish resolve to the stable feed file", () => {
    // The entire safety property of the beta channel is that publishing one
    // cannot rewrite the feed every stable user follows.
    expect(macFeedFile("0.5.0-beta.1")).not.toBe(macFeedFile("0.5.0"));
  });

  it("orders a beta below the release it leads to", () => {
    // 0.5.0-beta.1 must not read as newer than 0.5.0, or shipping stable after
    // a beta would look like a downgrade and be refused.
    expect(compareVersions("0.5.0", "0.5.0-beta.1")).toBe(1);
    expect(compareVersions("0.5.0-beta.1", "0.5.0")).toBe(-1);
    expect(compareVersions("0.5.0-beta.2", "0.5.0-beta.1")).toBe(1);
    expect(compareVersions("0.5.0-beta.1", "0.5.0-beta.1")).toBe(0);
    expect(compareVersions("0.5.0-beta.1", "0.4.0")).toBe(1);
  });

  it("requires a release to be newer than the public feed", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.10", "0.2.10")).toBe(0);
    expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
  });

  it("keeps notarization credentials out of release logs", () => {
    const plan = notarytoolSubmitPlan("/tmp/Markie.dmg", {
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "top-secret",
      APPLE_TEAM_ID: "TEAM123",
    });

    expect(plan.args).toContain("top-secret");
    expect(plan.displayArgs.join(" ")).not.toContain("release@example.com");
    expect(plan.displayArgs.join(" ")).not.toContain("top-secret");
    expect(plan.displayArgs.join(" ")).not.toContain("TEAM123");
  });

  it("refreshes updater sizes and hashes after DMG stapling", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "markie-release-feed-"));
    const dist = path.join(root, "dist");
    mkdirSync(dist);
    const names = [
      "Markie-0.2.10-arm64.zip",
      "Markie-0.2.10-x64.zip",
      "Markie-0.2.10-arm64.dmg",
      "Markie-0.2.10-x64.dmg",
    ];
    for (const name of names) writeFileSync(path.join(dist, name), `artifact:${name}`);
    writeFileSync(
      path.join(dist, "latest-mac.yml"),
      `version: 0.2.10\nfiles:\n${names
        .map((name) => `  - url: ${name}\n    sha512: stale\n    size: 1`)
        .join("\n")}\npath: Markie-0.2.10-arm64.zip\nsha512: stale\n`
    );

    await refreshMacFeedIntegrity("0.2.10", root);

    const feedText = readFileSync(path.join(dist, "latest-mac.yml"), "utf8");
    const feed = parseElectronBuilderFeed(feedText);
    expect(feed.files).toHaveLength(4);
    for (const entry of feed.files) {
      expect(entry.size).toBe(Buffer.byteLength(`artifact:${entry.url}`));
      expect(entry.sha512).not.toBe("stale");
    }
    const legacySha = feedText.match(/^sha512:\s*(.+)$/m)?.[1];
    expect(legacySha).toBe(feed.files.find((entry) => entry.url.endsWith("arm64.zip"))?.sha512);
  });

  it("rejects untracked build inputs while allowing non-packaged audit evidence", () => {
    expect(
      unsafeUntrackedFiles(
        ".autoloop/runs/release-check/evidence.json\nelectron/uncommitted.js\nserver/new-route.ts\n"
      )
    ).toEqual(["electron/uncommitted.js", "server/new-route.ts"]);
  });

  it("waits for the stable website cache to converge after publish or rollback", async () => {
    const previousFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: calls === 1 ? "0.2.10" : "0.2.9" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      await waitForWebsiteVersion("0.2.9", 2, 0);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("binds publication to the exact smoke-tested artifacts and blockmaps", () => {
    const files = [
      {
        name: "Markie-0.2.10-arm64.zip",
        size: 100,
        sha512: "artifact-hash",
        blockmap: "Markie-0.2.10-arm64.zip.blockmap",
        blockmapSize: 10,
        blockmapSha512: "blockmap-hash",
      },
    ];
    expect(() => assertEvidenceMatchesArtifacts(files, files)).not.toThrow();
    expect(() =>
      assertEvidenceMatchesArtifacts(files, [{ ...files[0], blockmapSha512: "replaced" }])
    ).toThrow(/do not match the smoke-tested/);
  });
});
