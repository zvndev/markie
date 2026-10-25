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

async function resolvePlatformRelease(platform: DownloadPlatform): Promise<ResolvedRelease | null> {
  const cached = downloadCache.get(platform.id);
  if (cached && Date.now() - cached.at < DMG_TTL_MS) return cached.release;
  const feed = feedForPlatform(platform);
  if (!feed) return null;
  try {
    const res = await fetch(feed.url);
    if (!res.ok) throw new Error(`feed ${res.status}`);
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

publicShare.get("/download", (c) => {
  return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE }));
});

publicShare.get(downloadManifest.latestManifestRoute, async (c) => {
  const platforms = downloadPlatforms().filter((platform) => platform.status === "public");
  const releases = await Promise.all(
    platforms.map(async (platform) => ({ platform, release: await resolvePlatformRelease(platform) }))
  );
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
  });
});

publicShare.get("/download/latest", (c) => {
  return c.redirect(downloadHref(primaryDownloadPlatform()), 307);
});

publicShare.get("/download/:platform", async (c) => {
  const platform = findDownloadPlatform(c.req.path) ?? findDownloadPlatform(c.req.param("platform"));
  if (!platform) return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE, status: "missing" }), 404);
  if (platform.status !== "public") {
    return c.html(renderDownloadPage({ siteUrl: MARKIE_SITE, selectedPlatform: platform }), 404);
  }
  const release = await resolvePlatformRelease(platform);
  if (!release) return c.redirect(`${MARKIE_SITE}/download`, 302); // last-resort if B2 is down
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
