// The dev renderer (`next dev` / Vite on :3000). Trusted only outside
// production: a credentialed CORS grant to localhost in production hands any
// page a user happens to be running on that port their Markie session.
const DEVELOPMENT_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

/**
 * One explicit allowlist for browser CORS and authentication, never '*'.
 *
 * Loopback origins are development-only. Production gets them only by naming
 * them in MARKIE_WEB_ORIGINS, which is the explicit opt-in.
 */
export function applicationOrigins(env: { MARKIE_WEB_ORIGINS?: string; NODE_ENV?: string } = process.env): string[] {
  const origins = new Set([
    "app://markie",
    ...(env.NODE_ENV === "production" ? [] : DEVELOPMENT_ORIGINS),
    "https://markiedocs.com",
    "https://www.markiedocs.com",
  ]);
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
