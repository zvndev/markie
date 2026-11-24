// Theme sync: each account stores its theme-preset store (opaque JSON,
// last-write-wins), and a doc owner can pin a look to a doc so everyone
// it's shared with reads it the way the owner styled it.
//
// A pinned look is two things side by side: the theme tokens (colours and
// faces, docs.enforced_theme) and the Markdown style (docs.enforced_style,
// how headings, lists, tables and the rest are drawn). The style is its own
// column, not a field inside the tokens, because the two are validated
// differently and read by different builds: tokens are an old, open blob
// every shipped client reads whole, while a style is a closed list of ids
// and numbers this server can check exactly. A client that predates styles
// reads `tokens` and never sees `style`.
//
// Nothing about a style is free text that reaches a stylesheet. It is cleaned
// by sanitizeMarkdownStyle when stored and again when read, and the clients
// clean it a third time before drawing.
import { Hono } from "hono";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import {
  accessLevel,
  canManageLevel,
  canReadLevel,
} from "./shares.ts";
import {
  MARKDOWN_STYLE_LIMITS,
  sanitizeMarkdownStyle,
  sanitizeMarkdownStyleStore,
  type MarkdownStyle,
} from "./generated/markdown-style-schema.ts";

const db = openDatabase();

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

// The Markdown style pinned beside the theme. Null when none is.
try {
  db.exec("ALTER TABLE docs ADD COLUMN enforced_style TEXT");
} catch {
  // column already exists
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A stored style, cleaned again on the way out. Null when there is none. */
function storedStyle(text: string | null | undefined): MarkdownStyle | null {
  return sanitizeMarkdownStyle(parseJson(text));
}

const PLAIN_COLOR =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d\s.,%/+-]|deg|turn|rad|none)+\))$/i;
const TOKEN_COLORS = [
  "background", "surface", "surface2", "foreground", "muted", "border", "docRule", "accent", "link",
  "statusGreen", "statusYellow", "statusRed", "statusBlue", "statusPurple",
];
const TOKEN_NUMBERS = ["fontSize", "contentWidth", "lineHeight", "paragraphGap"];
const TOKEN_IDS = ["bodyFont", "headingFont"];

/**
 * Pinned tokens as a public link hands them out: plain colours, plain
 * numbers and face ids, nothing else. Members get the stored tokens as they
 * always have (their clients check them); a public link is read by anyone,
 * so it gets only what can be checked here.
 */
export function publicTokens(raw: unknown): Record<string, string | number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const key of TOKEN_COLORS) {
    const value = source[key];
    if (typeof value === "string" && value.length <= 64 && PLAIN_COLOR.test(value.trim())) out[key] = value.trim();
  }
  for (const key of TOKEN_NUMBERS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4000) out[key] = value;
  }
  for (const key of TOKEN_IDS) {
    const value = source[key];
    if (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The look pinned to a document, for its public page (public.ts). Null when the document is gone. */
export function pinnedLookForPublic(docId: string): { tokens: Record<string, string | number> | null; style: MarkdownStyle | null } | null {
  const row = db
    .prepare("SELECT enforced_theme, enforced_style FROM docs WHERE id = ? AND deleted_at IS NULL")
    .get(docId) as { enforced_theme: string | null; enforced_style: string | null } | undefined;
  if (!row) return null;
  return { tokens: publicTokens(parseJson(row.enforced_theme)), style: row.enforced_theme ? storedStyle(row.enforced_style) : null };
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
  // The store stays opaque except for its Markdown styles, which are held to
  // the same closed lists as a pinned one. A build that predates styles saves
  // a store without the field (it rebuilds the store when a template is
  // chosen); that must not erase the account's profiles, so the stored field
  // is kept unless this save names one.
  const incoming = store as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(incoming, "markdownStyle")) {
    const clean = sanitizeMarkdownStyleStore(incoming.markdownStyle);
    if (clean && JSON.stringify(clean).length <= MARKDOWN_STYLE_LIMITS.bytes) incoming.markdownStyle = clean;
    else delete incoming.markdownStyle;
  } else {
    const before = db.prepare("SELECT store FROM user_themes WHERE user_id = ?").get(user.id) as { store: string } | undefined;
    const kept = sanitizeMarkdownStyleStore((parseJson(before?.store) as Record<string, unknown> | null)?.markdownStyle);
    if (kept) incoming.markdownStyle = kept;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_themes (user_id, store, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET store = excluded.store, updated_at = excluded.updated_at`
  ).run(user.id, JSON.stringify(store), now);
  return c.json({ ok: true, updated_at: now });
});

// Pin (or unpin with null) the owner's look to a doc: the theme tokens, and
// the Markdown style beside them. A pin replaces the whole look, so a build
// that sends no style pins the default one, and unpinning clears both.
themes.put("/docs/:id/theme", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canManageLevel(accessLevel(docId, user.id))) return c.json({ error: "forbidden" }, 403);
  const { tokens, style } = (await c.req.json()) as { tokens: unknown; style?: unknown };
  if (tokens !== null && typeof tokens !== "object") {
    return c.json({ error: "bad request" }, 400);
  }
  if (style !== undefined && style !== null && (typeof style !== "object" || Array.isArray(style))) {
    return c.json({ error: "bad request" }, 400);
  }
  const pinned = tokens === null ? null : sanitizeMarkdownStyle(style);
  db.prepare("UPDATE docs SET enforced_theme = ?, enforced_style = ? WHERE id = ?").run(
    tokens === null ? null : JSON.stringify(tokens),
    pinned ? JSON.stringify(pinned) : null,
    docId
  );
  return c.json({ ok: true, style: pinned });
});

// Read a doc's pinned look (any member)
themes.get("/docs/:id/theme", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const docId = c.req.param("id");
  if (!canReadLevel(accessLevel(docId, user.id))) return c.json({ error: "forbidden" }, 403);
  const row = db
    .prepare("SELECT enforced_theme, enforced_style FROM docs WHERE id = ? AND deleted_at IS NULL")
    .get(docId) as { enforced_theme: string | null; enforced_style: string | null } | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    tokens: row.enforced_theme ? JSON.parse(row.enforced_theme) : null,
    style: row.enforced_theme ? storedStyle(row.enforced_style) : null,
  });
});
