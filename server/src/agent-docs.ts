// Documents an agent token may touch (docs/mobile/AGENT-LINKS-CONTRACT.md).
//
// The one rule: a token creates documents, and reads and updates only
// documents its own user owns that were created by an agent
// (origin_kind = 'agent'). Every other document id, whether it belongs to
// the same user, to someone else, was deleted or never existed, answers the
// same 404 with the same body. A leaked token exposes what agents wrote and
// nothing else in the drive, and cannot be used to learn which ids exist.
//
// The REST routes here and the hosted MCP tools (mcp-server.ts) share these
// functions, so the two surfaces cannot drift apart on a check.
import { Hono, type Context } from "hono";
import crypto from "node:crypto";
import { openDatabase } from "./db.ts";
import { quotaRefusal, storageQuotaBytes, type QuotaRefusal } from "./quota.ts";
import { writeDocVersion } from "./docs.ts";
import { authenticateAgent, takeAgentWrite, type AgentPrincipal } from "./agent-tokens.ts";
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

function checkQuota(ownerId: string, growth: number): AgentFailure | null {
  if (storageQuotaBytes() === null) return null;
  const refusal: QuotaRefusal | null = quotaRefusal(db, ownerId, growth);
  return refusal ? { ok: false, status: 413, body: { ...refusal } } : null;
}

/**
 * Count one write attempt against the token's hourly budget, or refuse it.
 * Callers charge before they parse or check anything, so a refused write
 * costs the same as an accepted one. The create and update operations below
 * do not charge on their own: each surface charges exactly once per request.
 */
export function chargeAgentWrite(agent: AgentPrincipal): AgentFailure | null {
  const wait = takeAgentWrite(agent.tokenId);
  if (wait === null) return null;
  return { ...fail(429, "rate limited", "This agent token has made 60 writes in the last hour. Try again later.", { retryAfter: wait }), retryAfter: wait };
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

/** The row, only when it is inside the rule. Every other case is undefined. */
function ownAgentDoc(agent: AgentPrincipal, id: unknown): AgentDocRow | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return db
    .prepare(
      `SELECT id, name, format, version, content, created_at, updated_at, origin_kind, origin_agent
       FROM docs
       WHERE id = ? AND owner_id = ? AND origin_kind = 'agent' AND deleted_at IS NULL`
    )
    .get(id, agent.userId) as AgentDocRow | undefined;
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

function write(args: { id: string; ownerId: string; name: string; content: string; version: number; origin?: DocOrigin }): AgentFailure | null {
  try {
    writeDocVersion({ ...args, hash: sha256Hex(args.content), now: new Date().toISOString() });
    return null;
  } catch (err) {
    console.error("agent document write failed:", err);
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
  const overQuota = checkQuota(agent.userId, Buffer.byteLength(input.content, "utf8"));
  if (overQuota) return overQuota;
  const id = crypto.randomUUID();
  const origin: DocOrigin = { kind: "agent", agent: cleanAgentName(input.agent) ?? agent.name };
  const failed = write({ id, ownerId: agent.userId, name: named.name, content: input.content, version: 1, origin });
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
  const overQuota = checkQuota(agent.userId, Buffer.byteLength(input.content, "utf8") - Buffer.byteLength(row.content, "utf8"));
  if (overQuota) return overQuota;
  const version = row.version + 1;
  const failed = write({ id: row.id, ownerId: agent.userId, name, content: input.content, version });
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
       FROM docs
       WHERE owner_id = ? AND origin_kind = 'agent' AND deleted_at IS NULL
       ORDER BY updated_at DESC, id ASC LIMIT ?`
    )
    .all(agent.userId, limit) as Omit<AgentDocRow, "content">[];
  const result: AgentResult<{ docs: ReturnType<typeof meta>[] }> = { ok: true, status: 200, data: { docs: rows.map(meta) } };
  return result;
}

export function readAgentDoc(agent: AgentPrincipal, id: unknown) {
  const row = ownAgentDoc(agent, id);
  if (!row) return notFound();
  const { content, ...rest } = row;
  const result: AgentResult<ReturnType<typeof meta> & { content: string }> = { ok: true, status: 200, data: { ...meta(rest), content } };
  return result;
}

// ---- REST routes (Authorization: Bearer mk_agent_…) ------------------------

export const agentDocsApi = new Hono();

agentDocsApi.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

export const UNAUTHORIZED_CHALLENGE = 'Bearer realm="markie"';

function requireAgent(c: Context): AgentPrincipal | Response {
  const agent = authenticateAgent(c.req.raw.headers);
  if (agent) return agent;
  c.header("WWW-Authenticate", UNAUTHORIZED_CHALLENGE);
  return c.json({ error: "unauthorized", message: "Send an agent token: Authorization: Bearer mk_agent_..." }, 401);
}

function answer<T>(c: Context, result: AgentResult<T>): Response {
  if (result.ok) return c.json(result.data as object, result.status);
  if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
  return c.json(result.body, result.status);
}

// The body is read only after the token checks out, so a caller without one
// never has a body buffered on its behalf.
async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const badJson = (c: Context) => c.json({ error: "bad request", message: "Send a JSON object." }, 400);

agentDocsApi.post("/docs", async (c) => {
  const agent = requireAgent(c);
  if (agent instanceof Response) return agent;
  const limited = chargeAgentWrite(agent);
  if (limited) return answer(c, limited);
  const body = await jsonBody(c);
  if (!body) return badJson(c);
  return answer(c, createAgentDoc(agent, body));
});

agentDocsApi.put("/docs/:id", async (c) => {
  const agent = requireAgent(c);
  if (agent instanceof Response) return agent;
  const limited = chargeAgentWrite(agent);
  if (limited) return answer(c, limited);
  const body = await jsonBody(c);
  if (!body) return badJson(c);
  return answer(c, updateAgentDoc(agent, c.req.param("id"), body));
});

agentDocsApi.get("/docs", (c) => {
  const agent = requireAgent(c);
  if (agent instanceof Response) return agent;
  return answer(c, listAgentDocs(agent, c.req.query("limit")));
});

agentDocsApi.get("/docs/:id", (c) => {
  const agent = requireAgent(c);
  if (agent instanceof Response) return agent;
  return answer(c, readAgentDoc(agent, c.req.param("id")));
});
