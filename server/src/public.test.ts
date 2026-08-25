import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// public.ts opens a sqlite handle at import - point it at a throwaway file first.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pub-")), "t.db");
const {
  downloadPlatforms,
  feedForPlatform,
  findDownloadPlatform,
  markieSiteUrl,
  parseArtifactName,
  parseDmgName,
  parseFeedVersion,
  primaryDownloadCta,
} = await import("./downloads.ts");
const { clearDownloadCacheForTests, publicShare } = await import("./public.ts");

const SAMPLE_YML = `version: 0.2.3
files:
  - url: Markie-0.2.3-arm64-mac.zip
    sha512: abc==
    size: 200709891
  - url: Markie-0.2.3-arm64.dmg
    sha512: def==
    size: 209341444
path: Markie-0.2.3-arm64-mac.zip
sha512: abc==
releaseDate: '2026-06-15T00:00:00.000Z'
`;

// What electron-builder actually writes for a dual-architecture mac release:
// both arches live in one latest-mac.yml, and each platform has to pick its own
// artifact out of it.
const WINDOWS_YML = `version: 0.4.0
files:
  - url: Markie-0.4.0-x64.exe
    sha512: eee==
    size: 118341444
  - url: Markie-0.4.0-x64.zip
    sha512: fff==
    size: 117709891
path: Markie-0.4.0-x64.exe
sha512: eee==
releaseDate: '2026-08-15T00:00:00.000Z'
`;

// The manifest gives macOS and Windows separate feed files, so a stub that
// answers every URL with the same body tests a world that does not exist.
const feedFor = async (input: RequestInfo | URL) =>
  new Response(String(input).includes("/windows/") ? WINDOWS_YML : DUAL_ARCH_YML, { status: 200 });

const DUAL_ARCH_YML = `version: 0.4.0
files:
  - url: Markie-0.4.0-arm64-mac.zip
    sha512: aaa==
    size: 200709891
  - url: Markie-0.4.0-arm64.dmg
    sha512: bbb==
    size: 209341444
  - url: Markie-0.4.0-mac.zip
    sha512: ccc==
    size: 210709891
  - url: Markie-0.4.0-x64.dmg
    sha512: ddd==
    size: 219341444
path: Markie-0.4.0-arm64-mac.zip
sha512: aaa==
releaseDate: '2026-08-15T00:00:00.000Z'
`;

test("parseDmgName pulls the .dmg filename from latest-mac.yml", () => {
  assert.equal(parseDmgName(SAMPLE_YML), "Markie-0.2.3-arm64.dmg");
});

test("parseDmgName works across version bumps", () => {
  assert.equal(
    parseDmgName("  - url: Markie-1.4.0-arm64.dmg\n"),
    "Markie-1.4.0-arm64.dmg"
  );
});

test("parseDmgName returns null when no dmg is present", () => {
  assert.equal(parseDmgName("files:\n  - url: Markie-0.2.3-arm64-mac.zip\n"), null);
});

test("each mac platform picks its own artifact out of one dual-arch feed", () => {
  const arm = findDownloadPlatform("mac-arm64");
  const intel = findDownloadPlatform("mac-x64");
  assert(arm);
  assert(intel);
  // One latest-mac.yml lists four artifacts; the x64 pattern must not match the
  // arm64 dmg, and vice versa.
  assert.equal(parseArtifactName(DUAL_ARCH_YML, arm), "Markie-0.4.0-arm64.dmg");
  assert.equal(parseArtifactName(DUAL_ARCH_YML, intel), "Markie-0.4.0-x64.dmg");
  assert.equal(parseFeedVersion(DUAL_ARCH_YML), "0.4.0");
});

test("the Intel pattern finds nothing in an arm64-only feed", () => {
  const intel = findDownloadPlatform("mac-x64");
  assert(intel);
  assert.equal(parseArtifactName(SAMPLE_YML, intel), null);
});

test("parseFeedVersion reads the stable feed version", () => {
  assert.equal(parseFeedVersion(SAMPLE_YML), "0.2.3");
  assert.equal(parseFeedVersion("files: []\n"), null);
});

test("production site URLs cannot drift from the stable release manifest", () => {
  assert.equal(markieSiteUrl(undefined, "production"), "https://markie.zvndev.com");
  assert.equal(markieSiteUrl("https://markie.test/", "test"), "https://markie.test");
  assert.throws(
    () => markieSiteUrl("https://stale.example.com", "production"),
    /must match the stable release manifest/
  );
});

test("production download feeds cannot drift from the stable release manifest", () => {
  const platform = findDownloadPlatform("mac-arm64");
  assert(platform);
  assert.throws(
    () => feedForPlatform(platform, "https://stale.example.com/mac", "production"),
    /cannot override the stable release manifest/
  );
  assert.equal(
    feedForPlatform(platform, "https://markie.test/mac", "test")?.url,
    "https://markie.test/mac/latest-mac.yml"
  );
});

test("download manifest covers public and planned desktop targets", () => {
  const platforms = downloadPlatforms();
  assert.deepEqual(
    platforms.map((platform) => platform.id),
    ["mac-arm64", "mac-x64", "windows-x64", "linux-x64"]
  );
  assert.deepEqual(
    platforms.map((platform) => ({
      id: platform.id,
      label: platform.label,
      route: platform.route,
      status: platform.status,
      artifactPattern: platform.artifactPattern,
    })),
    [
      {
        id: "mac-arm64",
        label: "macOS Apple Silicon",
        route: "/download/mac",
        status: "public",
        artifactPattern: "Markie-*-arm64.dmg",
      },
      {
        id: "mac-x64",
        label: "macOS Intel",
        route: "/download/mac-intel",
        status: "public",
        artifactPattern: "Markie-*-x64.dmg",
      },
      {
        id: "windows-x64",
        label: "Windows x64",
        route: "/download/windows",
        status: "public",
        artifactPattern: "Markie-*-x64.exe",
      },
      {
        id: "linux-x64",
        label: "Linux x64",
        route: "/download/linux",
        status: "planned",
        artifactPattern: "Markie-*-x64.AppImage",
      },
    ]
  );
  assert.equal(findDownloadPlatform("/download/windows")?.status, "public");
  assert.equal(findDownloadPlatform("/download/linux")?.status, "planned");
  assert.deepEqual(primaryDownloadCta(), {
    href: "/download/mac",
    label: "Get Markie for macOS",
    platform: findDownloadPlatform("mac-arm64"),
  });
});

test("published download route redirects to the manifest artifact", async (t) => {
  const previousFetch = globalThis.fetch;
  clearDownloadCacheForTests();
  t.after(() => {
    globalThis.fetch = previousFetch;
    clearDownloadCacheForTests();
  });
  globalThis.fetch = async () => new Response(SAMPLE_YML, { status: 200 });

  const res = await publicShare.request("/download/mac");

  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.2.3-arm64.dmg"
  );
});

test("latest release JSON is a stable machine-readable source for sites and emails", async (t) => {
  const previousFetch = globalThis.fetch;
  clearDownloadCacheForTests();
  t.after(() => {
    globalThis.fetch = previousFetch;
    clearDownloadCacheForTests();
  });
  globalThis.fetch = feedFor as typeof fetch;

  const res = await publicShare.request("/download/latest.json");
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(body, {
    schemaVersion: 2,
    channel: "stable",
    version: "0.4.0",
    primaryPlatformId: "mac-arm64",
    downloadPageUrl: "https://markie.zvndev.com/download",
    platforms: [
      {
        id: "mac-arm64",
        label: "macOS Apple Silicon",
        os: "macos",
        arch: "arm64",
        version: "0.4.0",
        downloadUrl: "https://markie.zvndev.com/download/mac",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.4.0-arm64.dmg",
      },
      {
        id: "mac-x64",
        label: "macOS Intel",
        os: "macos",
        arch: "x64",
        version: "0.4.0",
        downloadUrl: "https://markie.zvndev.com/download/mac-intel",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.4.0-x64.dmg",
      },
      {
        id: "windows-x64",
        label: "Windows x64",
        os: "windows",
        arch: "x64",
        version: "0.4.0",
        downloadUrl: "https://markie.zvndev.com/download/windows",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/windows/Markie-0.4.0-x64.exe",
      },
    ],
  });
});

test("latest human download route stays versionless", async () => {
  const res = await publicShare.request("/download/latest");
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "/download/mac");
});

test("planned download routes render an honest unavailable page", async () => {
  // Linux, now that Windows ships. The page has to keep refusing to pretend a
  // platform is ready, which is the whole reason the manifest carries a status.
  const res = await publicShare.request("/download/linux");
  const body = await res.text();

  assert.equal(res.status, 404);
  assert.match(body, /Linux x64 Is Not Published Yet/);
  assert.match(body, /current public build remains macOS Apple Silicon/i);
});

test("the Intel download route redirects to the x64 artifact", async (t) => {
  const previousFetch = globalThis.fetch;
  clearDownloadCacheForTests();
  t.after(() => {
    globalThis.fetch = previousFetch;
    clearDownloadCacheForTests();
  });
  globalThis.fetch = feedFor as typeof fetch;

  const res = await publicShare.request("/download/mac-intel");
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("location"),
    "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.4.0-x64.dmg"
  );
});
