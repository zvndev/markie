// The web app's session: the cookie the web sign-in set on this origin
// (server/src/web-signin.ts). better-auth's get-session reads that cookie and
// answers with the session, token included; the token goes into the auth
// client in memory only (startWebSession), so the share dialog, comments and
// collab tickets reuse the clients the desktop already has, unchanged.
import { startWebSession } from "@/lib/auth-client";

const TOKEN_SHAPE = /^[\x21-\x7e]{16,1024}$/;
// The server's own websocket, named by the page (server/src/web-app.ts):
// ws(s)://host[:port]/collab and nothing else.
const COLLAB_BASE = /^wss?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/collab$/;

export interface WebSessionUser {
  id: string;
  email: string;
  name: string;
}

/** The live-editing socket the page names, or null to use this origin's own. */
export function collabBaseFrom(doc: Pick<Document, "querySelector">): string | null {
  const value = doc.querySelector('meta[name="markie-collab"]')?.getAttribute("content") ?? "";
  if (!COLLAB_BASE.test(value)) return null;
  // Plain ws only to a loopback server in development.
  if (value.startsWith("ws:") && !/^ws:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(value)) return null;
  return value;
}

/** The signed-in account, or null when this browser has no session here. */
export async function bootWebSession(origin: string, collabBase: string | null, fetcher: typeof fetch = fetch): Promise<WebSessionUser | null> {
  const response = await fetcher(`${origin}/api/auth/get-session`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  const data = (await response.json().catch(() => null)) as { session?: { token?: unknown }; user?: { id?: unknown; email?: unknown; name?: unknown } } | null;
  const token = data?.session?.token;
  const user = data?.user;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token) || !user || typeof user.id !== "string" || typeof user.email !== "string") return null;
  startWebSession(origin, token, collabBase);
  return { id: user.id, email: user.email, name: typeof user.name === "string" ? user.name : "" };
}
