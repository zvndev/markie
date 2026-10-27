import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { getMigrations } from "better-auth/db/migration";

// public.ts opens a sqlite handle at import - point it at a throwaway file
// first. ASSETS_DIR and the auth env vars are set here too, before docs.ts
// (which pulls in auth.ts and assets.ts) is imported below: not the site URL,
// which the download tests further down deliberately leave unset so they
// exercise the canonical-URL fallback.
const pubDir = mkdtempSync(join(tmpdir(), "markie-pub-"));
process.env.DB_PATH = join(pubDir, "t.db");
process.env.ASSETS_DIR = join(pubDir, "store");
process.env.BETTER_AUTH_URL = "http://localhost:8787";
process.env.BETTER_AUTH_SECRET = "markie-pub-test-secret-32-plus-chars";
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
const { auth } = await import("./auth.ts");
const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
if (toBeCreated.length > 0 || toBeAdded.length > 0) await runMigrations();
const { docs } = await import("./docs.ts");
const { shares } = await import("./shares.ts");
const { assetsApi } = await import("./assets.ts");
const { docLinksApi } = await import("./doc-links.ts");
const { signUpVerified } = await import("./test-users.ts");

// A second app, distinct from the bare `publicShare` the download tests use
// below: this one carries the doc/share/asset routes a cloud-assets test
// needs to set up a document, so it also answers /s/:token the same way the
// real server does.
const fullApp = new Hono();
fullApp.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
fullApp.route("/api/docs", docs);
fullApp.route("/api/docs", shares);
fullApp.route("/api", assetsApi);
fullApp.route("/api", docLinksApi);
fullApp.route("/", publicShare);

const H = (token?: string) => ({
  Origin: "http://localhost:3000",
  "x-forwarded-for": "127.0.0.1",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

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
  String(input).includes("/linux/")
    ? new Response("not found", { status: 404 })
    : new Response(String(input).includes("/windows/") ? WINDOWS_YML : DUAL_ARCH_YML, { status: 200 });

// What electron-builder writes for the Linux targets: one latest-linux.yml for
// both packages, AppImage first, the AppImage carrying its blockmap inside it.
const LINUX_YML = `version: 0.9.2
files:
  - url: Markie-0.9.2-x86_64.AppImage
    sha512: ggg==
    size: 131234567
    blockMapSize: 140000
  - url: Markie-0.9.2-amd64.deb
    sha512: hhh==
    size: 92345678
path: Markie-0.9.2-x86_64.AppImage
sha512: ggg==
releaseDate: '2026-10-28T00:00:00.000Z'
`;

// The bucket after the first stable Linux release: every feed answers.
const feedForWithLinux = async (input: RequestInfo | URL) =>
  String(input).includes("/linux/") ? new Response(LINUX_YML, { status: 200 }) : feedFor(input);

// A test that never stubs fetch must not reach Backblaze, which it now would
// for the ready Linux platform. Count the calls so a test can say "none".
const withFetch = (t: { after: (fn: () => void) => void }, impl: typeof feedFor) => {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  clearDownloadCacheForTests();
  t.after(() => {
    globalThis.fetch = previousFetch;
    clearDownloadCacheForTests();
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return impl(input);
  }) as typeof fetch;
  return calls;
};

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
  assert.equal(markieSiteUrl(undefined, "production"), "https://markiedocs.com");
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
    ["mac-arm64", "mac-x64", "windows-x64", "linux-x64", "linux-x64-deb"]
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
        status: "ready",
        artifactPattern: "Markie-*-x86_64.AppImage",
      },
      {
        id: "linux-x64-deb",
        label: "Debian and Ubuntu",
        route: "/download/linux-deb",
        status: "ready",
        artifactPattern: "Markie-*-amd64.deb",
      },
    ]
  );
  assert.equal(findDownloadPlatform("/download/windows")?.status, "public");
  // Ready, not public: the release flow publishes Linux, and the server offers
  // it once linux/latest-linux.yml exists. Nobody edits this file to ship it.
  assert.equal(findDownloadPlatform("/download/linux")?.status, "ready");
  assert.equal(findDownloadPlatform("linux-x64")?.feed?.path, "linux/latest-linux.yml");
  assert.equal(findDownloadPlatform("linux-x64-deb")?.feed?.path, "linux/latest-linux.yml");
  assert.deepEqual(primaryDownloadCta(), {
    href: "/download/mac",
    label: "Get Markie",
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
    downloadPageUrl: "https://markiedocs.com/download",
    platforms: [
      {
        id: "mac-arm64",
        label: "macOS Apple Silicon",
        os: "macos",
        arch: "arm64",
        version: "0.4.0",
        downloadUrl: "https://markiedocs.com/download/mac",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.4.0-arm64.dmg",
      },
      {
        id: "mac-x64",
        label: "macOS Intel",
        os: "macos",
        arch: "x64",
        version: "0.4.0",
        downloadUrl: "https://markiedocs.com/download/mac-intel",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/mac/Markie-0.4.0-x64.dmg",
      },
      {
        id: "windows-x64",
        label: "Windows x64",
        os: "windows",
        arch: "x64",
        version: "0.4.0",
        downloadUrl: "https://markiedocs.com/download/windows",
        artifactUrl:
          "https://f005.backblazeb2.com/file/markie-releases/windows/Markie-0.4.0-x64.exe",
      },
    ],
    // Linux is built and wired into the release flow but has no stable feed
    // yet, so it is not offered; the release runner reads this list to know
    // the deployed server will offer it once the feed lands.
    awaitingFirstRelease: ["linux-x64", "linux-x64-deb"],
  });
});

test("latest release JSON lists Linux once its first stable feed exists", async (t) => {
  withFetch(t, feedForWithLinux);
  const body = await (await publicShare.request("/download/latest.json")).json();
  const linux = body.platforms.filter((platform: { os: string }) => platform.os === "linux");
  assert.deepEqual(linux, [
    {
      id: "linux-x64",
      label: "Linux x64",
      os: "linux",
      arch: "x64",
      version: "0.9.2",
      downloadUrl: "https://markiedocs.com/download/linux",
      artifactUrl: "https://f005.backblazeb2.com/file/markie-releases/linux/Markie-0.9.2-x86_64.AppImage",
    },
    {
      id: "linux-x64-deb",
      label: "Debian and Ubuntu",
      os: "linux",
      arch: "x64",
      version: "0.9.2",
      downloadUrl: "https://markiedocs.com/download/linux-deb",
      artifactUrl: "https://f005.backblazeb2.com/file/markie-releases/linux/Markie-0.9.2-amd64.deb",
    },
  ]);
  assert.deepEqual(body.awaitingFirstRelease, []);
  // The website's own version stays the primary platform's.
  assert.equal(body.version, "0.4.0");
});

test("latest human download route stays versionless", async () => {
  const res = await publicShare.request("/download/latest");
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("location"), "/download/mac");
});

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

test("the user agent picks the platform: Windows and Mac", async (t) => {
  withFetch(t, feedForWithLinux);
  const go = async (ua: string) =>
    (await publicShare.request("/download/latest", { headers: { "User-Agent": ua } })).headers.get("location");
  assert.equal(await go(UA.windows), "/download/windows");
  assert.equal(await go(UA.mac), "/download/mac");
  const res = await publicShare.request("/download/latest", { headers: { "User-Agent": UA.windows } });
  assert.equal(res.headers.get("vary"), "User-Agent");
});

test("the user agent sends Linux visitors to the AppImage only once it is released", async (t) => {
  const go = async (ua: string) =>
    (await publicShare.request("/download/latest", { headers: { "User-Agent": ua } })).headers.get("location");

  withFetch(t, feedFor);
  assert.equal(await go(UA.linux), "/download/mac", "no Linux feed yet: the primary build, as before");

  clearDownloadCacheForTests();
  globalThis.fetch = feedForWithLinux as typeof fetch;
  assert.equal(await go(UA.linux), "/download/linux");
  // Neither package runs on these, whatever their user agent says.
  assert.equal(await go(UA.linuxArm), "/download/mac");
  assert.equal(await go(UA.android), "/download/mac");
  assert.equal(await go(UA.chromeos), "/download/mac");
});

test("a ready platform renders an honest unavailable page until its first release", async (t) => {
  withFetch(t, feedFor);
  const res = await publicShare.request("/download/linux");
  const body = await res.text();

  assert.equal(res.status, 404);
  assert.match(body, /Markie for Linux x64 is coming/i);
  assert.match(body, /Markie runs on macOS Apple Silicon today/i);
});

test("Linux routes redirect to their own package once the stable feed exists", async (t) => {
  withFetch(t, feedForWithLinux);
  const appImage = await publicShare.request("/download/linux");
  assert.equal(appImage.status, 302);
  assert.equal(
    appImage.headers.get("location"),
    "https://f005.backblazeb2.com/file/markie-releases/linux/Markie-0.9.2-x86_64.AppImage"
  );
  const deb = await publicShare.request("/download/linux-deb");
  assert.equal(deb.status, 302);
  assert.equal(
    deb.headers.get("location"),
    "https://f005.backblazeb2.com/file/markie-releases/linux/Markie-0.9.2-amd64.deb"
  );
});

test("the download page offers Linux once released, and not before", async (t) => {
  const card = (page: string, label: string) =>
    page.slice(
      page.lastIndexOf('<section class="platform-card">', page.indexOf(`<h2>${label}</h2>`)),
      page.indexOf("</section>", page.indexOf(`<h2>${label}</h2>`))
    );
  withFetch(t, feedFor);
  const before = await (await publicShare.request("/download")).text();
  assert.match(card(before, "Linux x64"), /Coming soon/);
  assert.doesNotMatch(card(before, "Linux x64"), /href="\/download\/linux"/);

  clearDownloadCacheForTests();
  globalThis.fetch = feedForWithLinux as typeof fetch;
  const after = await (await publicShare.request("/download")).text();
  assert.match(card(after, "Linux x64"), /href="\/download\/linux"/);
  assert.match(card(after, "Debian and Ubuntu"), /href="\/download\/linux-deb"/);
  assert.doesNotMatch(card(after, "Linux x64"), /Coming soon/);
});

test("a missing Linux feed is remembered briefly rather than fetched on every view", async (t) => {
  const calls = withFetch(t, feedFor);
  await publicShare.request("/download/linux");
  await publicShare.request("/download/linux");
  await publicShare.request("/download/linux-deb");
  assert.equal(calls.filter((url) => url.endsWith("/linux/latest-linux.yml")).length, 2);
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

test("the public page rewrites a linked asset's src through its own /s/ asset route", async () => {
  const owner = await signUpVerified(fullApp, { name: "Owner", email: "pub-cloud-asset@test.local" });
  const docId = crypto.randomUUID();
  const content = "![a](a.png)\n\n![b](b.png)\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const created = await fullApp.request(`/api/docs/${docId}`, {
    method: "PUT",
    headers: { ...H(owner.token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "pub.md", content, hash, baseVersion: 0 }),
  });
  assert.equal(created.status, 200);

  const png = Buffer.from("public-page-asset-bytes");
  const pngHash = createHash("sha256").update(png).digest("hex");
  const uploaded = await fullApp.request(`/api/assets/${pngHash}`, {
    method: "PUT",
    headers: { ...H(owner.token), "Content-Type": "image/png", "Content-Length": String(png.length) },
    body: new Blob([png]),
  });
  assert.equal(uploaded.status, 200);

  const linked = await fullApp.request(`/api/docs/${docId}/assets`, {
    method: "PUT",
    headers: { ...H(owner.token), "Content-Type": "application/json" },
    body: JSON.stringify({ refs: [{ ref: "a.png", hash: pngHash }] }),
  });
  assert.equal(linked.status, 200);

  const made = await fullApp.request(`/api/docs/${docId}/public-link`, {
    method: "POST",
    headers: { ...H(owner.token), "Content-Type": "application/json" },
  });
  assert.equal(made.status, 200);
  const { url } = (await made.json()) as { url: string };
  const token = url.split("/s/")[1];

  const res = await fullApp.request(`/s/${token}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // The URL carries the hash the ref points at, so relinking a.png to other
  // bytes changes the URL and the hour of freshness below cannot serve the
  // old picture from a browser cache.
  assert.match(body, new RegExp(`src="/s/${token}/assets\\?ref=a\\.png&#x26;v=${pngHash.slice(0, 16)}"`));
  // b.png was never linked, so it passes through as the document wrote it.
  assert.match(body, /src="b\.png"/);

  const asset = await fullApp.request(`/s/${token}/assets?ref=a.png&v=${pngHash.slice(0, 16)}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "private, max-age=3600");
  assert.equal(await asset.text(), "public-page-asset-bytes");
});

test("a document link on a public page resolves only to another public page", async () => {
  const owner = await signUpVerified(fullApp, { name: "Owner", email: `pl.owner.${Date.now()}@test.local` });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" };
  const sourceId = `pl-source-${Date.now()}`;
  const targetId = `pl-target-${Date.now()}`;
  const content = "# Source\n\n[the plan](plan.md)\n";
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  for (const [id, body] of [[sourceId, content], [targetId, "# Target\n"]] as const) {
    const r = await fullApp.request(`/api/docs/${id}`, { method: "PUT", headers, body: JSON.stringify({ name: `${id}.md`, content: body, hash: id === sourceId ? hash : createHash("sha256").update(body, "utf8").digest("hex"), baseVersion: 0 }) });
    assert.equal(r.status, 200);
  }
  assert.equal((await fullApp.request(`/api/docs/${sourceId}/links`, { method: "PUT", headers, body: JSON.stringify({ links: [{ ref: "plan.md", target: targetId }] }) })).status, 200);
  const made = await fullApp.request(`/api/docs/${sourceId}/public-link`, { method: "POST", headers });
  assert.equal(made.status, 200);
  const sourceToken = String(((await made.json()) as { url: string }).url).split("/s/")[1];

  let html = await (await fullApp.request(`/s/${sourceToken}`)).text();
  assert.match(html, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);
  assert.ok(!html.includes(targetId));

  const madeTarget = await fullApp.request(`/api/docs/${targetId}/public-link`, { method: "POST", headers });
  const targetToken = String(((await madeTarget.json()) as { url: string }).url).split("/s/")[1];
  html = await (await fullApp.request(`/s/${sourceToken}`)).text();
  assert.match(html, new RegExp(`<a href="/s/${targetToken}">the plan</a>`));

  assert.equal((await fullApp.request(`/api/docs/${targetId}/public-link`, { method: "DELETE", headers })).status, 200);
  html = await (await fullApp.request(`/s/${sourceToken}`)).text();
  assert.match(html, /<a class="doc-link-muted" title="This document isn(?:'|&#x27;)t shared with you\.">the plan<\/a>/);
});

test("a public page linking to another account's publicly shared document does not publish its token", async () => {
  const stamp = Date.now();
  const a = await signUpVerified(fullApp, { name: "A", email: `pl.a.${stamp}@test.local` });
  const b = await signUpVerified(fullApp, { name: "B", email: `pl.b.${stamp}@test.local` });
  const hdr = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://localhost:3000", "x-forwarded-for": "127.0.0.1" });
  const put = async (token: string, id: string, content: string) => {
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const r = await fullApp.request(`/api/docs/${id}`, { method: "PUT", headers: hdr(token), body: JSON.stringify({ name: `${id}.md`, content, hash, baseVersion: 0 }) });
    assert.equal(r.status, 200);
  };
  const publish = async (token: string, id: string) => {
    const r = await fullApp.request(`/api/docs/${id}/public-link`, { method: "POST", headers: hdr(token) });
    assert.equal(r.status, 200);
    return String(((await r.json()) as { url: string }).url).split("/s/")[1];
  };

  // B publishes a document; A learns its id (an id is not a secret).
  const bDoc = `pl-b-${stamp}`;
  await put(b.token, bDoc, "# B's page\n");
  const bToken = await publish(b.token, bDoc);

  // A points their own public page at it.
  const aDoc = `pl-a-${stamp}`;
  await put(a.token, aDoc, "# A\n\n[their page](theirs.md)\n");
  const linked = await fullApp.request(`/api/docs/${aDoc}/links`, { method: "PUT", headers: hdr(a.token), body: JSON.stringify({ links: [{ ref: "theirs.md", target: bDoc }] }) });
  assert.equal(linked.status, 200);
  const aToken = await publish(a.token, aDoc);

  const html = await (await fullApp.request(`/s/${aToken}`)).text();
  assert.ok(!html.includes(bToken), "A's public page must not carry B's public link token");
  assert.ok(!html.includes(bDoc));
  assert.match(html, /<a class="doc-link-muted"[^>]*>their page<\/a>/);
});
