// The web app's view of Markie Cloud: every document the account owns or has
// been given, from both of the server's stores, and the versioned reads and
// writes the editor makes.
//
//   docs      /api/docs: text documents (Markdown, Darkmown, plain text and
//             data files). Live editing, comments and the share dialog work on
//             these, the same as on the desktop.
//   platform  /api/document-platform: byte snapshots, which is where Word,
//             RTF and OpenDocument files live (src/lib/document-cloud.ts).
//
// Every write names the version it started from. The server refuses a write
// over someone else's newer version (409), and so does this module: a
// conflict is reported, never merged over.
import { getAuthToken, getServerURL } from "@/lib/auth-client";
import { classifyDocumentFormat, decodeTextDocument } from "@/lib/document-formats";
import { DocumentCloudClient, DocumentCloudError } from "@/lib/document-cloud";
import { libraryDocumentFormat } from "@/lib/library-document-query";
import type { LibraryFormat } from "@/lib/document-library";
import { mediaRef, parseViewLinks, type ViewLinks } from "./view-content";

export type CloudStore = "docs" | "platform";
export type CloudRole = "owner" | "editor" | "viewer";

export interface CloudDocSummary {
  /** Unique across both stores. */
  key: string;
  id: string;
  store: CloudStore;
  name: string;
  format: LibraryFormat | "html" | "other";
  /** Milliseconds since the epoch, 0 when the server did not say. */
  updatedAt: number;
  role: CloudRole;
  /** Who shared it with this account, for a document someone else owns. */
  sharedBy: string | null;
  /** An owned document somebody else can reach. */
  sharedOut: boolean;
  version: number;
}

export class SessionEndedError extends Error {
  constructor() {
    super("Your session has ended. Sign in again.");
    this.name = "SessionEndedError";
  }
}

export class CloudConflictError extends Error {
  constructor(readonly serverVersion: number | null) {
    super("Someone saved a newer version of this document. Your edits were not saved over it.");
    this.name = "CloudConflictError";
  }
}

export class CloudRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "CloudRequestError";
  }
}

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isDocId = (id: string) => DOC_ID.test(id);

function role(value: unknown, fallback: CloudRole): CloudRole {
  return value === "owner" || value === "editor" || value === "viewer" ? value : fallback;
}

function time(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type Fetch = typeof fetch;

async function request(path: string, init: RequestInit = {}, fetcher: Fetch = fetch): Promise<{ status: number; data: unknown }> {
  const token = getAuthToken();
  let response: Response;
  try {
    response = await fetcher(`${getServerURL()}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new CloudRequestError(0, "Can't reach Markie. Check your connection and try again.");
  }
  if (response.status === 401) throw new SessionEndedError();
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function failure(status: number, data: unknown): CloudRequestError {
  const said = (data as { message?: unknown; error?: unknown } | null) ?? {};
  const message = typeof said.message === "string" ? said.message : null;
  if (status === 403) return new CloudRequestError(403, "You can read this document, but its owner hasn't let you edit it.");
  if (status === 404) return new CloudRequestError(404, "This document was deleted, or it hasn't been shared with this account.");
  if (status === 413) return new CloudRequestError(413, message ?? "Your Markie Cloud storage is full.");
  if (status === 429) return new CloudRequestError(429, "Too many requests. Wait a minute and try again.");
  return new CloudRequestError(status, message ?? "The server couldn't do that. Try again in a moment.");
}

/** The platform store's client, bound to this page's own session and origin. */
export function platformClient(fetcher: Fetch = fetch): DocumentCloudClient {
  const token = getAuthToken();
  if (!token) throw new SessionEndedError();
  // The client calls its fetcher as a method; the browser's own fetch refuses
  // to run with anything but the window as `this`.
  return new DocumentCloudClient({ baseUrl: getServerURL(), token }, (input, init) => fetcher(input, init));
}

function platformFailure(error: unknown): never {
  if (error instanceof DocumentCloudError) {
    if (error.status === 401) throw new SessionEndedError();
    if (error.status === 409) throw new CloudConflictError(error.serverVersion ?? null);
    throw new CloudRequestError(error.status, error.message);
  }
  throw error;
}

interface DocsListRow { id?: unknown; name?: unknown; version?: unknown; updated_at?: unknown; shared?: unknown; sharedOut?: unknown; role?: unknown; shared_by?: unknown }

/** Every document in both stores, newest first. A store that fails is named in `errors`; the other still lists. */
export async function listCloudDocuments(fetcher: Fetch = fetch): Promise<{ docs: CloudDocSummary[]; errors: string[] }> {
  const errors: string[] = [];
  const [docs, platform] = await Promise.all([
    request("/api/docs", {}, fetcher).then(({ status, data }) => {
      if (status !== 200) throw failure(status, data);
      const rows = (data as { docs?: unknown } | null)?.docs;
      return Array.isArray(rows) ? rows as DocsListRow[] : [];
    }).catch((error: unknown) => {
      if (error instanceof SessionEndedError) throw error;
      errors.push("Text documents couldn't be listed.");
      return [] as DocsListRow[];
    }),
    Promise.resolve().then(() => platformClient(fetcher).list()).catch((error: unknown) => {
      if (error instanceof SessionEndedError || (error instanceof DocumentCloudError && error.status === 401)) throw new SessionEndedError();
      // A server without the document platform has no Office documents to list.
      if (error instanceof DocumentCloudError && (error.status === 404 || error.status === 501)) return [];
      errors.push("Word, RTF and OpenDocument files couldn't be listed.");
      return [];
    }),
  ]);
  const out: CloudDocSummary[] = [];
  for (const row of docs) {
    if (typeof row.id !== "string" || !DOC_ID.test(row.id) || typeof row.name !== "string") continue;
    const shared = row.shared === true;
    out.push({
      key: `docs:${row.id}`, id: row.id, store: "docs", name: row.name, format: libraryDocumentFormat(row.name),
      updatedAt: time(row.updated_at), role: shared ? role(row.role, "viewer") : "owner",
      sharedBy: shared && typeof row.shared_by === "string" ? row.shared_by : null,
      sharedOut: !shared && row.sharedOut === true,
      version: typeof row.version === "number" ? row.version : 0,
    });
  }
  for (const row of platform) {
    out.push({
      key: `platform:${row.id}`, id: row.id, store: "platform", name: row.name, format: row.format,
      updatedAt: time(row.updatedAt), role: row.role, sharedBy: null, sharedOut: false, version: row.version,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  return { docs: out, errors };
}

export interface TextCloudDoc {
  store: "docs";
  id: string;
  name: string;
  content: string;
  version: number;
  role: CloudRole;
}

/** A text document, or null when the docs store has no such id for this account. */
export async function openTextDoc(id: string, fetcher: Fetch = fetch): Promise<TextCloudDoc | null> {
  if (!DOC_ID.test(id)) return null;
  const { status, data } = await request(`/api/docs/${encodeURIComponent(id)}`, {}, fetcher);
  if (status === 404) return null;
  if (status !== 200) throw failure(status, data);
  const doc = (data as { doc?: Record<string, unknown> } | null)?.doc;
  if (!doc || doc.id !== id || typeof doc.content !== "string" || typeof doc.name !== "string" || typeof doc.version !== "number") {
    throw new CloudRequestError(502, "The server's answer wasn't a document.");
  }
  return { store: "docs", id, name: doc.name, content: doc.content, version: doc.version, role: role(doc.role, "viewer") };
}

/**
 * Where a text document's links to other documents lead for this account
 * (server/src/doc-links.ts GET /docs/:id/links): a target it may read opens
 * that document's read view, anything else is muted. Null when the server
 * could not say, so the caller can mute rather than guess.
 */
export async function loadDocLinks(id: string, fetcher: Fetch = fetch): Promise<ViewLinks | null> {
  if (!DOC_ID.test(id)) return null;
  try {
    const { status, data } = await request(`/api/docs/${encodeURIComponent(id)}/links`, {}, fetcher);
    if (status !== 200) return null;
    return parseViewLinks(data, (target) => `/d/${encodeURIComponent(target)}`);
  } catch {
    return null;
  }
}

/** How many of a document's references the share dialog asks about. */
export const MAX_ASSET_CHECKS = 50;

/**
 * Of a text document's local references (attach.ts localAssetRefs), the ones
 * Markie Cloud holds no file for: what a reader of the shared copy would see
 * as a gap. Each is asked for by the reference as written, one byte of it,
 * through the same read gate the document uses. At most MAX_ASSET_CHECKS.
 */
export async function missingDocAssets(id: string, refs: readonly string[], fetcher: Fetch = fetch): Promise<string[]> {
  if (!DOC_ID.test(id)) return [...refs];
  const asked = refs.slice(0, MAX_ASSET_CHECKS);
  const answers = await Promise.all(asked.map(async (ref) => {
    const { status } = await request(`/api/docs/${encodeURIComponent(id)}/assets/file?ref=${encodeURIComponent(mediaRef(ref))}`,
      { headers: { Range: "bytes=0-0" } }, fetcher);
    return status >= 400 ? ref : null;
  }));
  return answers.filter((ref): ref is string => ref !== null);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Saves one version of a text document over `baseVersion` (0 creates it).
 * Throws CloudConflictError when someone else's version is newer: the caller
 * decides what to do, and nothing is written over theirs.
 */
export async function saveTextDoc(
  { id, name, content, baseVersion }: { id: string; name: string; content: string; baseVersion: number },
  fetcher: Fetch = fetch
): Promise<{ version: number }> {
  if (!DOC_ID.test(id)) throw new CloudRequestError(400, "That isn't a Markie document.");
  const { status, data } = await request(`/api/docs/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name, content, hash: await sha256Hex(content), baseVersion }),
  }, fetcher);
  if (status === 409 && (data as { error?: unknown } | null)?.error === "conflict") {
    const server = (data as { serverVersion?: unknown }).serverVersion;
    throw new CloudConflictError(typeof server === "number" ? server : null);
  }
  if (status !== 200) throw failure(status, data);
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new CloudRequestError(502, "The server saved the document but didn't say which version it is now.");
  return { version };
}

/** Deletes a text document this account owns. */
export async function deleteTextDoc(id: string, fetcher: Fetch = fetch): Promise<void> {
  const { status, data } = await request(`/api/docs/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
  if (status !== 200) throw failure(status, data);
}

export interface PlatformCloudDoc {
  store: "platform";
  id: string;
  name: string;
  bytes: Uint8Array;
  version: number;
  role: CloudRole;
}

/** A platform snapshot, or null when the platform store has no such id for this account. */
export async function openPlatformDoc(id: string, fetcher: Fetch = fetch): Promise<PlatformCloudDoc | null> {
  if (!DOC_ID.test(id)) return null;
  const client = platformClient(fetcher);
  try {
    const response = await client.call(`/documents/${id}`);
    const { snapshot, bytes } = await client.decode(response.document);
    if (snapshot.id !== id) throw new CloudRequestError(502, "The server returned a different document.");
    return { store: "platform", id, name: snapshot.name, bytes, version: snapshot.version, role: snapshot.role };
  } catch (error) {
    if (error instanceof DocumentCloudError && (error.status === 404 || error.status === 403 || error.status === 501)) return null;
    platformFailure(error);
  }
}

export async function savePlatformDoc(
  { id, name, bytes, baseVersion }: { id: string | null; name: string; bytes: Uint8Array; baseVersion: number },
  fetcher: Fetch = fetch
): Promise<{ id: string; version: number }> {
  try {
    const snapshot = await platformClient(fetcher).upload({ name, bytes }, id ? { id, version: baseVersion } : undefined);
    return { id: snapshot.id, version: snapshot.version };
  } catch (error) {
    platformFailure(error);
  }
}

export async function deletePlatformDoc(id: string, baseVersion: number, fetcher: Fetch = fetch): Promise<void> {
  try {
    await platformClient(fetcher).call(`/documents/${id}`, "DELETE", { baseVersion });
  } catch (error) {
    platformFailure(error);
  }
}

/** Which kind of editor a document opens in. */
export type EditorKind = "markdown" | "darkmown" | "text" | "office" | "unsupported";

export function editorKindFor(name: string): EditorKind {
  const kind = classifyDocumentFormat(name).kind;
  if (kind === "markdown") return "markdown";
  if (kind === "darkmown") return "darkmown";
  if (kind === "text" || kind === "csv" || kind === "json" || kind === "yaml" || kind === "xml") return "text";
  if (kind === "docx" || kind === "rtf" || kind === "odt") return "office";
  return "unsupported";
}

/** A platform snapshot's bytes as text, for the text-like formats it can hold. */
export function platformText(bytes: Uint8Array): string {
  return decodeTextDocument(bytes).text;
}

/**
 * A new name for a document, keeping its type: what the person typed, with
 * the original extension added back when they left it off. Null when the
 * result is not a usable name or would change the format.
 */
export function renamedDocName(current: string, typed: string): string | null {
  const cleaned = typed.replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleaned) return null;
  const extension = current.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "";
  const name = classifyDocumentFormat(cleaned).kind === classifyDocumentFormat(current).kind && /\.[A-Za-z0-9]+$/.test(cleaned) ? cleaned : `${cleaned}${extension}`;
  return classifyDocumentFormat(name).kind === classifyDocumentFormat(current).kind ? name : null;
}
