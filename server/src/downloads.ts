import { readFileSync } from "node:fs";

// "public": offered, and every release gate checks it is.
// "ready": built and published by the release flow, offered the moment its
//   stable feed exists. This is how a new platform goes live: the promotion
//   that writes its first stable feed is the publish, with no manifest edit or
//   server deploy to time against the upload. Flip it to "public" after the
//   first stable release so a missing feed fails the gates instead of quietly
//   hiding the platform.
// "planned": not built. The route explains that and offers nothing.
export type DownloadStatus = "public" | "ready" | "planned";

export type DownloadFeed = {
  // electron-updater picks the feed file by platform: latest-mac.yml on macOS,
  // latest.yml on Windows. Naming the type is what keeps a manifest entry from
  // pointing a platform at the other one's feed, which resolves to a 404 that
  // only ever shows up as "no updates available".
  type: "electron-builder-mac-yml" | "electron-builder-win-yml" | "electron-builder-linux-yml";
  path: string;
};

export type ResolvedDownloadFeed = DownloadFeed & {
  url: string;
  artifactBaseUrl: string;
};

export type DownloadPlatform = {
  id: string;
  route: string;
  label: string;
  ctaLabel: string;
  os: "macos" | "windows" | "linux";
  arch: "arm64" | "x64";
  status: DownloadStatus;
  description: string;
  artifactPattern?: string;
  feed?: DownloadFeed;
  // Read only while `feed` does not exist yet (the bucket answers 404). The
  // Mac cutover moved Intel to its own feed, mac-intel/latest-mac.yml, which
  // the 0.10.0 promotion creates. Until then the Intel route keeps resolving
  // from the shared mac/ feed it always used, so the server can be deployed
  // ahead of the release without leaving the Intel download dead.
  fallbackFeed?: DownloadFeed;
  // Who is expected to have signed this platform's artifacts. It lives here so
  // the CI job that signs and the release runner that publishes read the same
  // string; when they each held their own copy, nothing would have noticed them
  // drifting apart except a user's SmartScreen warning.
  codeSigning?: { authority: string; subject: string };
};

export type DownloadManifest = {
  schemaVersion: number;
  channel: "stable";
  siteUrl: string;
  latestManifestRoute: string;
  storage: {
    provider: "s3";
    bucket: string;
    endpoint: string;
    region: string;
    publicBaseUrl: string;
  };
  primaryPlatformId: string;
  platforms: DownloadPlatform[];
  // Present once Apple Silicon Macs ship Markie RS (the Rust app) and Intel
  // Macs follow their own Electron feed. docs/RELEASING.md, "Mac cutover".
  // bundleId and teamId are what both apps are signed as, which is what lets
  // Squirrel accept Markie RS as an in-place update of Electron Markie.
  macCutover?: { version: string; arm64Source: "rust"; bundleId: string; teamId: string; note?: string };
};

export const DOWNLOAD_MANIFEST_URL = new URL("../download-manifest.json", import.meta.url);

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const stripLeadingSlash = (value: string) => value.replace(/^\/+/, "");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const loadManifest = (): DownloadManifest => {
  const manifest = JSON.parse(readFileSync(DOWNLOAD_MANIFEST_URL, "utf8")) as DownloadManifest;
  if (manifest.schemaVersion !== 2) throw new Error("download manifest schemaVersion must be 2");
  if (manifest.channel !== "stable") throw new Error("download manifest channel must be stable");
  if (!manifest.siteUrl.startsWith("https://")) throw new Error("download manifest siteUrl must use HTTPS");
  if (manifest.latestManifestRoute !== "/download/latest.json") {
    throw new Error("download manifest latest route must stay /download/latest.json");
  }
  if (!manifest.storage?.publicBaseUrl.startsWith("https://")) {
    throw new Error("download manifest storage needs a public HTTPS base URL");
  }
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) {
    throw new Error("download manifest must define at least one platform");
  }
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const platform of manifest.platforms) {
    if (!platform.id || ids.has(platform.id)) throw new Error(`invalid download platform id: ${platform.id}`);
    if (!platform.route.startsWith("/download/")) throw new Error(`invalid download route: ${platform.route}`);
    if (routes.has(platform.route)) throw new Error(`duplicate download route: ${platform.route}`);
    if (!platform.artifactPattern) {
      throw new Error(`download platform ${platform.id} needs an artifact pattern`);
    }
    if (!["public", "ready", "planned"].includes(platform.status)) {
      throw new Error(`download platform ${platform.id} has unknown status ${platform.status}`);
    }
    if ((platform.status === "public" || platform.status === "ready") && !platform.feed) {
      throw new Error(`${platform.status} download platform ${platform.id} needs a feed`);
    }
    for (const feed of [platform.feed, platform.fallbackFeed]) {
      if (feed?.path.startsWith("/") || feed?.path.includes("..")) {
        throw new Error(`invalid download feed path: ${feed.path}`);
      }
    }
    if (platform.fallbackFeed && platform.fallbackFeed.type !== platform.feed?.type) {
      throw new Error(`download platform ${platform.id} has a fallback feed of a different type`);
    }
    ids.add(platform.id);
    routes.add(platform.route);
  }
  if (!ids.has(manifest.primaryPlatformId)) {
    throw new Error(`primary download platform is missing: ${manifest.primaryPlatformId}`);
  }
  validateMacCutover(manifest);
  return manifest;
};

const feedDir = (feed?: DownloadFeed) => (feed ? feed.path.split("/").slice(0, -1).join("/") : null);

/**
 * The Mac cutover splits the two Mac platforms across two feed directories:
 * Apple Silicon reads mac/ (Markie RS), Intel reads mac-intel/ (Electron).
 * Exported for the tests; loadManifest runs it on the real file.
 */
export function validateMacCutover(manifest: Pick<DownloadManifest, "macCutover" | "platforms">) {
  const cutover = manifest.macCutover;
  if (!cutover) return;
  if (!/^\d+\.\d+\.\d+$/.test(cutover.version ?? "")) {
    throw new Error(`macCutover.version must be X.Y.Z: ${cutover.version}`);
  }
  if (cutover.arm64Source !== "rust") throw new Error("macCutover.arm64Source must be rust");
  if (!cutover.bundleId || !/^[A-Z0-9]{10}$/.test(cutover.teamId ?? "")) {
    throw new Error("macCutover needs the bundleId and the 10-character Apple teamId both apps are signed with");
  }
  const arm = manifest.platforms.find((platform) => platform.id === "mac-arm64");
  const intel = manifest.platforms.find((platform) => platform.id === "mac-x64");
  if (!arm?.feed || !intel?.feed) throw new Error("the Mac cutover needs both Mac platforms with feeds");
  if (feedDir(arm.feed) === feedDir(intel.feed)) {
    throw new Error("the Mac cutover gives Intel its own feed directory, apart from Apple Silicon");
  }
  if (intel.fallbackFeed && intel.fallbackFeed.path !== arm.feed.path) {
    throw new Error("the Intel fallback feed is the shared pre-cutover feed, the Apple Silicon one");
  }
}

export const downloadManifest = loadManifest();

export function markieSiteUrl(
  envValue = process.env.MARKIE_SITE_URL,
  nodeEnv = process.env.NODE_ENV
): string {
  const canonical = stripTrailingSlash(downloadManifest.siteUrl);
  const override = envValue ? stripTrailingSlash(envValue) : null;
  if (nodeEnv === "production" && override && override !== canonical) {
    throw new Error(`MARKIE_SITE_URL must match the stable release manifest in production: ${canonical}`);
  }
  return override ?? canonical;
}

export function downloadPlatforms(): DownloadPlatform[] {
  return downloadManifest.platforms;
}

export function findDownloadPlatform(input: string): DownloadPlatform | null {
  const normalizedRoute = input.startsWith("/download/") ? input : `/download/${input}`;
  return (
    downloadManifest.platforms.find(
      (platform) =>
        platform.id === input ||
        platform.route === input ||
        platform.route === normalizedRoute
    ) ?? null
  );
}

export function primaryDownloadPlatform(): DownloadPlatform {
  return (
    findDownloadPlatform(downloadManifest.primaryPlatformId) ??
    downloadManifest.platforms.find((platform) => platform.status === "public") ??
    downloadManifest.platforms[0]
  );
}

export function downloadHref(platform: DownloadPlatform, siteUrl = ""): string {
  if (!siteUrl) return platform.route;
  return `${stripTrailingSlash(siteUrl)}${platform.route}`;
}

// The button that offers Markie from somewhere that is not the download page:
// a shared document, an invite email, a page that could not be found. The
// platform's own label belongs on a card next to three other cards, where the
// architecture is the thing being chosen. On its own it reads as an
// instruction to somebody who was not choosing anything.
export function primaryDownloadCta(siteUrl = ""): { href: string; label: string; platform: DownloadPlatform } {
  const platform = primaryDownloadPlatform();
  return {
    href: downloadHref(platform, siteUrl),
    label: "Get Markie",
    platform,
  };
}

export function feedForPlatform(
  platform: DownloadPlatform,
  envBase = process.env.MARKIE_DOWNLOAD_BASE,
  nodeEnv = process.env.NODE_ENV
): ResolvedDownloadFeed | null {
  if (!platform.feed) return null;
  if (envBase) {
    if (nodeEnv === "production") {
      throw new Error("MARKIE_DOWNLOAD_BASE cannot override the stable release manifest in production");
    }
    const base = stripTrailingSlash(envBase);
    const feedName = platform.feed.path.split("/").at(-1);
    return {
      ...platform.feed,
      url: `${base}/${feedName}`,
      artifactBaseUrl: base,
    };
  }
  const publicBase = stripTrailingSlash(downloadManifest.storage.publicBaseUrl);
  const feedPath = stripLeadingSlash(platform.feed.path);
  const artifactPath = feedPath.split("/").slice(0, -1).join("/");
  return {
    ...platform.feed,
    url: `${publicBase}/${feedPath}`,
    artifactBaseUrl: artifactPath ? `${publicBase}/${artifactPath}` : publicBase,
  };
}

export function parseFeedVersion(feedText: string): string | null {
  return feedText.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null;
}

export function parseArtifactName(feedText: string, platform: DownloadPlatform): string | null {
  if (!platform.artifactPattern) return null;
  const pattern = platform.artifactPattern
    .split("*")
    .map(escapeRegex)
    .join("[^\\s\"']+?");
  const match = feedText.match(new RegExp(pattern));
  return match?.[0] ?? null;
}

export function parseDmgName(feedText: string): string | null {
  return parseArtifactName(feedText, primaryDownloadPlatform());
}

/** The platform's fallback feed, resolved the same way as its main one. */
export function fallbackFeedForPlatform(
  platform: DownloadPlatform,
  envBase = process.env.MARKIE_DOWNLOAD_BASE,
  nodeEnv = process.env.NODE_ENV
): ResolvedDownloadFeed | null {
  if (!platform.fallbackFeed) return null;
  return feedForPlatform({ ...platform, feed: platform.fallbackFeed }, envBase, nodeEnv);
}

export function artifactDownloadUrl(
  platform: DownloadPlatform,
  artifactName: string,
  feed: ResolvedDownloadFeed | null = feedForPlatform(platform)
): string | null {
  if (!feed) return null;
  return `${stripTrailingSlash(feed.artifactBaseUrl)}/${encodeURIComponent(artifactName)}`;
}

// Which platform a visitor is most likely on, for the versionless
// /download/latest link. Only the OS is read: a Mac's user agent says
// "Intel Mac OS X" on Apple Silicon too, so the architecture is not knowable
// from here and macOS gets the primary (Apple Silicon) build, as before.
// Android and ChromeOS both say "Linux" and run neither package, and an ARM
// Linux machine cannot run the x64 build.
export function platformIdForUserAgent(userAgent: string | null | undefined): string | null {
  const ua = userAgent ?? "";
  if (/Windows NT/i.test(ua)) return "windows-x64";
  if (/Android|CrOS/i.test(ua)) return null;
  if (/Linux/i.test(ua)) return /aarch64|arm64|armv/i.test(ua) ? null : "linux-x64";
  if (/Mac OS X|Macintosh/i.test(ua)) return downloadManifest.primaryPlatformId;
  return null;
}
