// Thin client for the Markie API (better-auth REST endpoints).
// Sessions use bearer tokens; the token is mirrored to the Electron main
// process (sync engine) whenever it changes.
import { getElectronAPI } from "@/lib/electron";
import { createAuthState } from "@/lib/auth-state";

export interface MarkieUser {
  id: string;
  email: string;
  name: string;
}

const SERVER_KEY = "markie.server.v1";
const DEFAULT_SERVER = "https://api-production-602f.up.railway.app";

export function getServerURL(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export function setServerURL(url: string): void {
  const before = getServerURL();
  try {
    localStorage.setItem(SERVER_KEY, url.replace(/\/$/, ""));
  } catch {
    // storage unavailable — keep default
  }
  // An account was confirmed by one server; another server has not said
  // whose this token is, so the answer goes with the old address.
  if (getServerURL() !== before && principal !== null) {
    principal = null;
    writeBinding(null);
    pushSyncConfig();
  }
}

// y-websocket appends "/<roomname>" to this base; the server matches /collab/:docId
export function collabWsBase(): string {
  return `${getServerURL().replace(/^http/, "ws")}/collab`;
}

const TOKEN_KEY = "markie.token.v1";

export function getAuthToken(): string | null {
  return getToken();
}

// Store a token that arrived out-of-band (e.g. the Google deep-link bridge).
export function adoptAuthToken(token: string): void {
  setToken(token);
}

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  const before = getToken();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
  // The principal was confirmed for the token before this one. A different
  // token is a different session, whether or not anyone signed out in
  // between, so the answer goes here and main hears in the same push; a push
  // that paired the new token with the old account is how one account's
  // remembered roles came to speak for another. me() sets it again once the
  // server says who this token belongs to. No token at all is a sign-out.
  if (!token || token !== before) {
    principal = null;
    writeBinding(null);
  }
  pushSyncConfig();
}

// The confirmed account, kept beside the token it was confirmed for, so a
// launch with no network still knows whose remembered roles this device
// holds: without it every one of them was refused for the length of the
// outage, and the Cloud page had nothing to file. The token is already in
// storage under TOKEN_KEY, so this adds no new secret.
const PRINCIPAL_KEY = "markie.auth.principal.v1";

interface PrincipalBinding {
  token: string;
  // The server that confirmed it. The same token string offered to another
  // address is not the same session, whatever that server ends up saying.
  serverURL: string;
  userId: string;
}

function readBinding(): PrincipalBinding | null {
  try {
    const raw = localStorage.getItem(PRINCIPAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PrincipalBinding> | null;
    return parsed &&
      typeof parsed.token === "string" &&
      typeof parsed.serverURL === "string" &&
      typeof parsed.userId === "string"
      ? { token: parsed.token, serverURL: parsed.serverURL, userId: parsed.userId }
      : null;
  } catch {
    return null;
  }
}

function writeBinding(binding: PrincipalBinding | null): void {
  try {
    if (binding) localStorage.setItem(PRINCIPAL_KEY, JSON.stringify(binding));
    else localStorage.removeItem(PRINCIPAL_KEY);
  } catch {
    // storage unavailable
  }
}

// The account from the last launch, when it was confirmed for exactly the
// token in storage now, by exactly the server in storage now. A binding for
// any other token or server is stale and dropped.
function restorePrincipal(): string | null {
  const bound = readBinding();
  // A binding that cannot be read is not kept around either.
  if (!bound || bound.token !== getToken() || bound.serverURL !== getServerURL()) {
    writeBinding(null);
    return null;
  }
  return bound.userId;
}

// Who the token belongs to, as the session store last confirmed. It lives here
// because pushSyncConfig is called from places that do not have the user in
// hand, and main needs the two together: a token with no principal cannot say
// whose remembered roles it is reading.
let principal: string | null = restorePrincipal();

// Set from `me()` below and nowhere else, because that is the one call where
// the server says who is signed in. A probe that failed says nothing about
// that, and letting it erase the answer would throw away the evidence the
// offline path depends on the moment the wifi drops. Signing out clears the
// token, and setToken clears this with it.
function confirmPrincipal(token: string, serverURL: string, userId: string): void {
  writeBinding({ token, serverURL, userId });
  if (principal === userId) return;
  principal = userId;
  pushSyncConfig();
}

// The token main was last told about in this session. Main refuses a user
// named in the same push as a token it has not seen, because that push cannot
// prove the user was confirmed for it (see setConfig in electron/sync.js). So
// a new token goes alone first and the account follows under it. Main's own
// record starts empty, the same as this.
let lastPushedToken: string | null = null;

// Mirror the current token + server URL into the main-process sync engine.
export function pushSyncConfig(): void {
  const bridge = getElectronAPI();
  if (!bridge?.syncConfig) return;
  const token = getToken();
  const serverURL = getServerURL();
  if (token !== lastPushedToken) {
    lastPushedToken = token;
    void bridge.syncConfig({ token, serverURL, userId: null });
    if (!principal) return;
  }
  void bridge.syncConfig({ token, serverURL, userId: principal });
}

async function api<T>(
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const token = getToken();
    const res = await fetch(`${getServerURL()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    // better-auth's bearer plugin returns the session token on auth responses
    const newToken = res.headers.get("set-auth-token");
    if (newToken) setToken(newToken);
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export interface AuthResult {
  token: string | null;
  user: MarkieUser;
}

// Failures carry a machine-readable reason alongside the message. Reading it
// off an unknown body keeps the success types honest about what they describe.
export function authFailureCode(data: unknown): string {
  const code = (data as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

export const authClient = {
  health: () => api<{ ok: boolean }>("/health"),

  me: async (): Promise<MarkieUser | null> => {
    // The answer is about the token that asked. When the session has moved
    // to another token, or another server, by the time it lands, it describes
    // a session this app no longer has, and publishing it would pair the old
    // account with the new token in main. The auth store's ticket check sits
    // above this and discards the answer too; this is the layer that keeps
    // main honest, since the push used to happen before that check.
    const asked = { token: getToken(), serverURL: getServerURL() };
    const res = await api<{ user: MarkieUser | null }>("/api/me");
    if (getToken() !== asked.token || getServerURL() !== asked.serverURL) return null;
    const user = res.data?.user ?? null;
    // Main remembers what the server said about each document, and a role
    // means nothing without the account it was said to. This answer is the
    // only place the account is confirmed, so it is where main is told, and
    // where the account is kept for the next launch.
    if (user && asked.token) confirmPrincipal(asked.token, asked.serverURL, user.id);
    return user;
  },

  // `token` is how the server says whether a session actually exists. Under
  // email verification a signup succeeds and hands back `token: null`: the
  // account is made, but nothing is signed in until the address is proven.
  signUpEmail: (email: string, password: string, name: string) =>
    api<AuthResult>("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),

  signInEmail: (email: string, password: string) =>
    api<AuthResult>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  // Signing in with a code. The server treats this as the reclaim path: if the
  // account behind the address was never proven, everything it accrued while
  // unproven (a password, a linked provider, open sessions) is revoked before
  // the session is minted, so registering somebody else's address buys nothing
  // once the real owner asks for a code. Use this when the caller is holding
  // nothing but the address.
  sendOTP: (email: string) =>
    api<{ success: boolean }>("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: JSON.stringify({ email, type: "sign-in" }),
    }),

  verifyOTP: (email: string, otp: string) =>
    api<{ user: MarkieUser }>("/api/auth/sign-in/email-otp", {
      method: "POST",
      body: JSON.stringify({ email, otp }),
    }),

  // Confirming an address the caller already holds the password for: a fresh
  // signup, or a sign-in the server refused only because the address was never
  // proven. Same code in the mailbox, different route, and the difference is
  // that this one proves the address without revoking anything. The server
  // signs the user in on success (autoSignInAfterVerification), so the token
  // comes back on the same response.
  sendVerificationCode: (email: string) =>
    api<{ success: boolean }>("/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      body: JSON.stringify({ email, type: "email-verification" }),
    }),

  verifyEmail: (email: string, otp: string) =>
    api<{ status: boolean; token: string | null; user: MarkieUser }>(
      "/api/auth/email-otp/verify-email",
      { method: "POST", body: JSON.stringify({ email, otp }) }
    ),

  // Forgotten passwords are recovered with a code, not a reset link. A link
  // has to land somewhere, and the only somewhere a desktop app owns is a
  // hosted web page plus a second deep-link hop back into the app. The OTP
  // plugin already does this in two requests without leaving Markie.
  requestPasswordReset: (email: string) =>
    api<{ success: boolean }>("/api/auth/forget-password/email-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (email: string, otp: string, password: string) =>
    api<{ success: boolean }>("/api/auth/email-otp/reset-password", {
      method: "POST",
      body: JSON.stringify({ email, otp, password }),
    }),

  signOut: async () => {
    const res = await api<{ success: boolean }>("/api/auth/sign-out", {
      method: "POST",
      body: "{}",
    });
    setToken(null);
    return res;
  },

  // Desktop Google sign-in. The whole flow must run in the browser so
  // better-auth's OAuth state cookie is present on the callback, so we just
  // open a server route that starts the flow and redirects to Google. After
  // consent, the server's desktop bridge deep-links the session back in.
  //
  // The `state` nonce rides along so the deep link that comes back can prove it
  // belongs to this sign-in. Returns null when we can't mint one, which the
  // caller must surface rather than starting an unverifiable flow.
  googleSignInURL: (): string | null => {
    const state = createAuthState();
    if (!state) return null;
    return `${getServerURL()}/auth/google-start?state=${encodeURIComponent(state)}`;
  },
};

export interface ShareMember {
  // null for a pending invite (the email hasn't joined yet)
  user_id: string | null;
  role: "viewer" | "editor";
  created_at: string;
  email: string;
  name: string | null;
  // true when this is an invited-but-not-yet-joined email
  pending?: boolean;
}

export interface ShareAccess {
  role: "owner" | "editor" | "viewer";
  canRead: boolean;
  canEdit: boolean;
  canManage: boolean;
}

// A doc I own that I've shared with people (the "shared by me" tab).
export interface SharedByMeDoc {
  id: string;
  name: string;
  updated_at: string;
  memberCount: number;
  pendingCount: number;
}

export const sharesClient = {
  access: async (docId: string): Promise<ShareAccess | null> => {
    const res = await api<{ access: ShareAccess }>(
      `/api/docs/${encodeURIComponent(docId)}/access`
    );
    return res.ok ? res.data?.access ?? null : null;
  },

  // Owned docs that have at least one collaborator or pending invite.
  // null means the request failed. An empty array would read as "you have
  // shared nothing", which is a different and much more alarming statement to
  // make to someone whose network just blipped.
  sharedByMe: async (): Promise<SharedByMeDoc[] | null> => {
    const res = await api<{ docs: SharedByMeDoc[] }>("/api/docs/shared-by-me");
    return res.ok ? res.data?.docs ?? [] : null;
  },

  list: async (docId: string): Promise<ShareMember[] | null> => {
    const res = await api<{ shares: ShareMember[] }>(
      `/api/docs/${encodeURIComponent(docId)}/shares`
    );
    return res.ok ? res.data?.shares ?? [] : null;
  },

  add: async (
    docId: string,
    email: string,
    role: "viewer" | "editor"
  ): Promise<{ ok: boolean; status?: "member" | "invited"; error?: string }> => {
    const res = await api<{ ok?: boolean; status?: "member" | "invited"; error?: string }>(
      `/api/docs/${encodeURIComponent(docId)}/shares`,
      { method: "POST", body: JSON.stringify({ email, role }) }
    );
    if (res.ok) return { ok: true, status: res.data?.status };
    return { ok: false, error: res.data?.error ?? "Couldn't share the doc" };
  },

  // idOrEmail: a user id (member) or an email (pending invite)
  remove: async (docId: string, idOrEmail: string): Promise<boolean> => {
    const res = await api<{ ok?: boolean }>(
      `/api/docs/${encodeURIComponent(docId)}/shares/${encodeURIComponent(idOrEmail)}`,
      { method: "DELETE" }
    );
    return res.ok;
  },

  getPublicLink: async (docId: string): Promise<string | null> => {
    const res = await api<{ url: string | null }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`
    );
    return res.ok ? res.data?.url ?? null : null;
  },

  createPublicLink: async (docId: string): Promise<string | null> => {
    const res = await api<{ url?: string }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`,
      { method: "POST", body: "{}" }
    );
    return res.ok ? res.data?.url ?? null : null;
  },

  revokePublicLink: async (docId: string): Promise<boolean> => {
    const res = await api<{ ok?: boolean }>(
      `/api/docs/${encodeURIComponent(docId)}/public-link`,
      { method: "DELETE" }
    );
    return res.ok;
  },
};

const SYNC_KEY = "markie.sync.v1";

export function getSyncEnabled(): boolean {
  try {
    return localStorage.getItem(SYNC_KEY) === "true";
  } catch {
    return false;
  }
}

export function setSyncEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SYNC_KEY, String(enabled));
  } catch {
    // storage unavailable
  }
}
