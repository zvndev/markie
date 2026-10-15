import { classifyDocumentFormat } from "./document-formats";

export interface CloudIdentity { baseUrl: string; token: string }
export interface CloudFile { name: string; bytes: Uint8Array; text?: string }
export interface CloudSnapshot {
  id: string; name: string; format: string; version: number; encoding: "base64"; data: string; sha256: string;
  [key: string]: unknown;
}
export class DocumentCloudError extends Error {
  constructor(readonly status: number, message: string, readonly serverVersion?: number) { super(message); this.name = "DocumentCloudError"; }
}
const MAX_FILE = 16 * 1024 * 1024;
const MAX_RESPONSE = 24 * 1024 * 1024;
const FORMATS = new Set(["markdown", "text", "csv", "json", "yaml", "xml", "docx", "doc"]);

function originUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new DocumentCloudError(0, "Use an HTTPS cloud server or a loopback development server.");
  }
  return url.href.replace(/\/$/, "");
}
function binaryBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  return btoa(parts.join(""));
}
function fromBase64(value: string): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DocumentCloudError(0, "The server returned invalid document bytes.");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > MAX_FILE || binaryBase64(bytes) !== value) throw new DocumentCloudError(0, "The cloud document exceeds its supported size or encoding.");
  return bytes;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function jsonResponse(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) throw new DocumentCloudError(response.status, "Cloud response is too large.");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new DocumentCloudError(response.status, "Cloud response is too large."); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)); }
  catch { throw new DocumentCloudError(response.status, "The server did not return a valid document response."); }
}

/** Explicit user-triggered ordinary-document sharing only. Never receives vault records. */
export class DocumentCloudClient {
  readonly #base: string;
  readonly #token: string;
  constructor(identity: CloudIdentity, readonly request: typeof fetch = fetch) {
    this.#base = originUrl(identity.baseUrl);
    if (!identity.token) throw new DocumentCloudError(401, "Sign in to share a document.");
    this.#token = identity.token;
  }

  async call(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new DocumentCloudError(0, "Invalid document route.");
    const response = await this.request(`${this.#base}/api/document-platform${path}`, {
      method, signal, cache: "no-store", headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 || response.status === 501) throw new DocumentCloudError(response.status, "This server does not provide the new document-sharing service yet. Your local document is unchanged.");
    const result = await jsonResponse(response);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new DocumentCloudError(response.status, "Invalid cloud response.");
    const data = result as Record<string, unknown>;
    if (!response.ok) throw new DocumentCloudError(response.status,
      response.status === 409 ? "Another editor saved a newer cloud version. Your local edits were kept." : response.status === 401 ? "Sign in again to access this document." : response.status === 403 ? "You do not have permission for that document action." : "The cloud document operation failed.",
      typeof data.serverVersion === "number" ? data.serverVersion : undefined);
    return data;
  }

  async upload(file: CloudFile, target?: { id: string; version: number }, signal?: AbortSignal): Promise<CloudSnapshot> {
    const bytes = new Uint8Array(file.bytes);
    const format = classifyDocumentFormat(file.name).kind;
    if (!FORMATS.has(format) || bytes.length > MAX_FILE) throw new DocumentCloudError(0, "This document format or size cannot be shared yet.");
    const body = { schemaVersion: 2, name: file.name, format, encoding: "base64", data: binaryBase64(bytes), sha256: await sha256(bytes), baseVersion: target?.version ?? 0 };
    const response = await this.call(target ? `/documents/${encodeURIComponent(target.id)}` : "/documents", target ? "PUT" : "POST", body, signal);
    return (await this.decode(response.document)).snapshot;
  }

  async decode(value: unknown): Promise<{ snapshot: CloudSnapshot; bytes: Uint8Array }> {
    const snapshot = value as CloudSnapshot;
    if (!snapshot || typeof snapshot.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.id)
      || typeof snapshot.name !== "string" || !snapshot.name || snapshot.name.length > 256
      || !FORMATS.has(snapshot.format) || snapshot.encoding !== "base64"
      || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1 || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
      throw new DocumentCloudError(0, "The server returned invalid document metadata.");
    }
    const bytes = fromBase64(snapshot.data);
    if (await sha256(bytes) !== snapshot.sha256) throw new DocumentCloudError(0, "The downloaded document failed its integrity check.");
    return { snapshot, bytes };
  }
}
