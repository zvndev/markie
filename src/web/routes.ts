// The web app's three pages, the contract other parts of the server link to
// (server/src/web-app.ts):
//
//   /app          the cloud library
//   /app/d/<id>   one document in the editor
//   /app/new      the library with the new-document chooser open
export type WebRoute = { page: "library"; create: boolean } | { page: "doc"; id: string };

const DOC = /^\/app\/d\/([A-Za-z0-9_-]{1,128})\/?$/;

export function parseWebRoute(pathname: string): WebRoute {
  const doc = DOC.exec(pathname);
  if (doc) return { page: "doc", id: doc[1] };
  return { page: "library", create: /^\/app\/new\/?$/.test(pathname) };
}

export function webRoutePath(route: WebRoute): string {
  if (route.page === "doc") return `/app/d/${encodeURIComponent(route.id)}`;
  return route.create ? "/app/new" : "/app";
}

/**
 * The web sign-in, on the API origin where the session cookie lives, coming
 * back to this page (server/src/web-signin.ts safeNext). The server sends an
 * /app page on the API origin on to the docs host, so `next` is a path.
 */
export function signInHref(route: WebRoute, apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, "")}/auth/web-signin?next=${encodeURIComponent(webRoutePath(route))}`;
}
