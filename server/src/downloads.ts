import { readFileSync } from "node:fs";

export type DownloadStatus = "public" | "planned";

export type DownloadFeed = {
  // electron-updater picks the feed file by platform: latest-mac.yml on macOS,
  // latest.yml on Windows. Naming the type is what keeps a manifest entry from
  // pointing a platform at the other one's feed, which resolves to a 404 that
  // only ever shows up as "no updates available".
  type: "electron-builder-mac-yml" | "electron-builder-win-yml";
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
    if (platform.status === "public" && !platform.feed) {
      throw new Error(`public download platform ${platform.id} needs a feed`);
    }
    if (platform.feed?.path.startsWith("/") || platform.feed?.path.includes("..")) {
      throw new Error(`invalid download feed path: ${platform.feed.path}`);
    }
    ids.add(platform.id);
    routes.add(platform.route);
  }
  if (!ids.has(manifest.primaryPlatformId)) {
    throw new Error(`primary download platform is missing: ${manifest.primaryPlatformId}`);
  }
  return manifest;
};

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

export function primaryDownloadCta(siteUrl = ""): { href: string; label: string; platform: DownloadPlatform } {
  const platform = primaryDownloadPlatform();
  return {
    href: downloadHref(platform, siteUrl),
    label: platform.ctaLabel,
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

export function artifactDownloadUrl(platform: DownloadPlatform, artifactName: string): string | null {
  const feed = feedForPlatform(platform);
  if (!feed) return null;
  return `${stripTrailingSlash(feed.artifactBaseUrl)}/${encodeURIComponent(artifactName)}`;
}
