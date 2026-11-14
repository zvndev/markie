// The Markie API, as the phone uses it: email-code sign-in (better-auth's
// emailOTP and bearer plugins), the recent list, one document, and the public
// share route. The bearer token is the only credential, and it only ever goes
// to the origin this client was made for.
import { authErrorMessage, signupRefusal, type AuthContext } from "@/lib/auth-errors";
import {
  DOC_ID,
  PUBLIC_TOKEN,
  nameFromDisposition,
  parseCloudDoc,
  parseRecentList,
  privateLinkFor,
  publicDocName,
  formatFromName,
  newDocId,
  parsePlatformList,
  type CloudDoc,
  type RecentDoc,
} from "./docs";
import { DocumentCloudClient } from "@/lib/document-cloud";
import { docLinkOrigin } from "@/lib/cloud-origin";
import { COLLAB_SCHEMA_VERSION, type CollabTicketAnswer } from "@/lib/collab";
import { NetworkError, type HttpMethod, type HttpResponse, type HttpTransport } from "./http";
import { sha256Hex } from "./sha256";

// A document is at most a few megabytes (2 MB through the agent API, 100 MB
// for the desktop's raw text route). The phone refuses to hold more than this
// in one answer rather than stall the web view.
const MAX_RESPONSE_CHARS = 24_000_000;
// One picture inside a document. The server allows an asset up to 100 MB
// (server/src/assets.ts); a phone shows a picture far smaller than that or none
// at all. Every picture request asks for only this many bytes, so a larger one
// costs the first 20 MB at most, never the whole file.
const MAX_ASSET_BYTES = 20_000_000;
const ASSET_TIMEOUT_MS = 15_000;
const MAX_ERROR_CHARS = 512;
// The desktop's sync accepts far more; a phone keyboard never gets near this.
const MAX_SAVE_CHARS = 8_000_000;
const SAVE_TIMEOUT_MS = 30_000;

export interface ApiUser {
  id: string;
  email: string;
  name: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The server's own words, when it gave any. Shown under a plain sentence. */
  readonly serverMessage: string | null;
  constructor(status: number, message: string, code = "", serverMessage: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }
}

export interface ApiClientOptions {
  origin: string;
  transport: HttpTransport;
  /** Current bearer token, read per request so a rotated token is used at once. */
  getToken?: () => string | null;
  /** better-auth may hand back a refreshed token on any authenticated answer. */
  onTokenRotated?: (token: string) => void;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function serverWords(data: unknown): { code: string; message: string | null } {
  if (!data || typeof data !== "object") return { code: "", message: null };
  const raw = data as { code?: unknown; error?: unknown; message?: unknown };
  const code = typeof raw.code === "string" ? raw.code.slice(0, 64) : "";
  const message = typeof raw.message === "string" && raw.message.trim()
    ? raw.message
    : typeof raw.error === "string" && raw.error.trim() ? raw.error : null;
  // eslint-disable-next-line no-control-regex
  return { code, message: message ? message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_ERROR_CHARS) : null };
}

const TOKEN_SHAPE = /^[\x21-\x7e]{16,1024}$/;

export function createApiClient(options: ApiClientOptions) {
  const { origin, transport } = options;

  async function send(
    method: HttpMethod,
    path: string,
    { body, auth = true, timeoutMs, binary = false, headers: extra }: { body?: unknown; auth?: boolean; timeoutMs?: number; binary?: boolean; headers?: Record<string, string> } = {}
  ): Promise<HttpResponse> {
    const token = auth ? options.getToken?.() ?? null : null;
    let response: HttpResponse;
    try {
      response = await transport({
        method,
        url: `${origin}${path}`,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
        body,
        timeoutMs,
        ...(binary ? { responseType: "binary" as const } : {}),
      });
    } catch (error) {
      if (error instanceof NetworkError) throw new ApiError(0, error.message);
      throw new ApiError(0, "Can't reach the server. Check your connection.");
    }
    if ((response.bytes?.length ?? 0) > MAX_ASSET_BYTES) throw new ApiError(413, "This picture is too large to show on a phone.");
    if (response.text.length > MAX_RESPONSE_CHARS) throw new ApiError(413, "This document is too large to open on a phone.");
    const rotated = response.headers["set-auth-token"];
    if (token && rotated && rotated !== token && TOKEN_SHAPE.test(rotated) && response.status < 400) {
      options.onTokenRotated?.(rotated);
    }
    return response;
  }

  async function json(method: HttpMethod, path: string, init: { body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<{ response: HttpResponse; data: unknown }> {
    const response = await send(method, path, init);
    const data = parseJson(response.text);
    if (response.status >= 200 && response.status < 300) return { response, data };
    throw errorFor(response.status, data);
  }

  function errorFor(status: number, data: unknown): ApiError {
    const words = serverWords(data);
    if (status >= 300 && status < 400) return new ApiError(status, "The server tried to send this request somewhere else. Check the server address.", words.code, words.message);
    if (status === 401) return new ApiError(401, "Your session has ended. Sign in again.", words.code, words.message);
    if (status === 429) return new ApiError(429, "Too many requests. Wait a minute and try again.", words.code, words.message);
    if (status >= 500) return new ApiError(status, "The server ran into a problem. Try again in a moment.", words.code, words.message);
    return new ApiError(status, words.message ?? "Something went wrong. Try again.", words.code, words.message);
  }

  async function authCall(context: AuthContext, path: string, body: unknown): Promise<{ response: HttpResponse; data: unknown }> {
    try {
      return await json("POST", path, { body, auth: false });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const refusal = signupRefusal(error.status, { code: error.code });
      throw new ApiError(error.status, refusal ?? authErrorMessage(error.status, context), error.code, error.serverMessage);
    }
  }

  /**
   * Saves a new version through the same route the desktop's sync pushes to.
   * `baseVersion` is the version this edit started from; the server refuses
   * the save (409) when another device saved first, so nothing is overwritten
   * unseen. A new document is the same call with baseVersion 0.
   */
  async function saveDoc({ id, name, content, baseVersion }: { id: string; name: string; content: string; baseVersion: number }): Promise<{ id: string; version: number }> {
    if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
    if (content.length > MAX_SAVE_CHARS) throw new ApiError(413, "This document is too large to save from a phone.");
    const hash = await sha256Hex(content);
    let result: { data: unknown };
    try {
      result = await json("PUT", `/api/docs/${encodeURIComponent(id)}`, { body: { name, content, hash, baseVersion }, timeoutMs: SAVE_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 409 && error.code !== "placement-required") {
        throw new ApiError(409, "This document changed on another device while you were editing.", "conflict", error.serverMessage);
      }
      if (error.status === 403) throw new ApiError(403, "You can read this document, but its owner hasn't let you edit it.", error.code, error.serverMessage);
      if (error.status === 413) throw new ApiError(413, error.serverMessage ?? "Your Markie Cloud storage is full.", error.code, error.serverMessage);
      throw error;
    }
    const version = (result.data as { version?: unknown } | null)?.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new ApiError(502, "The server saved the document but didn't say which version it is now.");
    return { id, version };
  }

  return {
    origin,

    /** Mails a six-digit code. better-auth answers the same whether or not the address has an account. */
    async sendCode(email: string): Promise<void> {
      await authCall("otp-send", "/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    },

    async verifyCode(email: string, otp: string): Promise<{ token: string; user: ApiUser }> {
      const { response, data } = await authCall("otp-verify", "/api/auth/sign-in/email-otp", { email, otp });
      const body = (data && typeof data === "object" ? data : {}) as { token?: unknown; user?: unknown };
      const token = response.headers["set-auth-token"] || (typeof body.token === "string" ? body.token : "");
      if (!TOKEN_SHAPE.test(token)) throw new ApiError(502, "The server signed you in but didn't return a session. Try again.");
      return { token, user: parseUser(body.user) ?? { id: "", email, name: "" } };
    },

    async me(): Promise<ApiUser | null> {
      const { data } = await json("GET", "/api/me");
      return parseUser((data as { user?: unknown } | null)?.user);
    },

    /** Ends the session on the server. Signing out locally never waits on this succeeding. */
    async signOut({ timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
      await json("POST", "/api/auth/sign-out", { body: {}, timeoutMs });
    },

    async recent({ limit = 50, before }: { limit?: number; before?: string | null } = {}): Promise<RecentDoc[]> {
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Math.floor(limit)))) });
      if (before) params.set("before", before);
      const { data } = await json("GET", `/api/docs/recent?${params}`);
      try {
        return parseRecentList(data, origin);
      } catch (error) {
        throw new ApiError(502, error instanceof Error ? error.message : "The server's answer wasn't readable.");
      }
    },

    async doc(id: string): Promise<CloudDoc> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document link.");
      const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}`);
      try {
        return parseCloudDoc(data, origin);
      } catch (error) {
        throw new ApiError(502, error instanceof Error ? error.message : "The server's answer wasn't readable.");
      }
    },

    /** Where a document's relative links point (server/src/doc-links.ts). Empty on any failure. */
    async docLinks(id: string): Promise<Map<string, string>> {
      if (!DOC_ID.test(id)) return new Map();
      try {
        const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}/links`);
        const links = (data as { links?: unknown } | null)?.links;
        const out = new Map<string, string>();
        if (!Array.isArray(links)) return out;
        for (const link of links.slice(0, 500)) {
          const { ref, target } = (link ?? {}) as { ref?: unknown; target?: unknown };
          if (typeof ref === "string" && ref.length <= 2048 && typeof target === "string" && DOC_ID.test(target)) out.set(ref, target);
        }
        return out;
      } catch {
        return new Map();
      }
    },

    saveDoc,

    /** A new document in this account. Returns its id, for opening it. */
    async createDoc({ name, content }: { name: string; content: string }): Promise<{ id: string; version: number }> {
      return saveDoc({ id: newDocId(), name, content, baseVersion: 0 });
    },

    /** A public share, read the way a browser reads it: no account involved. */
    async publicDoc(token: string): Promise<CloudDoc> {
      if (!PUBLIC_TOKEN.test(token)) throw new ApiError(404, "That isn't a Markie share link.");
      const response = await send("GET", `/s/${encodeURIComponent(token)}/raw`, { auth: false });
      if (response.status !== 200) {
        if (response.status === 404) throw new ApiError(404, "This share link was turned off, or never existed.");
        throw errorFor(response.status, parseJson(response.text));
      }
      const name = publicDocName(nameFromDisposition(response.headers["content-disposition"]));
      return {
        id: token,
        name,
        format: formatFromName(name),
        version: null,
        content: response.text,
        updatedAt: null,
        origin: { kind: "app", agent: null },
        privateLink: `${docLinkOrigin(origin)}/s/${encodeURIComponent(token)}`,
        role: null,
        publicToken: token,
      };
    },

    /**
     * One picture a document names by a relative ref, from the same routes the
     * server's own web pages use: the signed-in reader's asset route for a
     * private document, the share's for a public one. Null when the document
     * has no such picture, or it isn't an image.
     */
    async asset(source: AssetSource, ref: string): Promise<Blob | null> {
      if (!ref || ref.length > 2048) return null;
      const query = `ref=${encodeURIComponent(ref)}`;
      let path: string;
      if (source.kind === "doc") {
        if (!DOC_ID.test(source.id)) return null;
        path = `/api/docs/${encodeURIComponent(source.id)}/assets/file?${query}`;
      } else {
        if (!PUBLIC_TOKEN.test(source.token)) return null;
        path = `/s/${encodeURIComponent(source.token)}/assets?${query}`;
      }
      const response = await send("GET", path, {
        auth: source.kind === "doc",
        binary: true,
        timeoutMs: ASSET_TIMEOUT_MS,
        headers: { range: `bytes=0-${MAX_ASSET_BYTES - 1}` },
      });
      if ((response.status !== 200 && response.status !== 206) || !response.bytes) return null;
      // A slice of a bigger picture is half a picture: refuse it. A server
      // that ignored the range answers 200, and send() has already refused
      // anything over the cap.
      if (response.status === 206) {
        const total = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers["content-range"] ?? "")?.[1];
        if (!total || Number(total) > MAX_ASSET_BYTES) return null;
      }
      const type = (response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (!/^image\/[a-z0-9.+-]+$/.test(type)) return null;
      return new Blob([response.bytes as BlobPart], { type });
    },


    /** The caller's role on a document (server/src/shares.ts /access). Null when the server didn't say. */
    async access(id: string): Promise<DocAccess | null> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}/access`);
      return parseAccess((data as { access?: unknown } | null)?.access);
    },

    /** Who else is on a document: members, and for its owner the invites not yet taken up. */
    async shares(id: string): Promise<ShareMember[]> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}/shares`);
      const list = (data as { shares?: unknown } | null)?.shares;
      if (!Array.isArray(list)) throw new ApiError(502, "The server's answer wasn't readable.");
      return list.slice(0, 500).map(parseShareMember).filter((member): member is ShareMember => member !== null);
    },

    /**
     * Shares by email, the desktop's own call: someone with an account becomes
     * a member now, anyone else gets an invitation. The same call with another
     * role changes a member's role.
     */
    async addShare(id: string, email: string, role: ShareRole): Promise<"member" | "invited"> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const clean = email.trim().toLowerCase();
      if (!EMAIL.test(clean) || clean.length > 320) throw new ApiError(400, "Enter an email address.");
      if (role !== "viewer" && role !== "editor") throw new ApiError(400, "Choose viewer or editor.");
      const { data } = await json("POST", `/api/docs/${encodeURIComponent(id)}/shares`, { body: { email: clean, role } });
      return (data as { status?: unknown } | null)?.status === "invited" ? "invited" : "member";
    },

    /** Takes someone off a document: a member by id, an invitation by email. */
    async removeShare(id: string, idOrEmail: string): Promise<void> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      if (!idOrEmail || idOrEmail.length > 320) throw new ApiError(400, "That person isn't on this document.");
      await json("DELETE", `/api/docs/${encodeURIComponent(id)}/shares/${encodeURIComponent(idOrEmail)}`);
    },

    /**
     * The document's public link, or null when it has none (owner only, as on
     * the desktop). A document is private until its owner turns this on, and
     * only these three calls touch it, each one a tap by the owner.
     */
    async publicLink(id: string): Promise<string | null> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}/public-link`);
      const raw = (data as { url?: unknown } | null)?.url;
      // No link is a null url. A url this app can't read is not "private":
      // saying so would invite the owner to make public a document that is.
      if (raw === null || raw === undefined) return null;
      const url = publicUrlOrNull(raw);
      if (!url) throw new ApiError(502, "The server's public link wasn't readable.");
      return url;
    },

    /** Turns the public link on (or returns the one that exists). */
    async createPublicLink(id: string): Promise<string> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const { data } = await json("POST", `/api/docs/${encodeURIComponent(id)}/public-link`, { body: {} });
      const url = publicUrlOrNull((data as { url?: unknown } | null)?.url);
      if (!url) throw new ApiError(502, "The server didn't return a public link.");
      return url;
    },

    /** Turns the public link off. Anyone holding the old link can no longer open it. */
    async revokePublicLink(id: string): Promise<void> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      await json("DELETE", `/api/docs/${encodeURIComponent(id)}/public-link`);
    },

    /**
     * A pass for the live-editing socket (server/src/collab-tickets.ts). The
     * pass is the socket's only credential: the session token never goes in
     * its URL. A server too old to issue passes gets no live session from the
     * phone at all, so the answer is never "legacy".
     */
    async collabTicket(id: string): Promise<CollabTicketAnswer> {
      if (!DOC_ID.test(id)) return { kind: "failed", status: 404 };
      try {
        const { data } = await json("POST", `/api/docs/${encodeURIComponent(id)}/collab-ticket`, { body: { schema: COLLAB_SCHEMA_VERSION } });
        const raw = (data ?? {}) as { ticket?: unknown; expiresAt?: unknown };
        if (typeof raw.ticket !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(raw.ticket)) return { kind: "failed", status: 502 };
        return { kind: "ticket", ticket: raw.ticket, expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0 };
      } catch (error) {
        if (error instanceof ApiError) {
          return { kind: "failed", status: error.status };
        }
        return { kind: "failed", status: 0 };
      }
    },

    /** Comment threads on a document, each with its comments (server/src/comments.ts). */
    async threads(id: string): Promise<CommentThread[]> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const { data } = await json("GET", `/api/docs/${encodeURIComponent(id)}/threads`);
      const list = (data as { threads?: unknown } | null)?.threads;
      if (!Array.isArray(list)) throw new ApiError(502, "The server's answer wasn't readable.");
      return list.slice(0, 1000).map(parseThread).filter((thread): thread is CommentThread => thread !== null);
    },

    async createThread(id: string, anchor: unknown, body: string): Promise<string> {
      if (!DOC_ID.test(id)) throw new ApiError(404, "That isn't a Markie document.");
      const text = commentBody(body);
      const { data } = await json("POST", `/api/docs/${encodeURIComponent(id)}/threads`, { body: { anchor, body: text } });
      const threadId = (data as { id?: unknown } | null)?.id;
      return typeof threadId === "string" ? threadId : "";
    },

    async reply(id: string, threadId: string, body: string): Promise<void> {
      if (!DOC_ID.test(id) || !THREAD_ID.test(threadId)) throw new ApiError(404, "That comment isn't on this document.");
      await json("POST", `/api/docs/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/comments`, { body: { body: commentBody(body) } });
    },

    async setThreadStatus(id: string, threadId: string, status: "open" | "resolved"): Promise<void> {
      if (!DOC_ID.test(id) || !THREAD_ID.test(threadId)) throw new ApiError(404, "That comment isn't on this document.");
      await json("POST", `/api/docs/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/status`, { body: { status } });
    },

    async deleteComment(id: string, threadId: string, commentId: string): Promise<void> {
      if (!DOC_ID.test(id) || !THREAD_ID.test(threadId) || !THREAD_ID.test(commentId)) throw new ApiError(404, "That comment isn't on this document.");
      await json("DELETE", `/api/docs/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`);
    },

    /**
     * The document platform's client (src/lib/document-cloud.ts), the one the
     * desktop uses for Word, RTF and OpenDocument files, sending through this
     * app's own transport instead of the web view's fetch.
     */
    platform(): DocumentCloudClient {
      const token = options.getToken?.() ?? "";
      return new DocumentCloudClient({ baseUrl: origin, token }, platformFetch(transport, origin));
    },

    /** Every document-platform file this account can open. Empty on a server without the platform. */
    async platformRecent(): Promise<RecentDoc[]> {
      let response: HttpResponse;
      try {
        response = await send("GET", "/api/document-platform/documents", { timeoutMs: 20_000 });
      } catch (error) {
        if (error instanceof ApiError && error.status === 0) throw error;
        return [];
      }
      if (response.status === 401) throw new ApiError(401, "Your session has ended. Sign in again.");
      if (response.status !== 200) return [];
      try {
        return parsePlatformList(parseJson(response.text));
      } catch {
        return [];
      }
    },

    privateLinkFor: (id: string) => privateLinkFor(origin, id),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** The caller's standing on a document, from `/api/docs/:id/access`. */
export interface DocAccess {
  role: "owner" | "editor" | "viewer";
  canEdit: boolean;
  canManage: boolean;
}

export type ShareRole = "viewer" | "editor";

/** A person on a document. `userId` is null for an invitation not yet taken up. */
export interface ShareMember {
  userId: string | null;
  email: string;
  name: string | null;
  role: ShareRole;
  pending: boolean;
}

export interface ThreadComment {
  id: string;
  authorId: string;
  authorName: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}

export interface CommentThread {
  id: string;
  /** Yjs relative positions (src/lib/comment-anchors.ts), opaque until a live session reads them. */
  anchor: unknown;
  status: "open" | "resolved";
  createdBy: string;
  createdAt: string;
  comments: ThreadComment[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Thread and comment ids are server-minted UUIDs.
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
// A comment is a few sentences; a pasted chapter is not one.
const MAX_COMMENT_CHARS = 10_000;

function commentBody(body: string): string {
  const text = String(body ?? "").trim();
  if (!text) throw new ApiError(400, "Write a comment first.");
  if (text.length > MAX_COMMENT_CHARS) throw new ApiError(413, "That comment is too long.");
  return text;
}

function plainString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * A public link is an http(s) URL whose path ends in /s/<token>. A server
 * served under a path (https://example.org/markie/s/<token>) is one too.
 */
export function publicUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return /^(?:\/[A-Za-z0-9._~-]+)*\/s\/[A-Za-z0-9_-]{16,128}$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function parseAccess(value: unknown): DocAccess | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { role?: unknown; canEdit?: unknown; canManage?: unknown };
  if (raw.role !== "owner" && raw.role !== "editor" && raw.role !== "viewer") return null;
  return { role: raw.role, canEdit: raw.canEdit === true, canManage: raw.canManage === true };
}

function parseShareMember(value: unknown): ShareMember | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const email = plainString(raw.email, 320);
  if (!email || (raw.role !== "viewer" && raw.role !== "editor")) return null;
  const userId = typeof raw.user_id === "string" && THREAD_ID.test(raw.user_id) ? raw.user_id : null;
  return { userId, email, name: plainString(raw.name, 256), role: raw.role, pending: raw.pending === true || userId === null };
}

function parseThread(value: unknown): CommentThread | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !THREAD_ID.test(raw.id)) return null;
  const comments = Array.isArray(raw.comments) ? raw.comments.slice(0, 500).map(parseComment).filter((c): c is ThreadComment => c !== null) : [];
  return {
    id: raw.id,
    anchor: raw.anchor ?? null,
    status: raw.status === "resolved" ? "resolved" : "open",
    createdBy: typeof raw.created_by === "string" ? raw.created_by.slice(0, 128) : "",
    createdAt: typeof raw.created_at === "string" ? raw.created_at.slice(0, 64) : "",
    comments,
  };
}

function parseComment(value: unknown): ThreadComment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !THREAD_ID.test(raw.id) || typeof raw.body !== "string") return null;
  return {
    id: raw.id,
    authorId: typeof raw.author_id === "string" ? raw.author_id.slice(0, 128) : "",
    authorName: plainString(raw.author_name, 256) ?? "",
    authorEmail: plainString(raw.author_email, 320) ?? "",
    body: raw.body.slice(0, MAX_COMMENT_CHARS),
    createdAt: typeof raw.created_at === "string" ? raw.created_at.slice(0, 64) : "",
  };
}

/**
 * A fetch for DocumentCloudClient that goes through the app's transport, so
 * on a device it is the native HTTP stack like every other request. It only
 * ever reaches this server's document platform: the client builds every URL
 * from the origin it was given, and anything else is refused here too.
 */
export function platformFetch(transport: HttpTransport, origin: string): typeof fetch {
  const base = `${origin}/api/document-platform/`;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(base)) throw new TypeError("Refused a request outside the document platform.");
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "DELETE") throw new TypeError("Unsupported method.");
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      if (name === "authorization") headers.authorization = value;
    });
    let body: unknown;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { throw new TypeError("The request body wasn't JSON."); }
    }
    let response: HttpResponse;
    try {
      response = await transport({ method, url, headers, body, timeoutMs: 60_000 });
    } catch {
      throw new TypeError("Can't reach the server. Check your connection.");
    }
    if (response.status < 200 || response.status > 599) throw new TypeError("The server's answer wasn't readable.");
    return new Response(response.status === 204 ? null : response.text, { status: response.status, headers: { "content-type": response.headers["content-type"] ?? "application/json" } });
  }) as typeof fetch;
}


/** Whose pictures: a private document read with the session, or a public share. */
export type AssetSource = { kind: "doc"; id: string } | { kind: "public"; token: string };

function parseUser(value: unknown): ApiUser | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; email?: unknown; name?: unknown };
  if (typeof raw.email !== "string") return null;
  return {
    id: typeof raw.id === "string" ? raw.id.slice(0, 128) : "",
    email: raw.email.slice(0, 320),
    name: typeof raw.name === "string" ? raw.name.slice(0, 256) : "",
  };
}

/** What the Document screen says when a document can't be shown. */
export interface DocumentErrorCopy {
  title: string;
  body: string;
  detail: string | null;
  /** Offer "Sign in" instead of any other action. */
  signIn: boolean;
  /** Trying again could work. When it can't (403, 404), offer the way back instead. */
  retry: boolean;
}

/**
 * @param server What to call the server in a sentence: "Markie Cloud", or a
 *   self-hosted server's host (serverLabel).
 */
export function documentErrorCopy(error: unknown, server = "this server"): DocumentErrorCopy {
  if (error instanceof ApiError) {
    const detail = error.serverMessage ? `The server said: "${error.serverMessage}" (${error.status})` : error.status ? `Status ${error.status}` : null;
    if (error.status === 0) return { title: "You're offline", body: error.message, detail: null, signIn: false, retry: true };
    if (error.status === 401) return { title: "Sign in again", body: "Your session has ended. Sign in and the document opens right after.", detail, signIn: true, retry: false };
    if (error.status === 403) return { title: "You don't have access", body: `This document belongs to someone else on ${server}, and it hasn't been shared with this account.`, detail, signIn: false, retry: false };
    if (error.status === 404) return { title: "Document not found", body: "It may have been deleted, or it hasn't been shared with this account.", detail, signIn: false, retry: false };
    return { title: "Couldn't open this document", body: error.message, detail, signIn: false, retry: true };
  }
  return { title: "Couldn't open this document", body: error instanceof Error ? error.message : "Something went wrong.", detail: null, signIn: false, retry: true };
}
