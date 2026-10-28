// The document shapes the app reads from the server, parsed defensively.
// The server is the user's own choice of origin, but the app still never
// trusts a field's type, length or format just because it arrived as JSON.

export type DocFormat = "markdown" | "darkmown" | "text";

export interface DocOrigin {
  kind: "app" | "agent";
  /** Display name of the agent, or null for the app or an unnamed agent. */
  agent: string | null;
}

export interface RecentDoc {
  id: string;
  name: string;
  format: DocFormat;
  createdAt: string | null;
  updatedAt: string;
  origin: DocOrigin;
  shared: boolean;
  role: string;
  sharedBy: string | null;
  privateLink: string;
}

export interface CloudDoc {
  id: string;
  name: string;
  format: DocFormat;
  version: number | null;
  content: string;
  updatedAt: string | null;
  origin: DocOrigin;
  privateLink: string;
  /** The caller's role on it (owner, editor, viewer), or null when the server didn't say. */
  role: string | null;
  /** A public share opened through /s/<token>: read without an account. */
  publicToken?: string;
}

// Ids are minted by clients (crypto.randomUUID today); the server bounds them
// with exactly this shape (server/src/doc-links.ts TARGET_ID).
export const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Public link tokens are 32 random bytes in base64url (server/src/link-token.ts).
export const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

const FORMATS = new Set<DocFormat>(["markdown", "darkmown", "text"]);

// Data files the desktop opens as text. The server files them under
// "markdown" (anything it doesn't recognise is), so the phone reads the name
// itself rather than render a CSV as a paragraph.
const PLAIN_TEXT_NAME = /\.(txt|text|log|csv|tsv|json|ya?ml|xml|toml|ini)$/;

/** The contract's rule: `.wd` is Darkmown; `.txt`, `.text`, `.log` (and data files) are text; the rest is markdown. */
export function formatFromName(name: string): DocFormat {
  const lower = String(name ?? "").toLowerCase();
  if (lower.endsWith(".wd")) return "darkmown";
  if (PLAIN_TEXT_NAME.test(lower)) return "text";
  return "markdown";
}

/** The glyph a document's icon draws: its format, or the data file kind its name says. */
export function markFormat(doc: { name: string; format: DocFormat }): string {
  const ext = /\.([a-z0-9]+)$/i.exec(doc.name)?.[1]?.toLowerCase() ?? "";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (ext === "xml") return "xml";
  return doc.format;
}

/** Whether a save from this account would be taken: owners and editors, or a role the server didn't name. */
export function canEditDoc(doc: CloudDoc): boolean {
  if (doc.publicToken || doc.version === null) return false;
  return doc.role === null || doc.role === "owner" || doc.role === "editor";
}

/** The kinds of document the phone can start. Each one is text, which is what Markie Cloud stores. */
export interface NewDocType {
  id: string;
  label: string;
  hint: string;
  extension: string;
  starter: (title: string) => string;
}

export const NEW_DOC_TYPES: readonly NewDocType[] = [
  { id: "markdown", label: "Markdown", hint: "Headings, lists, links and tables", extension: ".md", starter: (title) => `# ${title}\n\n` },
  { id: "text", label: "Plain text", hint: "Just the words, nothing rendered", extension: ".txt", starter: () => "" },
  { id: "darkmown", label: "Darkmown", hint: "An interactive document with buttons and state", extension: ".wd", starter: (title) => `---\ntitle: ${title}\n---\n\n# ${title}\n\n:state count = 0\n\nCount: { count }.\n\n:button "Add one" -> count++\n` },
  { id: "csv", label: "CSV", hint: "Rows and columns", extension: ".csv", starter: () => "Name,Value\n" },
  { id: "json", label: "JSON", hint: "Structured data", extension: ".json", starter: () => "{\n  \n}\n" },
  { id: "yaml", label: "YAML", hint: "Config and front matter", extension: ".yaml", starter: () => "" },
];

/** A file name from what someone typed: trimmed, no slashes, and the type's extension unless they gave one. */
export function newDocName(typed: string, type: NewDocType): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(typed ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const base = cleaned || "Untitled";
  return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}${type.extension}`;
}

/** A new document id, the same shape the desktop mints (crypto.randomUUID). */
export function newDocId(random: () => string = () => crypto.randomUUID()): string {
  const id = random();
  if (!DOC_ID.test(id)) throw new Error("Couldn't make a document id.");
  return id;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export function parseOrigin(value: unknown): DocOrigin {
  if (!value || typeof value !== "object") return { kind: "app", agent: null };
  const raw = value as { kind?: unknown; agent?: unknown };
  if (raw.kind !== "agent") return { kind: "app", agent: null };
  return { kind: "agent", agent: cleanText(raw.agent, 64) };
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function privateLinkFor(origin: string, id: string): string {
  return `${origin}/d/${encodeURIComponent(id)}`;
}

function parseFormat(value: unknown, name: string): DocFormat {
  if (PLAIN_TEXT_NAME.test(name.toLowerCase())) return "text";
  return typeof value === "string" && FORMATS.has(value as DocFormat) ? (value as DocFormat) : formatFromName(name);
}

export function parseRecentItem(value: unknown, serverOrigin: string): RecentDoc | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !DOC_ID.test(raw.id)) return null;
  const name = cleanText(raw.name, 512) ?? "Untitled";
  const updatedAt = isoOrNull(raw.updatedAt);
  if (!updatedAt) return null;
  return {
    id: raw.id,
    name,
    format: parseFormat(raw.format, name),
    createdAt: isoOrNull(raw.createdAt),
    updatedAt,
    origin: parseOrigin(raw.origin),
    shared: raw.shared === true,
    role: cleanText(raw.role, 32) ?? (raw.shared === true ? "viewer" : "owner"),
    sharedBy: cleanText(raw.sharedBy, 256),
    privateLink: httpUrlOrNull(raw.privateLink) ?? privateLinkFor(serverOrigin, raw.id),
  };
}

/**
 * The list envelope. The contract names the item shape; the envelope follows
 * `GET /api/docs`, which answers `{ docs: [...] }`. A bare array is accepted
 * too, so either reading of the contract works.
 */
export function parseRecentList(value: unknown, serverOrigin: string): RecentDoc[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { docs?: unknown }).docs)
      ? (value as { docs: unknown[] }).docs
      : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
        ? (value as { items: unknown[] }).items
        : null;
  if (!list) throw new Error("The server's document list wasn't in the expected shape.");
  return list.slice(0, 500).map((item) => parseRecentItem(item, serverOrigin)).filter((item): item is RecentDoc => item !== null);
}

export function parseCloudDoc(value: unknown, serverOrigin: string): CloudDoc {
  const raw = value && typeof value === "object" ? (value as { doc?: unknown }).doc : null;
  if (!raw || typeof raw !== "object") throw new Error("The server's answer wasn't a document.");
  const doc = raw as Record<string, unknown>;
  if (typeof doc.id !== "string" || !DOC_ID.test(doc.id)) throw new Error("The server's answer wasn't a document.");
  if (typeof doc.content !== "string") throw new Error("The server's answer wasn't a document.");
  const name = cleanText(doc.name, 512) ?? "Untitled";
  return {
    id: doc.id,
    name,
    format: parseFormat(doc.format, name),
    version: typeof doc.version === "number" && Number.isSafeInteger(doc.version) ? doc.version : null,
    content: doc.content,
    updatedAt: isoOrNull(doc.updatedAt) ?? isoOrNull(doc.updated_at),
    origin: parseOrigin(doc.origin),
    privateLink: httpUrlOrNull(doc.privateLink) ?? privateLinkFor(serverOrigin, doc.id),
    role: cleanText(doc.role, 32),
  };
}

/** The file name a public share's raw download names, from Content-Disposition. */
export function nameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return cleanText(decodeURIComponent(star[1]), 512);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain ? cleanText(plain[1], 512) : null;
}

/**
 * A public share's raw route always names the file `.md` (server/src/public.ts
 * appends it). `Plan.wd` arrives as `Plan.wd.md`, so that one suffix is
 * peeled back off to recover the document's own format.
 */
export function publicDocName(downloadName: string | null): string {
  const name = downloadName ?? "Shared document.md";
  return /\.(wd|txt|text|log|csv|tsv|json|ya?ml|xml|toml|ini)\.md$/i.test(name) ? name.slice(0, -3) : name;
}

/** A short line for the document header: who made it. */
export function originLabel(origin: DocOrigin): string | null {
  if (origin.kind !== "agent") return null;
  return `from ${origin.agent ?? "an agent"}`;
}
