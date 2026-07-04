import { readFileSync } from "node:fs";

export type DownloadStatus = "public" | "planned";

export type DownloadFeed = {
  type: "electron-builder-mac-yml";
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
};

export type DownloadManifest = {
  version: number;
  primaryPlatformId: string;
  platforms: DownloadPlatform[];
};

export const DOWNLOAD_MANIFEST_URL = new URL("../download-manifest.json", import.meta.url);

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const loadManifest = (): DownloadManifest => {
  const manifest = JSON.parse(readFileSync(DOWNLOAD_MANIFEST_URL, "utf8")) as DownloadManifest;
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0) {
    throw new Error("download manifest must define at least one platform");
  }
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const platform of manifest.platforms) {
    if (!platform.id || ids.has(platform.id)) throw new Error(`invalid download platform id: ${platform.id}`);
    if (!platform.route.startsWith("/download/")) throw new Error(`invalid download route: ${platform.route}`);
    if (routes.has(platform.route)) throw new Error(`duplicate download route: ${platform.route}`);
    if (platform.status === "public" && (!platform.feed || !platform.artifactPattern)) {
      throw new Error(`public download platform ${platform.id} needs a feed and artifact pattern`);
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
  envBase = process.env.MARKIE_DOWNLOAD_BASE
): DownloadFeed | null {
  if (platform.id === "mac-arm64" && envBase) {
    const base = stripTrailingSlash(envBase);
    return {
      type: "electron-builder-mac-yml",
      url: `${base}/latest-mac.yml`,
      artifactBaseUrl: base,
    };
  }
  return platform.feed ?? null;
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
