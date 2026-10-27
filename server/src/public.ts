// Unauthenticated public share surface: a rendered preview and a raw download.
// Mounted at root (not /api) so links are clean: ${SITE}/s/:token
import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { resolvePublicToken } from "./public-links.ts";
import { publicPageLinkFor } from "./doc-links.ts";
import { assetRefsFor, assetVersion, serveAsset } from "./assets.ts";
import {
  renderDownloadPage,
  renderPublicPage,
  renderNotFoundPage,
} from "./render.ts";
import {
  artifactDownloadUrl,
  downloadHref,
  downloadManifest,
  downloadPlatforms,
  feedForPlatform,
  findDownloadPlatform,
  parseArtifactName,
  parseFeedVersion,
  platformIdForUserAgent,
  primaryDownloadPlatform,
  type DownloadPlatform,
} from "./downloads.ts";

import { deployment } from "./deployment.ts";
import { downloadFilename } from "./doc-meta.ts";

const db = openDatabase();
const DEPLOYMENT = deployment();
const MARKIE_SITE = DEPLOYMENT.siteUrl;

// Cache resolved artifact URLs so a "Get Markie" click does not hit B2 every time.
type ResolvedRelease = {
  version: string;
  artifactName: string;
  artifactUrl: string;
};

const downloadCache = new Map<string, { release: ResolvedRelease; at: number }>();
const DMG_TTL_MS = 5 * 60 * 1000;
// A "ready" platform whose stable feed does not exist yet answers 404 from the
// bucket on every page view until its first release. Remembering the 404 for a
// minute keeps the download page from asking Backblaze about it each time,
// while still noticing the first release within a minute of it landing.
const missingFeedCache = new Map<string, number>();
const MISSING_FEED_TTL_MS = 60 * 1000;

async function resolvePlatformRelease(platform: DownloadPlatform): Promise<ResolvedRelease | null> {
  const cached = downloadCache.get(platform.id);
  if (cached && Date.now() - cached.at < DMG_TTL_MS) return cached.release;
  const feed = feedForPlatform(platform);
  if (!feed) return null;
  const missingAt = missingFeedCache.get(platform.id);
  if (!cached && missingAt && Date.now() - missingAt < MISSING_FEED_TTL_MS) return null;
  try {
    const res = await fetch(feed.url);
    if (res.status === 404) missingFeedCache.set(platform.id, Date.now());
    if (!res.ok) throw new Error(`feed ${res.status}`);
    missingFeedCache.delete(platform.id);
    const feedText = await res.text();
    const version = parseFeedVersion(feedText);
    const artifactName = parseArtifactName(feedText, platform);
    if (!version) throw new Error(`no version for ${platform.id} in feed`);
    if (!artifactName) throw new Error(`no artifact for ${platform.id} in feed`);
    const artifactUrl = artifactDownloadUrl(platform, artifactName);
    if (!artifactUrl) throw new Error(`no artifact base for ${platform.id}`);
    const release = { version, artifactName, artifactUrl };
    downloadCache.set(platform.id, { release, at: Date.now() });
    return release;
  } catch {
    return cached?.release ?? null; // serve a stale value through a transient blip
  }
}

export function clearDownloadCacheForTests() {
  downloadCache.clear();
  missingFeedCache.clear();
}

// Every platform a visitor can download right now, with its resolved release.
// A public platform is always listed (its release may be null while the bucket
// is unreachable, which latest.json has always reported that way). A ready
// platform is listed only once its stable feed resolves: that is the moment
// the release flow published it.
async function offeredPlatforms(): Promise<
  { platform: DownloadPlatform; release: ResolvedRelease | null }[]
> {
  const candidates = downloadPlatforms().filter(
    (platform) => platform.status === "public" || platform.status === "ready"
  );
  const resolved = await Promise.all(
    candidates.map(async (platform) => ({ platform, release: await resolvePlatformRelease(platform) }))
  );
  return resolved.filter(({ platform, release }) => platform.status === "public" || release !== null);
}

function docForToken(
  token: string
): { doc_id: string; name: string; content: string; format: string } | null {
  const link = resolvePublicToken(token);
  if (!link) return null;
  const doc = db
    .prepare(
      "SELECT name, content, format FROM docs WHERE id = ? AND deleted_at IS NULL"
    )
    .get(link.doc_id) as { name: string; content: string; format: string } | undefined;
  return doc ? { doc_id: link.doc_id, ...doc } : null;
}

export const publicShare = new Hono();

// A self-hosted server is not a release channel. Its copy of the manifest is
// whatever was in the repository when it was built, so serving downloads from
// it would hand out stale builds under somebody else's domain. Every download
// route answers with the official page instead (or the official manifest, for
// the one JSON route), registered ahead of the real handlers so they are never
// reached. The official deployment registers nothing here.
if (!DEPLOYMENT.official) {
  const officialDownloads = `${DEPLOYMENT.downloadSiteUrl}/download`;
  publicShare.get(downloadManifest.latestManifestRoute, (c) =>
    c.redirect(`${DEPLOYMENT.downloadSiteUrl}${downloadManifest.latestManifestRoute}`, 302)
  );
  publicShare.get("/download", (c) => c.redirect(officialDownloads, 302));
  publicShare.get("/download/*", (c) => c.redirect(officialDownloads, 302));
}

const offeredIds = async () => new Set((await offeredPlatforms()).map(({ platform }) => platform.id));

publicShare.get("/download", async (c) => {
  return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE, offered: await offeredIds() }));
});

publicShare.get(downloadManifest.latestManifestRoute, async (c) => {
  const releases = await offeredPlatforms();
  const primary = primaryDownloadPlatform();
  const primaryRelease = releases.find(({ platform }) => platform.id === primary.id)?.release ?? null;
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    schemaVersion: downloadManifest.schemaVersion,
    channel: downloadManifest.channel,
    version: primaryRelease?.version ?? null,
    primaryPlatformId: primary.id,
    downloadPageUrl: `${MARKIE_SITE}/download`,
    platforms: releases.map(({ platform, release }) => ({
      id: platform.id,
      label: platform.label,
      os: platform.os,
      arch: platform.arch,
      version: release?.version ?? null,
      downloadUrl: `${MARKIE_SITE}${downloadHref(platform)}`,
      artifactUrl: release?.artifactUrl ?? null,
    })),
    // Platforms the release flow will publish but has not yet. The release
    // runner reads this before promoting one, to know this server will offer
    // it the moment its stable feed lands, rather than finding out afterwards
    // that the deployed server predates it.
    awaitingFirstRelease: downloadPlatforms()
      .filter((platform) => platform.status === "ready" && !releases.some((entry) => entry.platform.id === platform.id))
      .map((platform) => platform.id),
  });
});

// The versionless "get Markie" link: the build for the visitor's OS when it is
// offered, the primary build otherwise. It varies by user agent, so caches
// must key on it.
publicShare.get("/download/latest", async (c) => {
  c.header("Vary", "User-Agent");
  const guessId = platformIdForUserAgent(c.req.header("user-agent"));
  const guess = guessId ? findDownloadPlatform(guessId) : null;
  const offered =
    guess?.status === "public" || (guess?.status === "ready" && (await resolvePlatformRelease(guess)) !== null);
  return c.redirect(downloadHref(offered && guess ? guess : primaryDownloadPlatform()), 307);
});

publicShare.get("/download/:platform", async (c) => {
  const platform = findDownloadPlatform(c.req.path) ?? findDownloadPlatform(c.req.param("platform"));
  if (!platform) return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE, status: "missing" }), 404);
  if (platform.status === "planned") {
    return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE, selectedPlatform: platform }), 404);
  }
  const release = await resolvePlatformRelease(platform);
  if (!release) {
    // A ready platform with no stable feed has simply not been released yet;
    // say so on the page rather than bouncing to it with no explanation.
    if (platform.status === "ready") {
      return c.html(
        renderDownloadPage({ siteUrl: MARKIE_SITE, selectedPlatform: platform, offered: await offeredIds() }),
        404
      );
    }
    return c.redirect(`${MARKIE_SITE}/download`, 302); // last-resort if B2 is down
  }
  return c.redirect(release.artifactUrl, 302);
});

publicShare.get("/s/:token", (c) => {
  const token = c.req.param("token");
  const doc = docForToken(token);
  if (!doc) return c.html(renderNotFoundPage(MARKIE_SITE), 404);
  const refs = assetRefsFor(doc.doc_id);
  // ?v= is the hash this ref points at, so a relink changes the URL; see the
  // note in doc-view.ts for why an hour of freshness needs it.
  const assetUrlFor = (ref: string) => {
    const row = refs.get(ref);
    if (!row) return null;
    return `/s/${encodeURIComponent(token)}/assets?ref=${encodeURIComponent(ref)}&v=${assetVersion(row.hash)}`;
  };
  return c.html(
    renderPublicPage({
      title: doc.name,
      markdown: doc.content,
      token,
      siteUrl: MARKIE_SITE,
      assetUrlFor,
      docLinkFor: publicPageLinkFor(doc.doc_id),
    })
  );
});

publicShare.get("/s/:token/raw", (c) => {
  const token = c.req.param("token");
  const doc = docForToken(token);
  if (!doc) return c.text("Not found", 404);
  // The same name /d/:id/raw gives it: a Darkmown document stays a .wd.
  const filename = downloadFilename(doc.name, doc.format);
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return c.body(doc.content);
});

publicShare.get("/s/:token/assets", (c) => {
  const doc = docForToken(c.req.param("token"));
  if (!doc) return c.text("Not found", 404);
  return serveAsset(c, doc.doc_id, c.req.query("ref") ?? "");
});
