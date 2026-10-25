// Per-user agent tokens: how a remote agent (no desktop app nearby) writes
// documents into someone's Markie Cloud. See docs/mobile/AGENT-LINKS-CONTRACT.md.
//
// A token is `mk_agent_` + 32 random bytes in base64url. Only its SHA-256 is
// stored, so a copy of the database is not a set of working tokens, and the
// token itself is shown to its owner exactly once, in the response that made
// it.
//
// What a token can do is deliberately small (agent-docs.ts): create
// documents, and read and update the documents agent tokens of the same user
// created. It can never reach the rest of the drive, and it can never manage
// tokens: the routes here take a signed-in session and refuse an agent token
// outright, so a leaked token cannot mint itself a successor.
import { Hono, type Context } from "hono";
import crypto from "node:crypto";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { cleanAgentName } from "./doc-meta.ts";

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id);
`);

export const AGENT_TOKEN_PREFIX = "mk_agent_";
// 32 bytes is 43 base64url characters, unpadded.
const AGENT_TOKEN = /^mk_agent_[A-Za-z0-9_-]{43}$/;
const DISPLAY_PREFIX_CHARS = 12;
export const MAX_ACTIVE_TOKENS = 20;
export const TOKEN_NAME_MAX = 64;

export function newAgentToken(): string {
  return AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

const sha256Hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** The bearer value of an Authorization header, or null. */
function bearerOf(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1] : null;
}

/** Whether a request presents an agent token, valid or not. */
export function presentsAgentToken(headers: Headers): boolean {
  return bearerOf(headers)?.startsWith(AGENT_TOKEN_PREFIX) ?? false;
}

export interface AgentPrincipal {
  tokenId: string;
  userId: string;
  /** The token's name, the fallback display name for what it creates. */
  name: string;
}

const LAST_USED_RESOLUTION_MS = 60 * 1000;

/**
 * The live token this request carries, or null. Never falls back to a
 * session: the agent routes answer to agent tokens and nothing else. The
 * row is found by its hash and the hash compared again in constant time, so
 * a lookup that matched on anything but the full value still fails.
 */
export function authenticateAgent(headers: Headers, now = Date.now()): AgentPrincipal | null {
  const token = bearerOf(headers);
  if (!token || !AGENT_TOKEN.test(token)) return null;
  const hash = sha256Hex(token);
  const row = db
    .prepare(
      `SELECT t.id, t.user_id, t.name, t.token_hash, t.last_used_at
       FROM agent_tokens t JOIN user u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
    .get(hash) as { id: string; user_id: string; name: string; token_hash: string; last_used_at: number | null } | undefined;
  if (!row) return null;
  const expected = Buffer.from(row.token_hash, "hex");
  const given = Buffer.from(hash, "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  // At most one write a minute per token, however busy the agent is.
  if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)").run(
      now,
      row.id,
      now - LAST_USED_RESOLUTION_MS
    );
  }
  return { tokenId: row.id, userId: row.user_id, name: row.name };
}

// ---- write rate limit ------------------------------------------------------
//
// 60 writes an hour per token, as a sliding window kept in memory. The server
// is one process on one SQLite file, so memory is the whole picture, and a
// restart forgiving an hour's count is a cost worth not adding a table for.
// Every authenticated write attempt counts, accepted or not, so a loop of
// refused writes is throttled like a loop of accepted ones.

export const WRITES_PER_HOUR = 60;
const WINDOW_MS = 60 * 60 * 1000;
const writes = new Map<string, number[]>();

/** Null when the write may go ahead (and is counted), else the seconds until one may. */
export function takeAgentWrite(tokenId: string, now = Date.now()): number | null {
  const recent = (writes.get(tokenId) ?? []).filter((at) => at > now - WINDOW_MS);
  if (recent.length >= WRITES_PER_HOUR) {
    writes.set(tokenId, recent);
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  writes.set(tokenId, recent);
  return null;
}

/** Test seam. */
export function resetAgentWriteLimitsForTests(): void {
  writes.clear();
}

// ---- management routes (session only) -------------------------------------

export const agentTokens = new Hono();

// Every answer here is about one person's credentials.
agentTokens.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

async function requireSessionUser(c: Context): Promise<{ id: string } | Response> {
  // Refused before the session lookup, so it holds whatever else the request
  // carries: an agent token never manages tokens, its own included.
  if (presentsAgentToken(c.req.raw.headers)) {
    return c.json({ error: "forbidden", message: "Agent tokens cannot manage agent tokens. Sign in to Markie to do this." }, 403);
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "unauthorized" }, 401);
  return { id: session.user.id };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

agentTokens.post("/", async (c) => {
  const user = await requireSessionUser(c);
  if (user instanceof Response) return user;
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const raw = typeof body?.name === "string" ? body.name : null;
  const name = cleanAgentName(raw);
  if (!name || Array.from(raw!.trim()).length > TOKEN_NAME_MAX) {
    return c.json({ error: "bad request", message: `Give the token a name of 1 to ${TOKEN_NAME_MAX} characters.` }, 400);
  }
  const token = newAgentToken();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const created = db.transaction((): boolean => {
    const { active } = db
      .prepare("SELECT COUNT(*) AS active FROM agent_tokens WHERE user_id = ? AND revoked_at IS NULL")
      .get(user.id) as { active: number };
    if (active >= MAX_ACTIVE_TOKENS) return false;
    db.prepare(
      "INSERT INTO agent_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, user.id, name, sha256Hex(token), token.slice(0, DISPLAY_PREFIX_CHARS), createdAt);
    return true;
  })();
  if (!created) {
    return c.json(
      { error: "token limit", message: `An account can have at most ${MAX_ACTIVE_TOKENS} agent tokens. Revoke one you no longer use.` },
      409
    );
  }
  return c.json({ id, name, token, prefix: token.slice(0, DISPLAY_PREFIX_CHARS), createdAt: iso(createdAt) }, 201);
});

agentTokens.get("/", async (c) => {
  const user = await requireSessionUser(c);
  if (user instanceof Response) return user;
  const rows = db
    .prepare(
      "SELECT id, name, prefix, created_at, last_used_at FROM agent_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id ASC"
    )
    .all(user.id) as { id: string; name: string; prefix: string; created_at: number; last_used_at: number | null }[];
  return c.json({
    tokens: rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) })),
  });
});

// Revoking takes effect on the next request: authenticateAgent reads the row
// every time. Another account's token, an unknown id and an already revoked
// one all answer the same 404.
agentTokens.delete("/:id", async (c) => {
  const user = await requireSessionUser(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const changes = db
    .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(Date.now(), id, user.id).changes;
  if (changes === 0) return c.json({ error: "not found" }, 404);
  writes.delete(id);
  return c.json({ ok: true });
});
