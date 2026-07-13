import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertVersion,
  assertEvidenceMatchesArtifacts,
  compareVersions,
  parseElectronBuilderFeed,
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

  it("updates every app-owned version file through one command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "markie-release-version-"));
    mkdirSync(path.join(root, "mcp"));
    writeFileSync(path.join(root, "package.json"), '{"version":"0.2.9"}\n');
    writeFileSync(
      path.join(root, "package-lock.json"),
      '{"version":"0.2.9","packages":{"":{"version":"0.2.9"}}}\n'
    );
    writeFileSync(path.join(root, "mcp/package.json"), '{"version":"0.2.9"}\n');

    setReleaseVersion("0.2.10", root);

    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe("0.2.10");
    expect(JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"))).toMatchObject({
      version: "0.2.10",
      packages: { "": { version: "0.2.10" } },
    });
    expect(JSON.parse(readFileSync(path.join(root, "mcp/package.json"), "utf8")).version).toBe("0.2.10");
  });

  it("rejects non-release versions", () => {
    expect(() => assertVersion("0.2")).toThrow(/invalid release version/);
    expect(() => assertVersion("v0.2.10")).toThrow(/invalid release version/);
  });

  it("requires a release to be newer than the public feed", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.10", "0.2.10")).toBe(0);
    expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
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
