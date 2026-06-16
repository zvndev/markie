// Unauthenticated public share surface: a rendered preview and a raw download.
// Mounted at root (not /api) so links are clean: ${SITE}/s/:token
import { Hono } from "hono";
import Database from "better-sqlite3";
import { resolvePublicToken } from "./public-links.ts";
import {
  renderPublicPage,
  renderNotFoundPage,
} from "./render.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");
const MARKIE_SITE = process.env.MARKIE_SITE_URL ?? "https://markie.zvndev.com";

// Public B2 folder that holds the published macOS releases + latest-mac.yml.
const MARKIE_DOWNLOAD_BASE =
  process.env.MARKIE_DOWNLOAD_BASE ??
  "https://f005.backblazeb2.com/file/markie-releases/mac";

// Pull the current macOS .dmg filename out of electron-builder's latest-mac.yml.
export function parseDmgName(yml: string): string | null {
  const m = yml.match(/(Markie-[^\s"']+?-arm64\.dmg)/);
  return m ? m[1] : null;
}

// Cache the resolved DMG URL so a "Get Markie" click doesn't hit B2 every time.
let dmgCache: { url: string; at: number } | null = null;
const DMG_TTL_MS = 5 * 60 * 1000;

async function resolveDmgUrl(): Promise<string | null> {
  if (dmgCache && Date.now() - dmgCache.at < DMG_TTL_MS) return dmgCache.url;
  try {
    const res = await fetch(`${MARKIE_DOWNLOAD_BASE}/latest-mac.yml`);
    if (!res.ok) throw new Error(`feed ${res.status}`);
    const dmg = parseDmgName(await res.text());
    if (!dmg) throw new Error("no dmg in feed");
    const url = `${MARKIE_DOWNLOAD_BASE}/${dmg}`;
    dmgCache = { url, at: Date.now() };
    return url;
  } catch {
    return dmgCache?.url ?? null; // serve a stale value through a transient blip
  }
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

// "Get Markie for macOS" — always redirect to the current published .dmg.
publicShare.get("/download/mac", async (c) => {
  const url = await resolveDmgUrl();
  if (!url) return c.redirect(MARKIE_SITE, 302); // last-resort if B2 is down
  return c.redirect(url, 302);
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
