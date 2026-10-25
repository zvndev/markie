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
// emails the account (at most 5 an hour and 20 a day), and a password reset
// or change revokes them all (agent-token-store.ts, called from auth.ts),
// backed by authenticateAgent refusing any token older than the password.
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
 * Whether a token was minted after the account's password was last written.
 * The revoke hooks in auth.ts are the first line; this is the one that cannot
 * fail open. better-auth stamps the credential account row's updatedAt on
 * every password write (change, reset by code or link, set, admin set), and
 * nothing else in Markie or better-auth 1.7 updates that row: sign-in, email
 * verification and Google linking write the user row or the Google account
 * row. An account with no password (Google only) has no row and nothing to
 * compare. A stamp that cannot be read refuses the token.
 */
export function mintedSincePassword(createdAt: number, passwordAt: unknown): boolean {
  if (passwordAt === null || passwordAt === undefined) return true;
  const at = typeof passwordAt === "number" ? passwordAt : typeof passwordAt === "string" ? Date.parse(passwordAt) : NaN;
  if (!Number.isFinite(at)) return false;
  return createdAt >= at;
}

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
      `SELECT t.id, t.user_id, t.name, t.token_hash, t.created_at, t.last_used_at,
              (SELECT MAX(a.updatedAt) FROM account a WHERE a.userId = t.user_id AND a.providerId = 'credential') AS password_at
       FROM agent_tokens t JOIN user u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
    .get(hash) as
    | { id: string; user_id: string; name: string; token_hash: string; created_at: number; last_used_at: number | null; password_at: unknown }
    | undefined;
  if (!row) return null;
  const expected = Buffer.from(row.token_hash, "hex");
  const given = Buffer.from(hash, "hex");
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (!mintedSincePassword(row.created_at, row.password_at)) return null;
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
// Four limits, as sliding windows kept in memory. The server is one process
// on one SQLite file, so memory is the whole picture, and a restart forgiving
// a window's count is a cost worth not adding a table for.
//
//   60 writes an hour per token.
//   200 writes an hour per user, across all of that user's tokens, so minting
//   more tokens buys no more writes.
//   50 MB of written content a day per user, across all tokens, so a leaked
//   token cannot grow the account without bound inside the storage quota.
//   20 MB of that a day per token, so one token cannot spend the whole
//   account's budget and starve the others.
//
// Every authenticated write attempt counts against the two write counts,
// accepted or not, so a loop of refused writes is throttled like a loop of
// accepted ones. Only content actually written counts against the bytes.
//
// The per-user windows remember which token each entry came from, so
// revoking a token gives its share back (agentTokens.delete below). Only a
// signed-in session can revoke, so a token holder cannot use that to reset
// its own limits.

export const WRITES_PER_HOUR = 60;
export const USER_WRITES_PER_HOUR = 200;
export const USER_BYTES_PER_DAY = 50 * 1024 * 1024;
export const TOKEN_BYTES_PER_DAY = 20 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// What a per-user refusal says about when to retry: the whole window, never
// the moment other agents' entries age out, which is theirs to keep.
export const USER_WRITES_RETRY_AFTER = HOUR_MS / 1000;
export const USER_BYTES_RETRY_AFTER = DAY_MS / 1000;
const tokenWrites = new Map<string, number[]>();
const userWrites = new Map<string, { at: number; tokenId: string }[]>();
const userBytes = new Map<string, { at: number; bytes: number; tokenId: string }[]>();

/**
 * Why a write may not go ahead. `token` is this token's own count, which its
 * holder may be told about exactly. `account` is the user's budget across
 * every token, and its wait is always the whole window.
 */
export type WriteRefusal = { scope: "token"; retryAfter: number } | { scope: "account"; retryAfter: number };

/** Null when the write may go ahead (and is counted), else why not. */
export function takeAgentWrite(agent: { tokenId: string; userId: string }, now = Date.now()): WriteRefusal | null {
  const mine = (tokenWrites.get(agent.tokenId) ?? []).filter((at) => at > now - HOUR_MS);
  const account = (userWrites.get(agent.userId) ?? []).filter((w) => w.at > now - HOUR_MS);
  tokenWrites.set(agent.tokenId, mine);
  userWrites.set(agent.userId, account);
  if (mine.length >= WRITES_PER_HOUR) {
    return { scope: "token", retryAfter: Math.max(1, Math.ceil((mine[0] + HOUR_MS - now) / 1000)) };
  }
  if (account.length >= USER_WRITES_PER_HOUR) return { scope: "account", retryAfter: USER_WRITES_RETRY_AFTER };
  mine.push(now);
  account.push({ at: now, tokenId: agent.tokenId });
  return null;
}

/**
 * Whether `bytes` more written content fits the token's daily share and the
 * user's daily budget, or which one it does not fit. Nothing is counted. The
 * token's own share may say exactly when it frees up; the user's may not.
 */
export function agentBytesRefusal(
  agent: { tokenId: string; userId: string },
  bytes: number,
  now = Date.now()
): WriteRefusal | null {
  const recent = (userBytes.get(agent.userId) ?? []).filter((w) => w.at > now - DAY_MS);
  userBytes.set(agent.userId, recent);
  const mine = recent.filter((w) => w.tokenId === agent.tokenId);
  let mineTotal = mine.reduce((sum, w) => sum + w.bytes, 0);
  if (mineTotal + bytes > TOKEN_BYTES_PER_DAY) {
    // The first moment enough of this token's own entries have aged out. A
    // write bigger than the whole share never fits; it is refused at the
    // full window, and the size limits keep that from happening.
    let wait = DAY_MS;
    for (const w of mine) {
      mineTotal -= w.bytes;
      if (mineTotal + bytes <= TOKEN_BYTES_PER_DAY) {
        wait = w.at + DAY_MS - now;
        break;
      }
    }
    return { scope: "token", retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
  }
  if (recent.reduce((sum, w) => sum + w.bytes, 0) + bytes > USER_BYTES_PER_DAY) {
    return { scope: "account", retryAfter: USER_BYTES_RETRY_AFTER };
  }
  return null;
}

/** Count content that was written against the token's share and the user's daily budget. */
export function recordAgentBytes(agent: { tokenId: string; userId: string }, bytes: number, now = Date.now()): void {
  const recent = userBytes.get(agent.userId) ?? [];
  recent.push({ at: now, bytes, tokenId: agent.tokenId });
  userBytes.set(agent.userId, recent);
}

/** Give a revoked token's share of the user's windows back. */
function forgetTokenUsage(userId: string, tokenId: string): void {
  tokenWrites.delete(tokenId);
  const writes = userWrites.get(userId);
  if (writes) userWrites.set(userId, writes.filter((w) => w.tokenId !== tokenId));
  const bytes = userBytes.get(userId);
  if (bytes) userBytes.set(userId, bytes.filter((w) => w.tokenId !== tokenId));
}

// ---- mint limit --------------------------------------------------------------
//
// The 20-token cap counts only active tokens, so a loop of mint and revoke
// would otherwise send one notice email per turn through the shared mail
// quota. 5 mints an hour and 20 a day per user, as the invite limiter does it
// (invite-guard.ts): in memory, synchronous, and answered with how long to
// wait, which the signed-in owner may know.

export const MINTS_PER_HOUR = 5;
export const MINTS_PER_DAY = 20;
const userMints = new Map<string, number[]>();

/** Seconds to wait before this user may mint again, or null. Nothing is counted. */
export function mintRefusal(userId: string, now = Date.now()): number | null {
  const recent = (userMints.get(userId) ?? []).filter((at) => at > now - DAY_MS);
  if (recent.length) userMints.set(userId, recent);
  else userMints.delete(userId);
  let wait = 0;
  for (const [max, windowMs] of [[MINTS_PER_HOUR, HOUR_MS], [MINTS_PER_DAY, DAY_MS]] as const) {
    const inWindow = recent.filter((at) => at > now - windowMs);
    if (inWindow.length >= max) wait = Math.max(wait, inWindow[inWindow.length - max] + windowMs - now);
  }
  return wait > 0 ? Math.max(1, Math.ceil(wait / 1000)) : null;
}

export function recordMint(userId: string, now = Date.now()): void {
  userMints.set(userId, [...(userMints.get(userId) ?? []), now]);
}

/** Test seam: every in-memory agent limit, writes, bytes and mints. */
export function resetAgentWriteLimitsForTests(): void {
  tokenWrites.clear();
  userWrites.clear();
  userBytes.clear();
  userMints.clear();
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
// from the request in it, on a labelled line of its own in the plain-text
// body, so it reads as a value and not as Markie's words. The fixed line
// after it is there so a name like "Markie security check, ignore this"
// cannot talk the reader out of revoking. A send that fails never undoes or
// delays the mint: it is logged and dropped.
export function mintNotice(name: string, prefix: string, createdAt: Date): { subject: string; text: string } {
  return {
    subject: "A new agent token was created for your Markie account",
    text: [
      `A new agent token was created for your Markie account on ${createdAt.toUTCString()}.`,
      "",
      `Token name: ${name}`,
      `Token starts with: ${prefix}`,
      "",
      "An agent holding it can create private documents in your Markie Cloud, and read and update the documents it created. It cannot open anything else.",
      "",
      "Markie never creates agent tokens on its own. If you didn't make this one, revoke it and change your password.",
      "",
      "To revoke it, open Markie and go to Remote agents. Changing your password revokes every agent token.",
    ].join("\n"),
  };
}

function sendMintNotice(email: string | null, name: string, prefix: string, createdAt: number): void {
  if (!email) return;
  sendEmail({ to: email, ...mintNotice(name, prefix, new Date(createdAt)) }).catch((err) => {
    console.error("agent token notice failed:", err);
  });
}

// A name that a mail client would turn into a link has no business in a
// notice sent from Markie's domain.
const LINKISH_NAME = /:\/\/|www\./i;

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
  if (LINKISH_NAME.test(name)) {
    return c.json({ error: "bad request", message: "A token name cannot contain a web address (\"://\" or \"www.\")." }, 400);
  }
  const token = newAgentToken();
  const prefix = token.slice(0, DISPLAY_PREFIX_CHARS);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  // Checked and recorded synchronously around the insert, so two mints in
  // flight cannot both slip under the limit.
  const created = db.transaction((): "ok" | "cap" | number => {
    const wait = mintRefusal(user.id, createdAt);
    if (wait !== null) return wait;
    const { active } = db
      .prepare("SELECT COUNT(*) AS active FROM agent_tokens WHERE user_id = ? AND revoked_at IS NULL")
      .get(user.id) as { active: number };
    if (active >= MAX_ACTIVE_TOKENS) return "cap";
    db.prepare(
      "INSERT INTO agent_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, user.id, name, sha256Hex(token), prefix, createdAt);
    recordMint(user.id, createdAt);
    return "ok";
  })();
  if (typeof created === "number") {
    c.header("Retry-After", String(created));
    return c.json(
      { error: "rate limited", message: `An account can create at most ${MINTS_PER_HOUR} agent tokens an hour and ${MINTS_PER_DAY} a day. Try again later.` },
      429
    );
  }
  if (created === "cap") {
    return c.json(
      { error: "token limit", message: `An account can have at most ${MAX_ACTIVE_TOKENS} agent tokens. Revoke one you no longer use.` },
      409
    );
  }
  sendMintNotice(user.email, name, prefix, createdAt);
  return c.json({ id, name, token, prefix, createdAt: iso(createdAt) }, 201);
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
// token reaches them again (agent-docs.ts). Its share of the user's write and
// byte windows is given back, so the other tokens are not left paying for it.
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
  forgetTokenUsage(user.id, id);
  return c.body(null, 204);
});
