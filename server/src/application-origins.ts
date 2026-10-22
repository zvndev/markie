import { cloudApiAliases, officialFlag } from "./official.ts";

// The dev renderer (`next dev` / Vite on :3000). Trusted only outside
// production: a credentialed CORS grant to localhost in production hands any
// page a user happens to be running on that port their Markie session.
const DEVELOPMENT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

// The official website. Trusted by the official deployment only: a self-hosted
// server holds sessions for its own people, and no page on markiedocs.com has
// any business making credentialed requests to it.
const OFFICIAL_WEB_ORIGINS = ["https://markiedocs.com", "https://www.markiedocs.com"];

/**
 * One explicit allowlist for browser CORS and authentication, never '*'.
 *
 * Loopback origins are development-only. Production gets them only by naming
 * them in MARKIE_WEB_ORIGINS, which is the explicit opt-in. The desktop app's
 * own origin, app://markie, is trusted by every server.
 */
export function applicationOrigins(
  env: { MARKIE_WEB_ORIGINS?: string; NODE_ENV?: string; MARKIE_OFFICIAL?: string; BETTER_AUTH_URL?: string } = process.env
): string[] {
  const official = officialFlag(env);
  const origins = new Set([
    "app://markie",
    ...(env.NODE_ENV === "production" ? [] : DEVELOPMENT_ORIGINS),
    ...(official ? OFFICIAL_WEB_ORIGINS : []),
  ]);
  // A self-hosted server's pages are served from its own origin. Same-origin
  // requests need no CORS grant, but naming it keeps better-auth's origin
  // check and the CORS answer reading from one list.
  if (!official && env.BETTER_AUTH_URL) origins.add(new URL(env.BETTER_AUTH_URL).origin);
  // Markie Cloud answers on two names while it moves hosts. better-auth
  // trusts its own BETTER_AUTH_URL already; the other name is the same
  // server, so a page it served before the move can still finish what it
  // started.
  for (const alias of cloudApiAliases(env)) origins.add(alias);
  const additional = env.MARKIE_WEB_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (additional.length > 16) throw new Error("Too many configured browser origins.");
  for (const value of additional) {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") {
      throw new Error("Browser origins must be exact HTTPS origins or loopback development origins.");
    }
    origins.add(url.origin);
  }
  return [...origins];
}
