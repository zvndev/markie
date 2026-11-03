// Hosted documents are linked on their own origin when MARKIE_DOCS_ORIGIN
// names one (deployment.ts). On Markie Cloud that is https://markiedocs.com,
// whose Vercel rewrites proxy /d and /s to this server. A public page
// (/s/<token>) a browser opens on one of this server's API names is sent to
// the same path and query on the docs origin, so an old link lands where new
// ones do.
//
// Only that page, and only when a browser is navigating to it. /s/<token>/raw
// and /s/<token>/assets are fetched by the phone app and the desktop from
// code that refuses redirects on purpose (apps/mobile/src/lib/native-http.ts
// and http.ts, electron/share-open.js), so they are always answered where
// they are asked for. /d/<id> is never redirected here: its invite and
// wrong-account pages are decided by the session on the API host, so
// doc-view.ts resolves who is asking first and only then sends a reader's
// browser on to the read view on the docs host (with onApiHost below).
//
// Requests through the website's proxy reach this server on the API host as
// well, so the host alone cannot tell the two apart. What the browser asked
// for is X-Forwarded-Host when a proxy set one, as canonical-host.ts reads
// it; the box's HAProxy and kamal-proxy pass a client's X-Forwarded-Host
// through unchanged (checked against production 2026-11-03). So:
//
//   - only a request whose host is positively one of this server's API names
//     (BETTER_AUTH_URL's origin and its aliases) is redirected; any other
//     name, the docs origin included, is served as before;
//   - a request carrying x-vercel-id came through Vercel and is never
//     redirected, whatever its host headers say, so the proxy cannot loop
//     even if it ever stops sending X-Forwarded-Host.
//
// A proxy other than Vercel that rewrites Host to the API name without
// setting X-Forwarded-Host would loop; docs/SELF-HOSTING.md says to set it.
// The target is the configured origin plus the request's path and query,
// nothing else from the request. With MARKIE_DOCS_ORIGIN unset nothing
// redirects. The API (/api/*, /mcp) is never touched.
import type { MiddlewareHandler } from "hono";
import { hostOf } from "./canonical-host.ts";
import { deployment } from "./deployment.ts";

// The public page itself: /s/<token>, never its /raw or /assets.
const PUBLIC_PAGE = /^\/s\/[^/]+\/?$/;

export interface DocsHostConfig {
  /** MARKIE_DOCS_ORIGIN, or null. */
  docsOrigin: string | null;
  /** This server's own API origins: BETTER_AUTH_URL's and its aliases. */
  apiOrigins: readonly string[];
}

export function docsHostConfig(d = deployment()): DocsHostConfig {
  return { docsOrigin: d.docsOrigin, apiOrigins: [d.origin, ...d.apiAliases] };
}

/**
 * Whether a browser is loading this as a page, rather than code fetching it.
 * Every current browser sends Sec-Fetch-Mode; Accept: text/html covers the
 * rest. The phone app's and the desktop's fetches send neither.
 */
export function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * Whether this request reached the server on one of its own API names, not
 * through the docs host's proxy: a positive match only.
 */
export function onApiHost(request: Request, { apiOrigins }: Pick<DocsHostConfig, "apiOrigins">): boolean {
  if (request.headers.has("x-vercel-id")) return false;
  const url = new URL(request.url);
  const host = hostOf(request.headers.get("x-forwarded-host")) ?? hostOf(request.headers.get("host")) ?? url.host;
  return apiOrigins.some((origin) => new URL(origin).host === host);
}

/** Where to send this request instead, or null to serve it here. */
export function docsHostRedirect(
  request: Request,
  config: DocsHostConfig,
  isPage: (path: string) => boolean = (path) => PUBLIC_PAGE.test(path)
): string | null {
  const { docsOrigin } = config;
  if (!docsOrigin) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (!isPage(url.pathname) || !isNavigation(request)) return null;
  const target = new URL(docsOrigin);
  if (config.apiOrigins.some((origin) => new URL(origin).host === target.host)) return null;
  if (!onApiHost(request, config)) return null;
  return `${target.origin}${url.pathname}${url.search}`;
}

/**
 * The redirect as middleware, for the /s/* routes. The URL carries a public
 * token, so the answer is kept out of caches and out of any referrer, like
 * the pages themselves.
 */
export function redirectToDocsHost(
  config: () => DocsHostConfig = () => docsHostConfig(),
  isPage?: (path: string) => boolean
): MiddlewareHandler {
  return async (c, next) => {
    const to = docsHostRedirect(c.req.raw, config(), isPage);
    if (!to) return next();
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(to, 302);
  };
}
