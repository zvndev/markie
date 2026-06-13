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
