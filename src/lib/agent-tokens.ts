// Agent tokens: the credential a remote agent (one with no Markie app nearby)
// uses against the hosted MCP endpoint. Managed with the signed-in session over
// the server's /api/agent-tokens routes; a token can never manage tokens.
//
// Nothing here stores a token or writes one anywhere. The one time the server
// returns the full token is handed to the caller, which keeps it in component
// state for as long as its panel is open.
import { getServerURL } from "@/lib/auth-client";
import { serverFetch } from "@/lib/server-sessions";

export interface AgentToken {
  id: string;
  name: string;
  /** The first characters of the token, enough to tell two apart. */
  prefix: string;
  createdAt: string | number | null;
  lastUsedAt: string | number | null;
}

export interface CreatedAgentToken {
  id: string;
  name: string;
  /** The whole token. Shown once, never listed again. */
  token: string;
  prefix: string;
  createdAt: string | number | null;
}

export type TokenResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export const AGENT_TOKEN_NAME_MAX = 64;

/** The hosted MCP endpoint of the server the user is signed in to. */
export function hostedMcpUrl(origin: string = getServerURL()): string {
  return `${origin.replace(/\/+$/, "")}/mcp`;
}

export function claudeCodeSetupCommand(url: string, token: string): string {
  return `claude mcp add --transport http markie-cloud ${url} --header "Authorization: Bearer ${token}"`;
}

export function genericMcpConfig(url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { "markie-cloud": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2
  );
}

/**
 * The server answered the list or create route with "no such route": it is an
 * older build, or a self-hosted one, without agent tokens. Never true of a
 * DELETE, where a 404 means the token is already gone.
 */
export function offersNoAgentTokens(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function refusal(status: number, body: unknown): string {
  if (status === 0) return "Markie Cloud could not be reached. Check your connection and try again.";
  if (status === 401) return "Your Markie Cloud sign-in has expired. Sign in again to manage agent tokens.";
  if (offersNoAgentTokens(status)) return "This server does not offer agent tokens.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  // The server's own words for a rule the user can act on (a name that is too
  // long, the limit of active tokens). Never a body that might echo a secret.
  const text = body && typeof body === "object" ? (body as { error?: unknown; message?: unknown }) : null;
  const said = typeof text?.message === "string" ? text.message : typeof text?.error === "string" ? text.error : "";
  if (status === 400 || status === 409 || status === 422) {
    if (said && said.length <= 160 && !said.includes("mk_agent_")) return said;
  }
  return `Markie Cloud refused (${status}).`;
}

async function call<T>(path: string, init: RequestInit, read: (data: unknown) => T | null): Promise<TokenResult<T>> {
  let res: Response;
  try {
    res = await serverFetch(getServerURL(), path, init);
  } catch {
    return { ok: false, status: 0, message: refusal(0, null) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, message: refusal(res.status, body) };
  const data = read(body);
  if (data === null) return { ok: false, status: res.status, message: "Markie Cloud sent an answer Markie could not read." };
  return { ok: true, data };
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const when = (v: unknown): string | number | null => (typeof v === "string" || typeof v === "number" ? v : null);

export function listAgentTokens(): Promise<TokenResult<AgentToken[]>> {
  return call("/api/agent-tokens", { method: "GET" }, (body) => {
    const tokens = (body as { tokens?: unknown } | null)?.tokens;
    if (!Array.isArray(tokens)) return null;
    return tokens.flatMap((t): AgentToken[] => {
      const row = t as Record<string, unknown> | null;
      if (!row || !str(row.id) || !str(row.name)) return [];
      return [{ id: row.id, name: row.name, prefix: typeof row.prefix === "string" ? row.prefix : "", createdAt: when(row.createdAt), lastUsedAt: when(row.lastUsedAt) }];
    });
  });
}

export function createAgentToken(name: string): Promise<TokenResult<CreatedAgentToken>> {
  return call("/api/agent-tokens", { method: "POST", body: JSON.stringify({ name }) }, (body) => {
    const row = body as Record<string, unknown> | null;
    if (!row || !str(row.id) || !str(row.token)) return null;
    return { id: row.id, name: typeof row.name === "string" ? row.name : name, token: row.token, prefix: typeof row.prefix === "string" ? row.prefix : "", createdAt: when(row.createdAt) };
  });
}

// The contract answers 204 for a revoke, also for a token that was already
// revoked, and 404 only for an id that never belonged to this user. Either way
// the token is not one this account holds any more, so the row goes: a 404
// here is "gone", never "this server has no agent tokens" (that reading is for
// the list and create routes, where the route itself is missing).
export async function revokeAgentToken(id: string): Promise<TokenResult<true>> {
  const res = await call(`/api/agent-tokens/${encodeURIComponent(id)}`, { method: "DELETE" }, () => true as const);
  if (!res.ok && res.status === 404) return { ok: true, data: true };
  return res;
}
