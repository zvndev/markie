// Markie Cloud answers on two names while it moves hosts: the Railway
// hostname every released app calls, and api.markiedocs.com. The JSON API
// is served on both. Browser pages are not, because they set cookies on the
// host they run on, while better-auth builds the Google callback and every
// link it hands out from BETTER_AUTH_URL. A Google sign-in started on one
// name and finished on the other has no state cookie and fails.
//
// So a browser page request that arrives on the other name is sent to the
// same path and query on BETTER_AUTH_URL's origin before anything runs.
// Only the official deployment has another name (deployment.ts apiAliases);
// a self-hosted server never redirects.

// The pages a person's browser opens on the API host: desktop Google
// sign-in and its bridge, and linking a Google account. /api/* is the API,
// including /api/auth/*, and is served wherever it is asked. /s, /d and
// /download reach this server through markiedocs.com's proxy and must stay.
const BROWSER_PAGE = /^\/(?:auth|account)(?:\/|$)/;

function hostOf(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  if (!first) return null;
  try {
    return new URL(`https://${first}`).host;
  } catch {
    return null;
  }
}

/**
 * Where to send this request instead, or null to serve it here. The host
 * the browser asked for is X-Forwarded-Host when a proxy set one, otherwise
 * Host (Railway's edge keeps the name the browser used in both). Only a host that is one of this
 * deployment's other names is redirected; any other host, including one a
 * proxy in front of us names, is served as before. The target is always
 * the configured origin, never anything taken from the request but the
 * path and query.
 */
export function canonicalHostRedirect(request: Request, deployment: { origin: string; apiAliases: readonly string[] }): string | null {
  if (deployment.apiAliases.length === 0) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!BROWSER_PAGE.test(url.pathname)) return null;
  const host = hostOf(request.headers.get("x-forwarded-host")) ?? hostOf(request.headers.get("host")) ?? url.host;
  const canonical = new URL(deployment.origin);
  if (host === canonical.host) return null;
  if (!deployment.apiAliases.some((alias) => new URL(alias).host === host)) return null;
  return `${canonical.origin}${url.pathname}${url.search}`;
}
