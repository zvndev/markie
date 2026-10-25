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
  type CloudDoc,
  type RecentDoc,
} from "./docs";
import { NetworkError, type HttpResponse, type HttpTransport } from "./http";

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
    method: "GET" | "POST",
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

  async function json(method: "GET" | "POST", path: string, init: { body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<{ response: HttpResponse; data: unknown }> {
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
        privateLink: `${origin}/s/${encodeURIComponent(token)}`,
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

    privateLinkFor: (id: string) => privateLinkFor(origin, id),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

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
