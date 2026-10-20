// Sessions on Markie servers other than the primary one.
//
// "Accounts live where the document lives": to work on a document on
// someone's own Markie server you sign in to that server, possibly as a guest,
// and that session is used for that server's documents and nothing else. The
// primary server (Markie Cloud) keeps its own client in auth-client.ts,
// untouched, so someone who never adds a server sees nothing change.
//
// Each other server's token and confirmed account sit under the primary's
// storage keys with "@<origin>" on the end. Which servers are trusted at all
// is main's decision (electron/servers.js): it refuses a session, and every
// request, for any other origin.
import { useEffect, useSyncExternalStore } from "react";
import { getElectronAPI, type MarkieServer } from "@/lib/electron";
import { createAuthState } from "@/lib/auth-state";
import {
  collabWsBase,
  getAuthToken,
  getServerURL,
  makeSharesClient,
  sharesClient,
  type ApiRequest,
  type AuthResult,
  type MarkieUser,
  type SharesClient,
} from "@/lib/auth-client";
import { authStore, createAuthStore, type AuthSnapshot, type AuthStore } from "@/lib/auth-store";

const TOKEN_KEY = "markie.token.v1";
const PRINCIPAL_KEY = "markie.auth.principal.v1";

/** The primary server: Markie Cloud, or a dev build's localhost override. */
export function isPrimaryServer(origin: string | null | undefined): boolean {
  return !origin || origin === getServerURL();
}

const tokenKey = (origin: string) => `${TOKEN_KEY}@${origin}`;
const principalKey = (origin: string) => `${PRINCIPAL_KEY}@${origin}`;

// Settings and the share surfaces redraw when a server's session moves.
const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of listeners) l();
}
export function subscribeServerSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function useServerSessionsVersion(): number {
  return useSyncExternalStore(subscribeServerSessions, () => version, () => 0);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/** The token for `origin`, from whichever client owns it. */
export function getServerToken(origin: string | null | undefined): string | null {
  if (isPrimaryServer(origin)) return getAuthToken();
  return read(tokenKey(origin!));
}

interface Binding {
  token: string;
  serverURL: string;
  userId: string;
}

function readBinding(origin: string): Binding | null {
  try {
    const parsed = JSON.parse(read(principalKey(origin)) ?? "null") as Partial<Binding> | null;
    return parsed && typeof parsed.token === "string" && typeof parsed.serverURL === "string" && typeof parsed.userId === "string"
      ? { token: parsed.token, serverURL: parsed.serverURL, userId: parsed.userId }
      : null;
  } catch {
    return null;
  }
}

// Who each server's token belongs to, as that server last confirmed. Read
// back from storage only when it was confirmed for exactly the stored token
// by exactly that server; anything else is stale and dropped.
const principals = new Map<string, string | null>();
function principalOf(origin: string): string | null {
  if (!principals.has(origin)) {
    const bound = readBinding(origin);
    const ok = bound && bound.token === read(tokenKey(origin)) && bound.serverURL === origin;
    if (!ok) write(principalKey(origin), null);
    principals.set(origin, ok ? bound!.userId : null);
  }
  return principals.get(origin) ?? null;
}

// The token main was last told about, per server. Main refuses an account
// named in the same push as a token it has not seen (setSession in
// electron/sync.js), so a new token goes alone first and the account
// follows under it.
const lastPushed = new Map<string, string | null>();

function pushServerSession(origin: string): void {
  const bridge = getElectronAPI();
  if (!bridge?.syncSession) return;
  const token = read(tokenKey(origin));
  const principal = principalOf(origin);
  if (token !== (lastPushed.get(origin) ?? null)) {
    lastPushed.set(origin, token);
    void bridge.syncSession({ origin, token, userId: null }).catch(() => {});
    if (!principal) return;
  }
  if (token) void bridge.syncSession({ origin, token, userId: principal }).catch(() => {});
}

/** Store (or clear) one non-primary server's token. */
export function setServerToken(origin: string, token: string | null): void {
  if (isPrimaryServer(origin)) return;
  const before = read(tokenKey(origin));
  write(tokenKey(origin), token);
  // A different token is a different session, whoever it belongs to.
  if (!token || token !== before) {
    principals.set(origin, null);
    write(principalKey(origin), null);
  }
  pushServerSession(origin);
  if (token !== before) changed();
}

function confirm(origin: string, token: string, userId: string): void {
  write(principalKey(origin), JSON.stringify({ token, serverURL: origin, userId }));
  if (principalOf(origin) === userId) return;
  principals.set(origin, userId);
  pushServerSession(origin);
  changed();
}

/** The servers other than the primary that hold a stored token. */
export function storedServerOrigins(): string[] {
  const out: string[] = [];
  try {
    const prefix = `${TOKEN_KEY}@`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        const origin = key.slice(prefix.length);
        if (origin && !isPrimaryServer(origin)) out.push(origin);
      }
    }
  } catch {
    // storage unavailable
  }
  return out.sort();
}

/** Hand every stored non-primary session to main, at launch. */
export function pushServerSessions(): void {
  for (const origin of storedServerOrigins()) pushServerSession(origin);
}

/** A server the user removed: its token and account go with it. */
export function forgetServerSession(origin: string): void {
  if (isPrimaryServer(origin)) return;
  write(tokenKey(origin), null);
  write(principalKey(origin), null);
  principals.delete(origin);
  lastPushed.delete(origin);
  stores.delete(origin);
  changed();
}

// One request to a non-primary server with that server's token. A token the
// server hands back on an auth response is kept only when the session did
// not move while the request was out.
function serverApi(origin: string): ApiRequest {
  return async <T,>(path: string, init?: RequestInit) => {
    const token = read(tokenKey(origin));
    // In the app, main makes the call: the window's content security policy
    // only learns a newly added server on the next load.
    const bridge = getElectronAPI();
    if (bridge?.serverRequest) {
      const res = await bridge
        .serverRequest({
          origin,
          path,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
          token,
        })
        .catch(() => null);
      if (!res) return { ok: false, status: 0, data: null };
      if (read(tokenKey(origin)) !== token) return { ok: false, status: 0, data: null };
      if (res.ok && res.setAuthToken) setServerToken(origin, res.setAuthToken);
      return { ok: res.ok, status: res.status, data: (res.data ?? null) as T | null };
    }
    try {
      const res = await fetch(`${origin}${path}`, {
        ...init,
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (read(tokenKey(origin)) !== token) return { ok: false, status: 0, data: null };
      const fresh = res.headers.get("set-auth-token");
      if (res.ok && fresh) setServerToken(origin, fresh);
      const data = (await res.json().catch(() => null)) as T | null;
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  };
}

/** Authenticated fetch for other per-server calls (comments). */
export function serverFetch(origin: string, path: string, init?: RequestInit): Promise<Response> {
  const token = getServerToken(origin);
  return fetch(`${isPrimaryServer(origin) ? getServerURL() : origin}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Sign-in against a non-primary server: email and password, and Google when
 * that server says it offers it. The email-code flows stay Markie Cloud's.
 */
export function serverAuthClient(origin: string) {
  const api = serverApi(origin);
  return {
    me: async (): Promise<MarkieUser | null> => {
      const asked = read(tokenKey(origin));
      if (!asked) return null;
      const res = await api<{ user: MarkieUser | null }>("/api/me");
      // An answer about a token this server's session has moved past says
      // nothing about the session it has now.
      if (read(tokenKey(origin)) !== asked) return null;
      const user = res.data?.user ?? null;
      if (user) confirm(origin, asked, user.id);
      return user;
    },
    signInEmail: (email: string, password: string) =>
      api<AuthResult>("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) }),
    signUpEmail: (email: string, password: string, name: string) =>
      api<AuthResult>("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, password, name }) }),
    signOut: async () => {
      const asked = read(tokenKey(origin));
      const res = await api<{ success: boolean }>("/api/auth/sign-out", { method: "POST", body: "{}" });
      if (read(tokenKey(origin)) === asked) setServerToken(origin, null);
      return res;
    },
    // The nonce names this server, so the token the deep link brings back is
    // stored for this server and sent only to it.
    googleSignInURL: (): string | null => {
      const state = createAuthState({ origin });
      return state ? `${origin}/auth/google-start?state=${encodeURIComponent(state)}` : null;
    },
  };
}

export type ServerAuthClient = ReturnType<typeof serverAuthClient>;

const shareClients = new Map<string, SharesClient>();
/** Sharing goes to the server the document lives on. */
export function sharesClientFor(origin: string | null | undefined): SharesClient {
  if (isPrimaryServer(origin)) return sharesClient;
  let c = shareClients.get(origin!);
  if (!c) {
    c = makeSharesClient(serverApi(origin!));
    shareClients.set(origin!, c);
  }
  return c;
}

const stores = new Map<string, AuthStore>();
/** The session store for one server; the primary's is the app-wide authStore. */
export function authStoreFor(origin: string | null | undefined): AuthStore {
  if (isPrimaryServer(origin)) return authStore;
  let s = stores.get(origin!);
  if (!s) {
    const client = serverAuthClient(origin!);
    s = createAuthStore({ fetchUser: () => client.me(), signOut: () => client.signOut() });
    stores.set(origin!, s);
  }
  return s;
}

const CHECKING: AuthSnapshot = { user: null, status: "checking" };
/** Subscribe a component to one server's session. */
export function useAuthFor(origin: string | null | undefined): AuthSnapshot {
  const store = authStoreFor(origin);
  useEffect(() => {
    void store.ready();
  }, [store]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => CHECKING);
}

export function collabWsBaseFor(origin: string | null | undefined): string {
  return isPrimaryServer(origin) ? collabWsBase() : `${origin!.replace(/^http/, "ws")}/collab`;
}

// The trusted server list as main last reported it, for labels: the server
// badge in the Library and the Cloud page. Never a source of trust itself.
let trustedServers: MarkieServer[] = [];
const serverListeners = new Set<() => void>();

export function refreshTrustedServers(): Promise<void> {
  const bridge = getElectronAPI();
  if (!bridge?.serversList) return Promise.resolve();
  return bridge
    .serversList()
    .then((list) => {
      trustedServers = Array.isArray(list) ? list : [];
      for (const l of serverListeners) l();
    })
    .catch(() => {});
}

export function useTrustedServers(): MarkieServer[] {
  // Asked again on every mount: one local IPC call, and a server added or
  // removed in Settings shows up the next time a list opens.
  useEffect(() => {
    void refreshTrustedServers();
  }, []);
  return useSyncExternalStore(
    (l) => {
      serverListeners.add(l);
      return () => void serverListeners.delete(l);
    },
    () => trustedServers,
    () => trustedServers
  );
}

/** The name to show for a server: its own, or its host. */
export function serverLabel(origin: string, list: MarkieServer[] = trustedServers): string {
  const known = list.find((s) => s.origin === origin);
  if (known) return known.name;
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
