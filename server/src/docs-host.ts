// Hosted documents are linked on their own origin when MARKIE_DOCS_ORIGIN
// names one (deployment.ts). On Markie Cloud that is https://markiedocs.com,
// whose Vercel rewrites proxy /d and /s to this server. Links handed out
// before, private links on https://api.markiedocs.com/d/<id> above all, keep
// arriving here directly and must keep working, so a browser GET for a
// document page, its raw download or its assets that arrives on one of this
// server's own API names is sent to the same path and query on the docs
// origin.
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
// The target is the configured origin plus the request's path and query,
// nothing else from the request. The query is kept because a member's link
// carries its ?k= there, and the page it lands on decides access from the
// session alone, as it always has. With MARKIE_DOCS_ORIGIN unset nothing
// redirects. The API (/api/*, /mcp) is never touched.
import type { MiddlewareHandler } from "hono";
import { hostOf } from "./canonical-host.ts";
import { deployment } from "./deployment.ts";

// /d/<id>, /d/<id>/raw, /d/<id>/assets, and the same three under /s/<token>.
const HOSTED_DOC = /^\/[ds]\/[^/]+(?:\/(?:raw|assets))?\/?$/;

export interface DocsHostConfig {
  /** MARKIE_DOCS_ORIGIN, or null. */
  docsOrigin: string | null;
  /** This server's own API origins: BETTER_AUTH_URL's and its aliases. */
  apiOrigins: readonly string[];
}

export function docsHostConfig(d = deployment()): DocsHostConfig {
  return { docsOrigin: d.docsOrigin, apiOrigins: [d.origin, ...d.apiAliases] };
}

/** Where to send this request instead, or null to serve it here. */
export function docsHostRedirect(request: Request, { docsOrigin, apiOrigins }: DocsHostConfig): string | null {
  if (!docsOrigin) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (request.headers.has("x-vercel-id")) return null;
  const url = new URL(request.url);
  if (!HOSTED_DOC.test(url.pathname)) return null;
  const target = new URL(docsOrigin);
  const host = hostOf(request.headers.get("x-forwarded-host")) ?? hostOf(request.headers.get("host")) ?? url.host;
  if (host === target.host) return null;
  if (!apiOrigins.some((origin) => new URL(origin).host === host)) return null;
  return `${target.origin}${url.pathname}${url.search}`;
}

/**
 * The redirect as middleware, for the /d/* and /s/* routes. The URL can carry
 * a personal or public token, so the answer is kept out of caches and out of
 * any referrer, like the pages themselves.
 */
export function redirectToDocsHost(config: () => DocsHostConfig = () => docsHostConfig()): MiddlewareHandler {
  return async (c, next) => {
    const to = docsHostRedirect(c.req.raw, config());
    if (!to) return next();
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(to, 302);
  };
}
