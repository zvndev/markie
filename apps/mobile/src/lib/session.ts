// The signed-in session: one bearer token, bound to the origin that issued it.
//
// It lives in the iOS Keychain or the Android Keystore (secure-store.ts), and
// nowhere else: never localStorage, never Preferences, never a cookie jar
// (native-http.ts clears those). Token and origin are stored as one record, so
// a token can only ever be sent back to the server it came from.
import { normalizeServerOrigin } from "./server-origin";

export interface SecureKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StoredSession {
  origin: string;
  token: string;
  email: string;
  name: string;
  userId: string;
}

export const SESSION_KEY = "markie.mobile.session.v1";
const TOKEN_SHAPE = /^[\x21-\x7e]{16,1024}$/;

function validSession(value: unknown): StoredSession | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.token !== "string" || !TOKEN_SHAPE.test(raw.token)) return null;
  if (typeof raw.origin !== "string") return null;
  const origin = normalizeServerOrigin(raw.origin);
  if (!origin.ok || origin.origin !== raw.origin) return null;
  if (typeof raw.email !== "string" || raw.email.length > 320) return null;
  return {
    origin: origin.origin,
    token: raw.token,
    email: raw.email,
    name: typeof raw.name === "string" ? raw.name.slice(0, 256) : "",
    userId: typeof raw.userId === "string" ? raw.userId.slice(0, 128) : "",
  };
}

export function createSessionStore(kv: SecureKeyValue) {
  return {
    /** The stored session, or null. A record that fails validation is removed, not trusted. */
    async load(): Promise<StoredSession | null> {
      let text: string | null;
      try {
        text = await kv.get(SESSION_KEY);
      } catch {
        // An unreadable item (a Keystore key lost to a restore, a Keychain
        // error) is the same as no session: sign in again.
        await kv.remove(SESSION_KEY).catch(() => undefined);
        return null;
      }
      if (!text) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const session = validSession(parsed);
      if (!session) await kv.remove(SESSION_KEY).catch(() => undefined);
      return session;
    },

    async save(session: StoredSession): Promise<void> {
      const valid = validSession(session);
      if (!valid) throw new Error("Refusing to store an invalid session.");
      await kv.set(SESSION_KEY, JSON.stringify(valid));
    },

    async clear(): Promise<void> {
      await kv.remove(SESSION_KEY);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** For a desktop browser during development: memory only, gone on reload. */
export function memoryKeyValue(): SecureKeyValue {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}
