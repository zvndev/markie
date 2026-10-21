// MARKIE_OFFICIAL, read in one place. Unset means the official Markie Cloud,
// so the live deployment keeps every guard it has without setting anything;
// a self-hosted server declares itself with MARKIE_OFFICIAL=0. See deployment.ts.
export function officialFlag(env: { MARKIE_OFFICIAL?: string }): boolean {
  const raw = env.MARKIE_OFFICIAL?.trim();
  if (raw === undefined || raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  throw new Error("MARKIE_OFFICIAL must be 1 (the official Markie Cloud) or 0 (a self-hosted server).");
}

// Markie Cloud's API, at the name it is reached by now and every name it had.
// Old desktop builds keep calling the Railway hostname for as long as they
// run, so the official deployment answers on all of them. The desktop app
// keeps the same list in electron/cloud-origin.json; deployment.test.ts holds
// the two together.
export const CLOUD_API_ORIGIN = "https://api.markiedocs.com";
export const CLOUD_API_LEGACY_ORIGINS: readonly string[] = ["https://api-production-602f.up.railway.app"];
export const CLOUD_API_ORIGINS: readonly string[] = [CLOUD_API_ORIGIN, ...CLOUD_API_LEGACY_ORIGINS];

/**
 * The other origins an official deployment's API is reached on, when
 * BETTER_AUTH_URL is one of Markie Cloud's: before the move that is
 * api.markiedocs.com, after it the Railway hostname. Empty for every other
 * server, self-hosted or a local one.
 */
export function cloudApiAliases(env: { MARKIE_OFFICIAL?: string; BETTER_AUTH_URL?: string }): string[] {
  if (!officialFlag(env) || !env.BETTER_AUTH_URL) return [];
  let origin: string;
  try {
    origin = new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return [];
  }
  return CLOUD_API_ORIGINS.includes(origin) ? CLOUD_API_ORIGINS.filter((o) => o !== origin) : [];
}
