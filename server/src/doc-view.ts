// Reading a shared document on the web, scoped to the person it was shared
// with. Markie documents are never public: there is no URL here that shows a
// document to someone who is not a member of it or holding an open invite to
// it.
//
// Two ways in, and both are checked live against the share tables:
//
//   ?k=<token>  the link from an invite email. The token names a person, not a
//               document. Access is re-derived from that person's share row on
//               every request, so removing them kills the link immediately and
//               there is nothing separate to revoke.
//   session     a signed-in browser, checked the same way.
//
// Anything else gets an access page that names no document, so the route
// cannot be used to discover which document ids exist.
import { Hono } from "hono";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canEditLevel,
  canReadLevel,
  memberForToken,
} from "./shares.ts";
import { pendingForToken } from "./pending.ts";
import { markieSiteUrl } from "./downloads.ts";
import { renderAccessRequiredPage, renderSharedDocPage } from "./render.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

const MARKIE_SITE = markieSiteUrl();

export const docView = new Hono();

interface DocRow {
  id: string;
  name: string;
  content: string;
  owner_id: string;
}

function loadDoc(docId: string): DocRow | null {
  return (
    (db
      .prepare(
        "SELECT id, name, content, owner_id FROM docs WHERE id = ? AND deleted_at IS NULL"
      )
      .get(docId) as DocRow | undefined) ?? null
  );
}

function inviterName(userId: string): string | null {
  const row = db
    .prepare("SELECT name, email FROM user WHERE id = ?")
    .get(userId) as { name: string | null; email: string | null } | undefined;
  return row?.name || row?.email || null;
}

export interface DocViewer {
  canEdit: boolean;
}

// Decide whether this request may read this document. Every path ends in a
// lookup against the share tables; a token is never trusted on its own.
export async function resolveViewer(
  docId: string,
  token: string | null,
  headers: Headers
): Promise<DocViewer | null> {
  if (token) {
    const member = memberForToken(token);
    // The token must belong to the document being asked for. Without this a
    // token for one document would open any other.
    if (member && member.docId === docId) {
      const level = accessLevel(docId, member.userId);
      if (canReadLevel(level)) return { canEdit: canEditLevel(level) };
    }
    const pending = pendingForToken(token);
    // A pending invite has no user to check, so the row's own existence is the
    // authorization. Withdrawing the invite deletes it.
    if (pending && pending.docId === docId) {
      return { canEdit: pending.role === "editor" };
    }
  }

  const session = await auth.api.getSession({ headers });
  const userId = session?.user?.id;
  if (userId) {
    const level = accessLevel(docId, userId);
    if (canReadLevel(level)) return { canEdit: canEditLevel(level) };
  }

  return null;
}

docView.get("/d/:id", async (c) => {
  const docId = c.req.param("id");
  const viewer = await resolveViewer(
    docId,
    c.req.query("k") ?? null,
    c.req.raw.headers
  );
  // 403 for both "no access" and "no such document": telling them apart would
  // turn this route into a way to enumerate document ids.
  if (!viewer) return c.html(renderAccessRequiredPage(MARKIE_SITE), 403);
  const doc = loadDoc(docId);
  if (!doc) return c.html(renderAccessRequiredPage(MARKIE_SITE), 403);

  // The link is personal, so keep it out of shared caches and out of the
  // referrer of anything the document links to.
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  // Set here rather than inherited from the website, which does not own this
  // response: the page is served through a rewrite and must carry its own
  // policy.
  c.header("X-Frame-Options", "DENY");
  return c.html(
    renderSharedDocPage({
      title: doc.name,
      markdown: doc.content,
      docId,
      siteUrl: MARKIE_SITE,
      sharedBy: inviterName(doc.owner_id),
      canEdit: viewer.canEdit,
    })
  );
});

docView.get("/d/:id/raw", async (c) => {
  const docId = c.req.param("id");
  const viewer = await resolveViewer(
    docId,
    c.req.query("k") ?? null,
    c.req.raw.headers
  );
  if (!viewer) return c.text("Not found", 403);
  const doc = loadDoc(docId);
  if (!doc) return c.text("Not found", 403);

  const cleaned = doc.name.replace(/[\r\n"\\]/g, "").trim() || "document";
  const filename = cleaned.toLowerCase().endsWith(".md")
    ? cleaned
    : `${cleaned}.md`;
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Cache-Control", "private, no-store");
  c.header(
    "Content-Disposition",
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return c.body(doc.content);
});
