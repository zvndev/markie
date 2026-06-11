// Theme sync: each account stores its theme-preset store (opaque JSON,
// last-write-wins), and a doc owner can pin a theme to a doc so everyone
// it's shared with reads it the way the owner styled it.
import { Hono } from "hono";
import Database from "better-sqlite3";
import { auth } from "./auth.ts";
import { accessLevel, isOwner } from "./shares.ts";

const db = new Database(process.env.DB_PATH ?? "./markie.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS user_themes (
    user_id TEXT PRIMARY KEY,
    store TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// docs table predates this phase — add the pinned-theme column in place
try {
  db.exec("ALTER TABLE docs ADD COLUMN enforced_theme TEXT");
} catch {
  // column already exists
}

async function requireUser(c: { req: { raw: Request } }) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

export const themes = new Hono();

themes.get("/me/themes", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const row = db
    .prepare("SELECT store, updated_at FROM user_themes WHERE user_id = ?")
    .get(user.id) as { store: string; updated_at: string } | undefined;
  if (!row) return c.json({ store: null, updated_at: null });
  return c.json({ store: JSON.parse(row.store), updated_at: row.updated_at });
});

themes.put("/me/themes", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { store } = (await c.req.json()) as { store: unknown };
  if (!store || typeof store !== "object") {
    return c.json({ error: "bad request" }, 400);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_themes (user_id, store, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET store = excluded.store, updated_at = excluded.updated_at`
  ).run(user.id, JSON.stringify(store), now);
  return c.json({ ok: true, updated_at: now });
});

// Pin (or unpin with null) the owner's theme tokens to a doc
themes.put("/docs/:id/theme", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!isOwner(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const { tokens } = (await c.req.json()) as { tokens: unknown };
  if (tokens !== null && typeof tokens !== "object") {
    return c.json({ error: "bad request" }, 400);
  }
  db.prepare("UPDATE docs SET enforced_theme = ? WHERE id = ?").run(
    tokens === null ? null : JSON.stringify(tokens),
    docId
  );
  return c.json({ ok: true });
});

// Read a doc's pinned theme (any member)
themes.get("/docs/:id/theme", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!accessLevel(docId, user.id)) return c.json({ error: "forbidden" }, 403);
  const row = db
    .prepare("SELECT enforced_theme FROM docs WHERE id = ? AND deleted_at IS NULL")
    .get(docId) as { enforced_theme: string | null } | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    tokens: row.enforced_theme ? JSON.parse(row.enforced_theme) : null,
  });
});
