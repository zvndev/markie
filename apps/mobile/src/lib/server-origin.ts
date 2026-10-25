// The server a session belongs to. Markie Cloud by default; a self-hoster
// types their own under "Advanced" on the sign-in screen.
//
// The origin is the only place a bearer token is ever sent, so it is held to
// the same rule the server holds its own browser origins to
// (server/src/application-origins.ts): an exact https origin, or plain http
// only on a loopback address for local development. No path, no query, no
// credentials in the URL.
import { CLOUD_ORIGIN, canonicalCloudOrigin, isCloudOrigin } from "@/lib/cloud-origin";

export const DEFAULT_SERVER_ORIGIN = CLOUD_ORIGIN;

// 10.0.2.2 is the Android emulator's name for the host machine, which is where
// the mock server runs during development.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "10.0.2.2"]);

export type OriginResult = { ok: true; origin: string } | { ok: false; error: string };

export function normalizeServerOrigin(input: string): OriginResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a server address." };
  if (raw.length > 512) return { ok: false, error: "That server address is too long." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a server address." };
  }
  if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address." };
  if (url.pathname !== "/" || url.search || url.hash) {
    return { ok: false, error: "Use just the server's address, like https://markie.example.com." };
  }
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, error: "The server must use https." };
  } else if (url.protocol !== "https:") {
    return { ok: false, error: "The server must use https." };
  }
  return { ok: true, origin: String(canonicalCloudOrigin(url.origin)) };
}

export function isMarkieCloud(origin: string): boolean {
  return isCloudOrigin(canonicalCloudOrigin(origin) as string);
}

/** What Settings and the sign-in screen call a server. */
export function serverLabel(origin: string): string {
  if (isMarkieCloud(origin)) return "Markie Cloud";
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// The server address chosen before signing in. Not a secret: it is the same
// for everyone who uses that server, and the token is never stored with it
// here (see session.ts).
const ORIGIN_KEY = "markie.mobile.server.v1";

export function loadPreferredOrigin(storage: Pick<Storage, "getItem"> | null = safeLocalStorage()): string {
  const saved = storage?.getItem(ORIGIN_KEY);
  if (!saved) return DEFAULT_SERVER_ORIGIN;
  const parsed = normalizeServerOrigin(saved);
  return parsed.ok ? parsed.origin : DEFAULT_SERVER_ORIGIN;
}

export function savePreferredOrigin(origin: string, storage: Pick<Storage, "setItem"> | null = safeLocalStorage()): void {
  try {
    storage?.setItem(ORIGIN_KEY, origin);
  } catch {
    // Storage full or unavailable: the default stays in effect.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
