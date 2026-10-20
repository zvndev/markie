// Desktop sign-in leaves the app: we open the system browser, and the server
// hands the session back through a `markie://auth?token=…` deep link. Markie is
// the registered protocol handler, so *any* web page can fire that deep link.
// A token on its own therefore proves nothing about who asked for it, and
// adopting one unconditionally lets a hostile page sign the user into an
// attacker's account, after which every synced document lands in that account.
//
// So we mint a single-use nonce before opening the browser, pass it through the
// OAuth flow, and adopt a token only when it comes back carrying that exact
// nonce. Unsolicited deep links have nothing to present and are rejected.
//
// With more than one server, the nonce also names the server it was minted
// for. A token that comes back is that server's token: it is stored for that
// origin and sent to that origin, and nowhere else. The deep link itself
// never gets to say which server it is from.

const STATE_KEY = "markie.authstate.v1";

// A sign-in that takes longer than this was almost certainly abandoned. Bounding
// the lifetime keeps a forgotten nonce from sitting in storage indefinitely.
export const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Long enough that guessing is hopeless, short enough to sit in a URL.
const NONCE_BYTES = 16;

export interface AuthStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredState {
  value: string;
  createdAt: number;
  // The server the sign-in was started against. Absent on a nonce minted by
  // a build from before there were several servers, which only ever signed
  // in to the primary one.
  origin?: string;
}

function defaultStorage(): AuthStateStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Not provided means "find the browser's storage". Provided as null means the
// caller is telling us there is none, and honouring that is the difference
// between a test that proves the fail-closed path and one that only passes on
// a machine whose Node has no localStorage global.
function resolveStorage(storage: AuthStateStorage | null | undefined): AuthStateStorage | null {
  return storage === undefined ? defaultStorage() : storage;
}

function randomNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  // Fail closed: without a real CSPRNG a predictable nonce is worse than no
  // sign-in, because it looks like protection while providing none.
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function read(storage: AuthStateStorage): StoredState | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STATE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (typeof parsed?.value !== "string" || typeof parsed?.createdAt !== "number") {
      return null;
    }
    if (parsed.origin !== undefined && typeof parsed.origin !== "string") return null;
    return typeof parsed.origin === "string"
      ? { value: parsed.value, createdAt: parsed.createdAt, origin: parsed.origin }
      : { value: parsed.value, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/**
 * Mint a nonce for a sign-in that is about to start, replacing any previous
 * one. Returns null when there is no storage or no CSPRNG to build on, which
 * the caller must treat as "cannot start sign-in safely". `origin` is the
 * server the sign-in is for.
 */
export function createAuthState(opts?: {
  storage?: AuthStateStorage | null;
  now?: number;
  origin?: string;
}): string | null {
  const storage = resolveStorage(opts?.storage);
  if (!storage) return null;
  let value: string;
  try {
    value = randomNonce();
  } catch {
    return null;
  }
  const record: StoredState = {
    value,
    createdAt: opts?.now ?? Date.now(),
    ...(opts?.origin ? { origin: opts.origin } : {}),
  };
  try {
    storage.setItem(STATE_KEY, JSON.stringify(record));
  } catch {
    return null;
  }
  return value;
}

/**
 * Check the nonce a deep link presented against the pending one, and consume
 * the pending nonce either way. Single use: a replayed deep link finds nothing
 * left to match, so a token that leaks cannot be re-adopted later.
 */
export function consumeAuthState(
  candidate: string | null | undefined,
  opts?: { storage?: AuthStateStorage | null; now?: number }
): boolean {
  return consumeAuthStateFor(candidate, opts).ok;
}

/**
 * The same check, answering which server the matching sign-in was for.
 * `origin` is null for a nonce minted before nonces named one, which the
 * caller reads as the primary server, the only one such a build knew.
 */
export function consumeAuthStateFor(
  candidate: string | null | undefined,
  opts?: { storage?: AuthStateStorage | null; now?: number }
): { ok: true; origin: string | null } | { ok: false } {
  const storage = resolveStorage(opts?.storage);
  if (!storage) return { ok: false };
  const pending = read(storage);
  clearAuthState({ storage });
  if (!pending || !candidate) return { ok: false };
  if ((opts?.now ?? Date.now()) - pending.createdAt > AUTH_STATE_TTL_MS) return { ok: false };
  if (pending.value !== candidate) return { ok: false };
  return { ok: true, origin: pending.origin ?? null };
}

export function clearAuthState(opts?: { storage?: AuthStateStorage | null }): void {
  const storage = resolveStorage(opts?.storage);
  if (!storage) return;
  try {
    storage.removeItem(STATE_KEY);
  } catch {
    // storage unavailable; nothing pending to clear
  }
}
