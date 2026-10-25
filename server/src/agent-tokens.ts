// Per-user agent tokens: how a remote agent (no desktop app nearby) writes
// documents into someone's Markie Cloud. See docs/mobile/AGENT-LINKS-CONTRACT.md.
//
// A token is `mk_agent_` + 32 random bytes in base64url. Only its SHA-256 is
// stored, so a copy of the database is not a set of working tokens, and the
// token itself is shown to its owner exactly once, in the response that made
// it.
//
// What a token can do is deliberately small (agent-docs.ts): create
// documents, and read and update only the documents that same token created.
// It can never reach the rest of the drive, and it can never manage tokens:
// the routes here take a signed-in session and refuse an agent token
// outright, so a leaked token cannot mint itself a successor. Minting one
// emails the account, and a password reset or change revokes them all
// (agent-token-store.ts, called from auth.ts).
import { Hono, type Context } from "hono";
import crypto from "node:crypto";
import { openDatabase } from "./db.ts";
import { auth } from "./auth.ts";
import { sendEmail } from "./email.ts";
import { cleanAgentName } from "./doc-meta.ts";
// Creates the agent_tokens table.
import "./agent-token-store.ts";

const db = openDatabase();

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

// ---- write rate limit and budget -------------------------------------------
//
// Three limits, as sliding windows kept in memory. The server is one process
// on one SQLite file, so memory is the whole picture, and a restart forgiving
// a window's count is a cost worth not adding a table for.
//
//   60 writes an hour per token.
//   200 writes an hour per user, across all of that user's tokens, so minting
//   more tokens buys no more writes.
//   50 MB of written content a day per user, across all tokens, so a leaked
//   token cannot grow the account without bound inside the storage quota.
//
// Every authenticated write attempt counts against the two write counts,
// accepted or not, so a loop of refused writes is throttled like a loop of
// accepted ones. Only content actually written counts against the bytes.

export const WRITES_PER_HOUR = 60;
export const USER_WRITES_PER_HOUR = 200;
export const USER_BYTES_PER_DAY = 50 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const tokenWrites = new Map<string, number[]>();
const userWrites = new Map<string, number[]>();
const userBytes = new Map<string, { at: number; bytes: number }[]>();

/**
 * Why a write may not go ahead. `token` is this token's own count, which its
 * holder may be told about. `account` is the user's budget across every token,
 * and says nothing more, because the rest of it is other agents' usage.
 */
export type WriteRefusal = { scope: "token"; retryAfter: number } | { scope: "account" };

/** Null when the write may go ahead (and is counted), else why not. */
export function takeAgentWrite(agent: { tokenId: string; userId: string }, now = Date.now()): WriteRefusal | null {
  const mine = (tokenWrites.get(agent.tokenId) ?? []).filter((at) => at > now - HOUR_MS);
  const account = (userWrites.get(agent.userId) ?? []).filter((at) => at > now - HOUR_MS);
  tokenWrites.set(agent.tokenId, mine);
  userWrites.set(agent.userId, account);
  if (mine.length >= WRITES_PER_HOUR) {
    return { scope: "token", retryAfter: Math.max(1, Math.ceil((mine[0] + HOUR_MS - now) / 1000)) };
  }
  if (account.length >= USER_WRITES_PER_HOUR) return { scope: "account" };
  mine.push(now);
  account.push(now);
  return null;
}

/** Whether `bytes` more written content fits the user's daily budget. Nothing is counted. */
export function agentBytesFit(userId: string, bytes: number, now = Date.now()): boolean {
  const recent = (userBytes.get(userId) ?? []).filter((w) => w.at > now - DAY_MS);
  userBytes.set(userId, recent);
  return recent.reduce((sum, w) => sum + w.bytes, 0) + bytes <= USER_BYTES_PER_DAY;
}

/** Count content that was written against the user's daily budget. */
export function recordAgentBytes(userId: string, bytes: number, now = Date.now()): void {
  const recent = userBytes.get(userId) ?? [];
  recent.push({ at: now, bytes });
  userBytes.set(userId, recent);
}

/** Test seam. */
export function resetAgentWriteLimitsForTests(): void {
  tokenWrites.clear();
  userWrites.clear();
  userBytes.clear();
}

// ---- management routes (session only) -------------------------------------

export const agentTokens = new Hono();

// Every answer here is about one person's credentials.
agentTokens.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

async function requireSessionUser(c: Context): Promise<{ id: string; email: string | null } | Response> {
  // Refused before the session lookup, so it holds whatever else the request
  // carries: an agent token never manages tokens, its own included.
  if (presentsAgentToken(c.req.raw.headers)) {
    return c.json({ error: "forbidden", message: "Agent tokens cannot manage agent tokens. Sign in to Markie to do this." }, 403);
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "unauthorized" }, 401);
  return { id: session.user.id, email: session.user.email || null };
}

// Minting a token is the moment a stolen session turns into lasting access,
// so the account hears about every one. The token's name is the only thing
// from the request in it, and it goes in the plain-text body only. A send
// that fails never undoes or delays the mint: it is logged and dropped.
export function mintNotice(name: string, createdAt: Date): { subject: string; text: string } {
  return {
    subject: "A new agent token was created for your Markie account",
    text: [
      `A new agent token named "${name}" was created for your Markie account on ${createdAt.toUTCString()}.`,
      "",
      "An agent holding it can create private documents in your Markie Cloud, and read and update the documents it created. It cannot open anything else.",
      "",
      "If you made it, there is nothing to do. If you did not, revoke it in Markie under Remote agents, and change your password, which revokes every agent token.",
    ].join("\n"),
  };
}

function sendMintNotice(email: string | null, name: string, createdAt: number): void {
  if (!email) return;
  sendEmail({ to: email, ...mintNotice(name, new Date(createdAt)) }).catch((err) => {
    console.error("agent token notice failed:", err);
  });
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
  sendMintNotice(user.email, name, createdAt);
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
// every time. Revoking one already revoked answers the same 204, so a retry
// is harmless; an id that never belonged to this user (another account's
// token included) answers 404. The token's documents stay the user's, and no
// token reaches them again (agent-docs.ts).
agentTokens.delete("/:id", async (c) => {
  const user = await requireSessionUser(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  const row = db.prepare("SELECT revoked_at FROM agent_tokens WHERE id = ? AND user_id = ?").get(id, user.id) as
    | { revoked_at: number | null }
    | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.revoked_at === null) {
    db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(Date.now(), id, user.id);
  }
  tokenWrites.delete(id);
  return c.body(null, 204);
});
