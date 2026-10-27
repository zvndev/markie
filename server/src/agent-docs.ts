// Documents an agent token may touch (docs/mobile/AGENT-LINKS-CONTRACT.md).
//
// The one rule: a token creates documents, and reads and updates only the
// documents that same token created (docs.origin_token_id is its id, the
// owner is its user, and the document is not deleted). Every other document
// id answers the same 404 with the same body: the user's app documents,
// documents a local agent synced through the desktop bridge (origin_kind is
// 'agent' for the badge, but origin_token_id is NULL), documents the user's
// other tokens made, anyone else's, deleted ones and ids that never existed.
// A leaked token exposes the documents it created, and edits the owner makes
// to them while they stay private, and cannot be used to learn which ids
// exist. A revoked token's documents stay the user's and no
// token reaches them again: origin_token_id never changes after creation.
//
// A document someone else can read (a member, a pending invite or a public
// link) is closed to tokens. Writes answer 409 "shared", so the agent is told
// to make a new document instead. Reads answer the same 404 as every other
// unreachable id, and the list leaves it out: once the owner has shared it,
// what is in it may be other people's words, and a leaked token must not
// carry them off. While it stays private, the token still reads edits the
// owner makes, because annotating a document for the agent is the workflow.
//
// The REST routes here and the hosted MCP tools (mcp-server.ts) share these
// functions, so the two surfaces cannot drift apart on a check.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import crypto from "node:crypto";
import { openDatabase } from "./db.ts";
import { quotaRefusal, storageQuotaBytes } from "./quota.ts";
import { writeDocVersion } from "./docs.ts";
import { AUDIENCE_SQL, hasAudience } from "./shares.ts";
import {
  TOKEN_BYTES_PER_DAY,
  USER_BYTES_PER_DAY,
  USER_WRITES_PER_HOUR,
  WRITES_PER_HOUR,
  agentBytesRefusal,
  authenticateAgent,
  recordAgentBytes,
  takeAgentWrite,
  type AgentPrincipal,
} from "./agent-tokens.ts";
import {
  AGENT_EXTENSIONS,
  agentExtensionAllowed,
  cleanAgentName,
  formatForName,
  markdownLinkFor,
  originOf,
  privateLinkFor,
  type DocOrigin,
} from "./doc-meta.ts";
import { FAULT_ROUTES, reportFault } from "./little-friend.ts";

const db = openDatabase();

// The Darkmown compiler's own source limit (src/lib/darkmown/compiler-types.ts
// DARKMOWN_SOURCE_LIMIT), in UTF-16 code units as it counts them. A longer
// .wd would land in the cloud and then refuse to run on every device.
export const DARKMOWN_SOURCE_LIMIT = 128_000;
export const AGENT_DOC_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_LIST_DEFAULT = 50;
export const AGENT_LIST_MAX = 100;
const NAME_MAX = 255;

export const PASTE_INSTRUCTION =
  "Paste markdownLink into your reply. It opens in Markie on the user's phone, or in a browser after they sign in.";

export type AgentFailure = {
  ok: false;
  status: 400 | 404 | 409 | 413 | 429 | 503;
  body: { error: string; message?: string } & Record<string, unknown>;
  retryAfter?: number;
};
export type AgentResult<T> = { ok: true; status: 200 | 201; data: T } | AgentFailure;

const fail = (status: AgentFailure["status"], error: string, message?: string, extra: Record<string, unknown> = {}): AgentFailure => ({
  ok: false,
  status,
  body: { error, ...(message ? { message } : {}), ...extra },
});

// The one answer for every id outside the rule. Built fresh each time so no
// caller can decorate a shared object and make one 404 differ from another.
const notFound = (): AgentFailure => fail(404, "not found");

const sha256Hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A document name an agent may use, or the reason it may not. */
function checkName(raw: unknown): { name: string } | AgentFailure {
  if (typeof raw !== "string") return fail(400, "bad request", "name is required.");
  const name = raw.trim();
  if (!name || Array.from(name).length > NAME_MAX || UNPRINTABLE.test(name) || /[/\\]/.test(name)) {
    return fail(400, "bad request", `name must be a file name of 1 to ${NAME_MAX} printable characters, with no slashes.`);
  }
  if (!agentExtensionAllowed(name)) {
    return fail(400, "bad request", `Only ${AGENT_EXTENSIONS.join(", ")} documents can be written with an agent token.`);
  }
  return { name };
}

function checkSize(name: string, content: string): AgentFailure | null {
  if (formatForName(name) === "darkmown") {
    if (content.length > DARKMOWN_SOURCE_LIMIT) {
      return fail(413, "too large", `A Darkmown (.wd) document can be at most ${DARKMOWN_SOURCE_LIMIT.toLocaleString("en-US")} characters.`);
    }
  } else if (Buffer.byteLength(content, "utf8") > AGENT_DOC_MAX_BYTES) {
    return fail(413, "too large", "A document written with an agent token can be at most 2 MB.");
  }
  return null;
}

// The storage quota and the daily byte budget, as a token holder hears them:
// the error and a sentence, never the account's usage or its quota. The
// session routes still report usedBytes and quotaBytes to the signed-in
// owner; a token is not the owner.
function checkQuota(ownerId: string, growth: number): AgentFailure | null {
  if (storageQuotaBytes() === null) return null;
  const refusal = quotaRefusal(db, ownerId, growth);
  return refusal ? fail(413, refusal.error, refusal.message) : null;
}

const limited = (message: string, retryAfter: number): AgentFailure => ({ ...fail(429, "rate limited", message), retryAfter });

function checkByteBudget(agent: AgentPrincipal, bytes: number): AgentFailure | null {
  const refused = agentBytesRefusal(agent, bytes);
  if (refused === null) return null;
  if (refused.scope === "account") {
    return limited(`This account's agent tokens can write at most ${USER_BYTES_PER_DAY / (1024 * 1024)} MB of documents a day. Try again tomorrow.`, refused.retryAfter);
  }
  // The token's own share, like its own write count, may say exactly when.
  const wait = refused.retryAfter;
  return {
    ...fail(429, "rate limited", `This agent token can write at most ${TOKEN_BYTES_PER_DAY / (1024 * 1024)} MB of documents a day. Try again later.`, { retryAfter: wait }),
    retryAfter: wait,
  };
}

/**
 * Count one write attempt against the token's hourly limit and the user's
 * hourly budget across all tokens, or refuse it. Callers charge before they
 * parse or check anything, so a refused write costs the same as an accepted
 * one. The create and update operations below do not charge on their own:
 * each surface charges exactly once per request.
 *
 * Only the token's own limit says exactly when to retry. The account's
 * budget is the sum of other agents' work, and how soon it frees up is
 * theirs to keep, so its Retry-After is always the whole hour.
 */
export function chargeAgentWrite(agent: AgentPrincipal): AgentFailure | null {
  const refused = takeAgentWrite(agent);
  if (refused === null) return null;
  if (refused.scope === "account") {
    return limited(`This account's agent tokens can make at most ${USER_WRITES_PER_HOUR} writes an hour between them. Try again later.`, refused.retryAfter);
  }
  const wait = refused.retryAfter;
  return {
    ...fail(429, "rate limited", `This agent token has made ${WRITES_PER_HOUR} writes in the last hour. Try again later.`, { retryAfter: wait }),
    retryAfter: wait,
  };
}

interface AgentDocRow {
  id: string;
  name: string;
  format: string;
  version: number;
  content: string;
  created_at: string | null;
  updated_at: string;
  origin_kind: string;
  origin_agent: string | null;
}

/**
 * The row, only when it is inside the rule. Every other case is undefined.
 * `readable` also leaves out a document with an audience, which a token may
 * no longer read.
 */
function ownAgentDoc(agent: AgentPrincipal, id: unknown, readable = false): AgentDocRow | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return db
    .prepare(
      `SELECT id, name, format, version, content, created_at, updated_at, origin_kind, origin_agent
       FROM docs d
       WHERE id = ? AND owner_id = ? AND origin_token_id = ? AND deleted_at IS NULL${readable ? ` AND NOT ${AUDIENCE_SQL}` : ""}`
    )
    .get(id, agent.userId, agent.tokenId) as AgentDocRow | undefined;
}

const links = (id: string, name: string) => ({ privateLink: privateLinkFor(id), markdownLink: markdownLinkFor(name, id) });

function meta(row: Omit<AgentDocRow, "content">) {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    version: row.version,
    createdAt: row.created_at ?? row.updated_at,
    updatedAt: row.updated_at,
    origin: originOf(row),
    ...links(row.id, row.name),
  };
}

// Everything from the checks to this write is synchronous, and so is SQLite
// here, so no other request can share, write or delete the document between
// a check passing and the write landing.
function write(agent: AgentPrincipal, args: {
  id: string;
  ownerId: string;
  name: string;
  content: string;
  version: number;
  origin?: DocOrigin;
  originTokenId?: string;
}): AgentFailure | null {
  try {
    writeDocVersion({ ...args, hash: sha256Hex(args.content), now: new Date().toISOString() });
    recordAgentBytes(agent, Buffer.byteLength(args.content, "utf8"));
    return null;
  } catch (err) {
    console.error("agent document write failed:", err);
    reportFault(err, FAULT_ROUTES.agentDocWrite);
    return fail(503, "storage-error");
  }
}

// ---- operations ------------------------------------------------------------

export function createAgentDoc(agent: AgentPrincipal, input: { name?: unknown; content?: unknown; agent?: unknown }) {
  const named = checkName(input.name);
  if ("ok" in named) return named;
  if (typeof input.content !== "string") return fail(400, "bad request", "content must be a string.");
  const tooLarge = checkSize(named.name, input.content);
  if (tooLarge) return tooLarge;
  const bytes = Buffer.byteLength(input.content, "utf8");
  const overBudget = checkByteBudget(agent, bytes);
  if (overBudget) return overBudget;
  const overQuota = checkQuota(agent.userId, bytes);
  if (overQuota) return overQuota;
  const id = crypto.randomUUID();
  const origin: DocOrigin = { kind: "agent", agent: cleanAgentName(input.agent) ?? agent.name };
  const failed = write(agent, { id, ownerId: agent.userId, name: named.name, content: input.content, version: 1, origin, originTokenId: agent.tokenId });
  if (failed) return failed;
  const result: AgentResult<{ id: string; name: string; format: string; version: number; privateLink: string; markdownLink: string }> = {
    ok: true,
    status: 201,
    data: { id, name: named.name, format: formatForName(named.name), version: 1, ...links(id, named.name) },
  };
  return result;
}

export function updateAgentDoc(
  agent: AgentPrincipal,
  id: unknown,
  input: { content?: unknown; name?: unknown; baseVersion?: unknown }
) {
  const row = ownAgentDoc(agent, id);
  if (!row) return notFound();
  if (hasAudience(row.id)) {
    return fail(
      409,
      "shared",
      "This document is shared, so an agent token can no longer change it. Create a new document instead, and give the user its link."
    );
  }
  if (typeof input.content !== "string") return fail(400, "bad request", "content must be a string.");
  if (input.baseVersion !== undefined && input.baseVersion !== null) {
    if (typeof input.baseVersion !== "number" || !Number.isInteger(input.baseVersion)) {
      return fail(400, "bad request", "baseVersion must be a whole number.");
    }
    if (input.baseVersion !== row.version) return fail(409, "conflict", "The document changed since that version.", { serverVersion: row.version });
  }
  let name = row.name;
  if (input.name !== undefined && input.name !== null) {
    const named = checkName(input.name);
    if ("ok" in named) return named;
    name = named.name;
  }
  const tooLarge = checkSize(name, input.content);
  if (tooLarge) return tooLarge;
  const bytes = Buffer.byteLength(input.content, "utf8");
  const overBudget = checkByteBudget(agent, bytes);
  if (overBudget) return overBudget;
  const overQuota = checkQuota(agent.userId, bytes - Buffer.byteLength(row.content, "utf8"));
  if (overQuota) return overQuota;
  const version = row.version + 1;
  const failed = write(agent, { id: row.id, ownerId: agent.userId, name, content: input.content, version });
  if (failed) return failed;
  const result: AgentResult<{ id: string; name: string; format: string; version: number; privateLink: string; markdownLink: string }> = {
    ok: true,
    status: 200,
    data: { id: row.id, name, format: formatForName(name), version, ...links(row.id, name) },
  };
  return result;
}

export function listAgentDocs(agent: AgentPrincipal, rawLimit: unknown) {
  let limit = AGENT_LIST_DEFAULT;
  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_LIST_MAX) {
      return fail(400, "bad request", `limit must be a whole number from 1 to ${AGENT_LIST_MAX}.`);
    }
  }
  const rows = db
    .prepare(
      `SELECT id, name, format, version, created_at, updated_at, origin_kind, origin_agent
       FROM docs d
       WHERE owner_id = ? AND origin_token_id = ? AND deleted_at IS NULL AND NOT ${AUDIENCE_SQL}
       ORDER BY updated_at DESC, id ASC LIMIT ?`
    )
    .all(agent.userId, agent.tokenId, limit) as Omit<AgentDocRow, "content">[];
  const result: AgentResult<{ docs: ReturnType<typeof meta>[] }> = { ok: true, status: 200, data: { docs: rows.map(meta) } };
  return result;
}

export function readAgentDoc(agent: AgentPrincipal, id: unknown) {
  const row = ownAgentDoc(agent, id, true);
  if (!row) return notFound();
  const { content, ...rest } = row;
  const result: AgentResult<ReturnType<typeof meta> & { content: string }> = { ok: true, status: 200, data: { ...meta(rest), content } };
  return result;
}

// ---- REST routes (Authorization: Bearer mk_agent_…) ------------------------

export const UNAUTHORIZED_CHALLENGE = 'Bearer realm="markie"';

export type AgentEnv = { Variables: { agent?: AgentPrincipal } };

/**
 * Authenticate the agent token, or answer `refuse`. index.ts runs this ahead
 * of the body limit on /api/agent/* and POST /mcp, so a caller without a live
 * token is answered from its headers alone and no body is read on its behalf,
 * chunked bodies with no Content-Length included (bodyLimit buffers those in
 * full before it can say anything). The routers run it again for when they
 * are mounted on their own; it does nothing when the token is already known.
 */
export function agentAuth(refuse: (c: Context) => Response): MiddlewareHandler {
  // Untyped env so index.ts can run it on its own app; the routers read the
  // variable through AgentEnv.
  return async (c, next) => {
    const ctx = c as unknown as Context<AgentEnv>;
    if (ctx.get("agent")) return next();
    const agent = authenticateAgent(c.req.raw.headers);
    if (!agent) {
      c.header("WWW-Authenticate", UNAUTHORIZED_CHALLENGE);
      return refuse(c);
    }
    ctx.set("agent", agent);
    return next();
  };
}

export const restAgentAuth = agentAuth((c) =>
  c.json({ error: "unauthorized", message: "Send an agent token: Authorization: Bearer mk_agent_..." }, 401)
);

export const agentDocsApi = new Hono<AgentEnv>();

agentDocsApi.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});
agentDocsApi.use("*", restAgentAuth);

// Set by restAgentAuth, which answered already when there was no token.
const agentOf = (c: Context<AgentEnv>): AgentPrincipal => c.get("agent")!;

function answer<T>(c: Context, result: AgentResult<T>): Response {
  if (result.ok) return c.json(result.data as object, result.status);
  if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
  return c.json(result.body, result.status);
}

// Reached only with a live token (restAgentAuth), so the body is never read
// for a caller without one.
async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const badJson = (c: Context) => c.json({ error: "bad request", message: "Send a JSON object." }, 400);

agentDocsApi.post("/docs", async (c) => {
  const agent = agentOf(c);
  const limited = chargeAgentWrite(agent);
  if (limited) return answer(c, limited);
  const body = await jsonBody(c);
  if (!body) return badJson(c);
  return answer(c, createAgentDoc(agent, body));
});

agentDocsApi.put("/docs/:id", async (c) => {
  const agent = agentOf(c);
  const limited = chargeAgentWrite(agent);
  if (limited) return answer(c, limited);
  const body = await jsonBody(c);
  if (!body) return badJson(c);
  return answer(c, updateAgentDoc(agent, c.req.param("id"), body));
});

agentDocsApi.get("/docs", (c) => {
  return answer(c, listAgentDocs(agentOf(c), c.req.query("limit")));
});

agentDocsApi.get("/docs/:id", (c) => {
  return answer(c, readAgentDoc(agentOf(c), c.req.param("id")));
});
