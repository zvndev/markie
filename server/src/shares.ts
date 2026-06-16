import { Hono } from "hono";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import { sendEmail } from "./email.ts";
import { addPending, listPendingForDoc, removePending } from "./pending.ts";
import {
  createOrGetPublicLink,
  getPublicLinkToken,
  revokePublicLink,
} from "./public-links.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

// Where "Get Markie" buttons point until the marketing domain is live.
const MARKIE_SITE = process.env.MARKIE_SITE_URL ?? "https://markie.zvndev.com";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"
  );

db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
    invited_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, user_id)
  );
`);

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export function getShare(docId: string, userId: string) {
  return db
    .prepare("SELECT role FROM shares WHERE doc_id = ? AND user_id = ?")
    .get(docId, userId) as { role: "viewer" | "editor" } | undefined;
}

export function isOwner(docId: string, userId: string): boolean {
  const row = db
    .prepare("SELECT owner_id FROM docs WHERE id = ? AND deleted_at IS NULL")
    .get(docId) as { owner_id: string } | undefined;
  return row?.owner_id === userId;
}

// owner > editor > viewer > null
export function accessLevel(
  docId: string,
  userId: string
): "owner" | "editor" | "viewer" | null {
  if (isOwner(docId, userId)) return "owner";
  return getShare(docId, userId)?.role ?? null;
}

export function sharedDocsFor(userId: string) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.version, d.hash, d.updated_at, s.role,
              COALESCE(NULLIF(inviter.name, ''), inviter.email) AS shared_by
       FROM shares s
       JOIN docs d ON d.id = s.doc_id
       LEFT JOIN user inviter ON inviter.id = s.invited_by
       WHERE s.user_id = ? AND d.deleted_at IS NULL
       ORDER BY d.updated_at DESC`
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    version: number;
    hash: string;
    updated_at: string;
    role: string;
    shared_by: string | null;
  }>;
}

// Owned, non-deleted docs that have at least one member or pending invite —
// the "shared by me" tab. Counts members and pending invites separately.
export function docsSharedByMe(userId: string) {
  return db
    .prepare(
      `SELECT d.id, d.name, d.updated_at,
              (SELECT COUNT(*) FROM shares s WHERE s.doc_id = d.id) AS member_count,
              (SELECT COUNT(*) FROM pending_shares p WHERE p.doc_id = d.id) AS pending_count
       FROM docs d
       WHERE d.owner_id = ? AND d.deleted_at IS NULL
         AND ( EXISTS (SELECT 1 FROM shares s WHERE s.doc_id = d.id)
            OR EXISTS (SELECT 1 FROM pending_shares p WHERE p.doc_id = d.id) )
       ORDER BY d.updated_at DESC`
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    updated_at: string;
    member_count: number;
    pending_count: number;
  }>;
}

export const shares = new Hono();

// List members + pending invites (owner or member can see)
shares.get("/:id/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!accessLevel(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const members = db
    .prepare(
      `SELECT s.user_id, s.role, s.created_at, u.email, u.name
       FROM shares s JOIN user u ON u.id = s.user_id
       WHERE s.doc_id = ?`
    )
    .all(docId) as Array<Record<string, unknown>>;
  // Invited-but-not-yet-joined emails show as pending rows (no user_id/name).
  const pending = listPendingForDoc(docId).map((p) => ({
    user_id: null,
    role: p.role,
    created_at: p.created_at,
    email: p.email,
    name: null,
    pending: true,
  }));
  return c.json({ shares: [...members, ...pending] });
});

// Share with an email — existing user becomes a member now; an unknown email
// becomes a pending invite (emailed) that auto-claims when they join. Never
// errors on "no account yet".
shares.post("/:id/shares", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const { email, role } = (await c.req.json()) as {
    email: string;
    role: "viewer" | "editor";
  };
  const cleanEmail = (email ?? "").toLowerCase().trim();
  if (!cleanEmail || !["viewer", "editor"].includes(role)) {
    return c.json({ error: "bad request" }, 400);
  }
  if (cleanEmail === (user.email ?? "").toLowerCase()) {
    return c.json({ error: "That's you" }, 400);
  }
  const doc = db
    .prepare("SELECT name FROM docs WHERE id = ?")
    .get(docId) as { name: string };
  const inviter = user.name || user.email;

  const recipient = db
    .prepare("SELECT id, email, name FROM user WHERE email = ?")
    .get(cleanEmail) as
    | { id: string; email: string; name: string }
    | undefined;

  if (recipient) {
    // Existing user → real member immediately.
    db.prepare(
      `INSERT INTO shares (doc_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, user_id) DO UPDATE SET role = excluded.role`
    ).run(docId, recipient.id, role, user.id, new Date().toISOString());

    await sendEmail({
      to: recipient.email,
      subject: `You're in: “${doc.name}”`,
      text: `${inviter} added you to "${doc.name}" as ${
        role === "editor" ? "an editor" : "a viewer"
      }. It's waiting in your Library — open Markie and press ⌘L.`,
      html: addedHtml(inviter, doc.name, role),
    });
    return c.json({ ok: true, status: "member", userId: recipient.id, role });
  }

  // Unknown email → pending invite + a friendly nudge to join.
  addPending(docId, cleanEmail, role, user.id);
  const previewUrl = `${MARKIE_SITE}/s/${createOrGetPublicLink(docId, user.id)}`;
  await sendEmail({
    to: cleanEmail,
    subject: `📄 ${inviter} tossed you a doc`,
    text: `${inviter} shared "${doc.name}" with you on Markie.\n\nRead it right now (no account needed): ${previewUrl}\n\nReading raw markdown in a browser is a small tragedy — Markie fixes that. Make an account with this email and "${doc.name}" will be waiting in your Library.`,
    html: inviteHtml(inviter, doc.name, previewUrl),
  });
  return c.json({ ok: true, status: "invited", email: cleanEmail, role });
});

// Remove a member (by user id) or a pending invite (by email) — owner only.
shares.delete("/:id/shares/:idOrEmail", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const target = decodeURIComponent(c.req.param("idOrEmail"));
  const removedMember = db
    .prepare("DELETE FROM shares WHERE doc_id = ? AND user_id = ?")
    .run(docId, target).changes > 0;
  const removedPending = target.includes("@")
    ? removePending(docId, target)
    : false;
  if (!removedMember && !removedPending) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true });
});

// Current public link for a doc (owner or member). null when none exists yet.
shares.get("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!accessLevel(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const token = getPublicLinkToken(docId);
  return c.json({ url: token ? `${MARKIE_SITE}/s/${token}` : null });
});

// Create (or return) the public link — owner only.
shares.post("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const token = createOrGetPublicLink(docId, user.id);
  return c.json({ url: `${MARKIE_SITE}/s/${token}` });
});

// Revoke the public link — owner only.
shares.delete("/:id/public-link", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  revokePublicLink(docId);
  return c.json({ ok: true });
});

// ── playful invite email bodies ──
function inviteHtml(
  inviter: string,
  docName: string,
  previewUrl: string
): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:460px;margin:0 auto;color:#18181b">
  <div style="font-size:32px;font-weight:800;color:#f59e0b">M</div>
  <h2 style="font-size:19px;margin:8px 0 4px">${escapeHtml(inviter)} tossed you a doc 📄</h2>
  <p style="font-size:14px;line-height:1.5;color:#3f3f46">They shared <strong>${escapeHtml(docName)}</strong> with you on Markie.</p>
  <p style="font-size:14px;line-height:1.5;color:#3f3f46">No account needed to read it — it's right here, rendered nicely:</p>
  <p style="margin:20px 0">
    <a href="${escapeHtml(previewUrl)}" style="background:#f59e0b;color:#000;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;display:inline-block">Open it →</a>
  </p>
  <p style="font-size:13px;line-height:1.7;color:#3f3f46">Or get the app: <a href="${escapeHtml(MARKIE_SITE)}/download/mac" style="color:#b45309;font-weight:600">Get Markie for macOS</a> · <a href="markie://open" style="color:#b45309">Open in Markie</a> · <a href="${escapeHtml(previewUrl)}/raw" style="color:#b45309">Download the .md</a></p>
  <p style="font-size:13px;color:#3f3f46">Make an account with this email to keep <strong>${escapeHtml(docName)}</strong> in your Library — your markdown will thank you.</p>
</div>`;
}

function addedHtml(
  inviter: string,
  docName: string,
  role: "viewer" | "editor"
): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:460px;margin:0 auto;color:#18181b">
  <div style="font-size:32px;font-weight:800;color:#f59e0b">M</div>
  <h2 style="font-size:19px;margin:8px 0 4px">You're in: ${escapeHtml(docName)}</h2>
  <p style="font-size:14px;line-height:1.5;color:#3f3f46">${escapeHtml(inviter)} added you as ${role === "editor" ? "an <strong>editor</strong>" : "a <strong>viewer</strong>"}. It's waiting in your Library — open Markie and press ⌘L${role === "editor" ? ", and you're both editing live." : "."}</p>
</div>`;
}
