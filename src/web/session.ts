// The web app's session: the cookie the web sign-in set on the API origin
// (server/src/web-signin.ts), which the page names (server/src/web-app.ts).
// The app may be served on another host, the docs host (markiedocs.com on
// Markie Cloud), which is the same site as the API host, so a credentialed
// fetch to the API carries that host-only cookie and the server's CORS answer
// names the docs host exactly. better-auth's get-session reads the cookie and
// answers with the session, token included; the token goes into the auth
// client in memory only (startWebSession), so the share dialog, comments and
// collab tickets reuse the clients the desktop already has, unchanged.
import { startWebSession } from "@/lib/auth-client";

const TOKEN_SHAPE = /^[\x21-\x7e]{16,1024}$/;
// The server's own websocket, named by the page (server/src/web-app.ts):
// ws(s)://host[:port]/collab and nothing else.
const COLLAB_BASE = /^wss?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/collab$/;
// Plain http and ws only for a development server: loopback, or the reserved
// .test and .localhost names (RFC 6761), which no public resolver answers.
const DEV_HOST = /^(?:localhost|127\.0\.0\.1|[A-Za-z0-9.-]+\.(?:test|localhost))$/;

export interface WebSessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * What booting found. Only "signed-out" sends the browser to the sign-in:
 * anything else the server answered (a rate limit, an outage) is shown as an
 * error, since the sign-in would send a browser with a valid session straight
 * back here and the two would bounce for ever.
 */
export type WebBoot =
  | { kind: "signed-in"; user: WebSessionUser }
  | { kind: "signed-out" }
  | { kind: "error"; status: number };

/** The live-editing socket the page names, or null to use the API origin's own. */
export function collabBaseFrom(doc: Pick<Document, "querySelector">): string | null {
  const value = doc.querySelector('meta[name="markie-collab"]')?.getAttribute("content") ?? "";
  if (!COLLAB_BASE.test(value)) return null;
  // Plain ws only to a development server.
  if (value.startsWith("ws:") && !DEV_HOST.test(new URL(value).hostname)) return null;
  return value;
}

/**
 * The API origin the page names, or `fallback` (the page's own origin) when
 * it names none or names something that is not an exact https origin (plain
 * http only for a development server).
 */
export function apiOriginFrom(doc: Pick<Document, "querySelector">, fallback: string): string {
  const value = doc.querySelector('meta[name="markie-api"]')?.getAttribute("content") ?? "";
  try {
    const url = new URL(value);
    const ok = url.protocol === "https:" || (url.protocol === "http:" && DEV_HOST.test(url.hostname));
    if (ok && url.origin === value && !url.username && !url.password) return url.origin;
  } catch {
    // Not a URL: use the page's own origin.
  }
  return fallback;
}

/** Ask the API origin who this browser is signed in as. */
export async function bootWebSession(apiOrigin: string, collabBase: string | null, fetcher: typeof fetch = fetch): Promise<WebBoot> {
  const response = await fetcher(`${apiOrigin}/api/auth/get-session`, { credentials: "include", cache: "no-store" });
  if (response.status === 401) return { kind: "signed-out" };
  if (!response.ok) return { kind: "error", status: response.status };
  const data = (await response.json().catch(() => undefined)) as
    | { session?: { token?: unknown }; user?: { id?: unknown; email?: unknown; name?: unknown } }
    | null
    | undefined;
  // better-auth answers 200 with null when there is no session.
  if (data === null || (data && !data.session && !data.user)) return { kind: "signed-out" };
  const token = data?.session?.token;
  const user = data?.user;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token) || !user || typeof user.id !== "string" || typeof user.email !== "string") {
    return { kind: "error", status: response.status };
  }
  startWebSession(apiOrigin, token, collabBase);
  return { kind: "signed-in", user: { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : "" } };
}

const SIGN_IN_MARK = "markie-web-sign-in-sent";
// Longer than a sign-in takes to come back, short enough that a later visit
// is never mistaken for a bounce.
const BOUNCE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Whether sending this browser to the sign-in now would bounce: it was sent
 * there moments ago and came back still signed out. That happens when the
 * sign-in sees a session this page cannot (cookies blocked for the API host),
 * and it would otherwise loop. `storage` is sessionStorage, per tab.
 */
export function signInWouldBounce(storage: Pick<Storage, "getItem">, now = Date.now()): boolean {
  const sent = Number(storage.getItem(SIGN_IN_MARK));
  return Number.isFinite(sent) && sent > 0 && now - sent < BOUNCE_WINDOW_MS;
}

export function markSignInSent(storage: Pick<Storage, "setItem">, now = Date.now()): void {
  storage.setItem(SIGN_IN_MARK, String(now));
}

export function clearSignInMark(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(SIGN_IN_MARK);
}
