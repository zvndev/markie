// What a markdown document is and where it came from, and the link that names
// it. Shared by the session routes (docs.ts), the agent routes (agent-docs.ts)
// and the hosted MCP (mcp-server.ts), so the three can never disagree about a
// document's format or its link. See docs/mobile/AGENT-LINKS-CONTRACT.md.
import { deployment, CLOUD_API_ORIGIN, CLOUD_API_ORIGINS } from "./deployment.ts";

export type DocFormat = "markdown" | "darkmown" | "text";
export type OriginKind = "app" | "agent";
export interface DocOrigin {
  kind: OriginKind;
  agent: string | null;
}

export const APP_ORIGIN: DocOrigin = { kind: "app", agent: null };
// What an agent-made document is called when the agent gave no usable name.
// The desktop bridge sends the same words when its MCP client has no name.
export const UNNAMED_AGENT = "an agent";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** The format a document's name implies. Anything unrecognised is markdown, as every document was before formats existed. */
export function formatForName(name: string): DocFormat {
  const ext = extensionOf(name);
  if (ext === ".wd") return "darkmown";
  if (ext === ".txt" || ext === ".text" || ext === ".log") return "text";
  return "markdown";
}

// The same rule as formatForName, in SQL, for backfilling rows written before
// the column existed. Kept beside it so the two are read together.
export const FORMAT_FROM_NAME_SQL = `CASE
  WHEN lower(name) LIKE '_%.wd' THEN 'darkmown'
  WHEN lower(name) LIKE '_%.txt' OR lower(name) LIKE '_%.text' OR lower(name) LIKE '_%.log' THEN 'text'
  ELSE 'markdown' END`;

// Extensions an agent token may create or rename to. Everything an agent can
// write is something the phone and the web view can show.
export const AGENT_EXTENSIONS = [".md", ".markdown", ".mdx", ".wd", ".txt"] as const;
export function agentExtensionAllowed(name: string): boolean {
  return (AGENT_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

// Control, format (bidi overrides, zero-width), surrogate, private-use and
// unassigned code points, and the line and paragraph separators. None of them
// belong in a name that is shown to a person.
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * An agent's display name as stored in docs.origin_agent: printable
 * characters only, whitespace collapsed and trimmed, at most 64 characters.
 * Null when nothing usable is left, so the caller picks the fallback.
 */
export function cleanAgentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(UNPRINTABLE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, 64).join("").trim() || null;
}

/** The origin a session PUT asked for, honoured only on creation by the caller. */
export function requestedOrigin(raw: unknown): DocOrigin {
  if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "agent") return APP_ORIGIN;
  return { kind: "agent", agent: cleanAgentName((raw as { agent?: unknown }).agent) ?? UNNAMED_AGENT };
}

export function originOf(row: { origin_kind?: string | null; origin_agent?: string | null }): DocOrigin {
  return row.origin_kind === "agent" ? { kind: "agent", agent: row.origin_agent ?? UNNAMED_AGENT } : APP_ORIGIN;
}

/**
 * The origin private links are built on: this server's own public origin.
 * Markie Cloud answers on more than one name while it moves hosts, and the
 * mobile app claims only api.markiedocs.com, so the official deployment
 * always names that one. Every other server, self-hosted or local, names
 * itself.
 */
export function privateLinkOrigin(d: { official: boolean; origin: string } = deployment()): string {
  const { official, origin } = d;
  return official && CLOUD_API_ORIGINS.includes(origin) ? CLOUD_API_ORIGIN : origin;
}

export function privateLinkFor(id: string): string {
  return `${privateLinkOrigin()}/d/${encodeURIComponent(id)}`;
}

// Characters that would end the link text early or format it.
const LINK_TEXT_SPECIAL = /[\\[\]*_`<>]/g;

/** `[name](privateLink)`, ready to paste into a chat. */
export function markdownLinkFor(name: string, id: string): string {
  const text = name.replace(LINK_TEXT_SPECIAL, (ch) => `\\${ch}`) || "document";
  return `[${text}](${privateLinkFor(id)})`;
}
