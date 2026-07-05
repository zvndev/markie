import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// public.ts opens a sqlite handle at import - point it at a throwaway file first.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "markie-pub-")), "t.db");
const {
  downloadPlatforms,
  findDownloadPlatform,
  parseDmgName,
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
        status: "planned",
        artifactPattern: "Markie-*-x64.dmg",
      },
      {
        id: "windows-x64",
        label: "Windows x64",
        route: "/download/windows",
        status: "planned",
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
  assert.equal(findDownloadPlatform("/download/windows")?.status, "planned");
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

test("planned download routes render an honest unavailable page", async () => {
  const res = await publicShare.request("/download/windows");
  const body = await res.text();

  assert.equal(res.status, 404);
  assert.match(body, /Windows x64 Is Not Published Yet/);
  assert.match(body, /current public build remains macOS Apple Silicon/i);
});
