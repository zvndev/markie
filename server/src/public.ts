// Unauthenticated public share surface: a rendered preview and a raw download.
// Mounted at root (not /api) so links are clean: ${SITE}/s/:token
import { Hono } from "hono";
import Database from "better-sqlite3";
import { resolvePublicToken } from "./public-links.ts";
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
  markieSiteUrl,
  parseArtifactName,
  parseFeedVersion,
  primaryDownloadPlatform,
  type DownloadPlatform,
} from "./downloads.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");
const MARKIE_SITE = markieSiteUrl();

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
): { name: string; content: string } | null {
  const link = resolvePublicToken(token);
  if (!link) return null;
  const doc = db
    .prepare(
      "SELECT name, content FROM docs WHERE id = ? AND deleted_at IS NULL"
    )
    .get(link.doc_id) as { name: string; content: string } | undefined;
  return doc ?? null;
}

export const publicShare = new Hono();

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
  return c.html(
    renderPublicPage({
      title: doc.name,
      markdown: doc.content,
      token,
      siteUrl: MARKIE_SITE,
    })
  );
});

publicShare.get("/s/:token/raw", (c) => {
  const token = c.req.param("token");
  const doc = docForToken(token);
  if (!doc) return c.text("Not found", 404);
  const cleaned = doc.name.replace(/[\r\n"\\]/g, "").trim() || "document";
  const filename = cleaned.toLowerCase().endsWith(".md") ? cleaned : `${cleaned}.md`;
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return c.body(doc.content);
});
