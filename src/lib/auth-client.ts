// Thin client for the Markie API (better-auth REST endpoints).
// Sessions use bearer tokens; the token is mirrored to the Electron main
// process (sync engine) whenever it changes.
import { getElectronAPI } from "@/lib/electron";

export interface MarkieUser {
  id: string;
  email: string;
  name: string;
}

const SERVER_KEY = "markie.server.v1";
const DEFAULT_SERVER = "http://localhost:8787";

export function getServerURL(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export function setServerURL(url: string): void {
  try {
    localStorage.setItem(SERVER_KEY, url.replace(/\/$/, ""));
  } catch {
    // storage unavailable — keep default
  }
}

const TOKEN_KEY = "markie.token.v1";

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
  pushSyncConfig();
}

// Mirror the current token + server URL into the main-process sync engine.
export function pushSyncConfig(): void {
  getElectronAPI()?.syncConfig?.({
    token: getToken(),
    serverURL: getServerURL(),
  });
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

export const authClient = {
  health: () => api<{ ok: boolean }>("/health"),

  me: async (): Promise<MarkieUser | null> => {
    const res = await api<{ user: MarkieUser | null }>("/api/me");
    return res.data?.user ?? null;
  },

  signUpEmail: (email: string, password: string, name: string) =>
    api<{ user: MarkieUser }>("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),

  signInEmail: (email: string, password: string) =>
    api<{ user: MarkieUser }>("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

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

  signOut: async () => {
    const res = await api<{ success: boolean }>("/api/auth/sign-out", {
      method: "POST",
      body: "{}",
    });
    setToken(null);
    return res;
  },

  googleSignInURL: (): string =>
    `${getServerURL()}/api/auth/sign-in/social?provider=google`,
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
