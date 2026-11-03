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
 * The read view, which the same bundle opens on a hosted document's own page
 * (server/src/doc-view.ts, server/src/public.ts):
 *
 *   /d/<id>      a member's document, read with the browser's session
 *   /s/<token>   a public link, read with no session at all
 *
 * Reading is the default for anything shared on the web; the editor is one
 * button away, at /app/d/<id>.
 */
export type ViewRoute = { kind: "member"; id: string } | { kind: "public"; token: string };

const MEMBER_VIEW = /^\/d\/([A-Za-z0-9_-]{1,128})\/?$/;
const PUBLIC_VIEW = /^\/s\/([A-Za-z0-9_-]{8,256})\/?$/;

export function parseViewRoute(pathname: string): ViewRoute | null {
  const member = MEMBER_VIEW.exec(pathname);
  if (member) return { kind: "member", id: member[1] };
  const shared = PUBLIC_VIEW.exec(pathname);
  if (shared) return { kind: "public", token: shared[1] };
  return null;
}

export function viewRoutePath(route: ViewRoute): string {
  return route.kind === "member" ? `/d/${encodeURIComponent(route.id)}` : `/s/${encodeURIComponent(route.token)}`;
}

/**
 * The web sign-in, coming back to a member's read view. `switchAccount` is
 * for a browser already signed in as someone the document was not shared
 * with (server/src/web-signin.ts webSignInHref).
 */
export function viewSignInHref(id: string, apiOrigin: string, { switchAccount = false }: { switchAccount?: boolean } = {}): string {
  return `${apiOrigin.replace(/\/+$/, "")}/auth/web-signin?next=${encodeURIComponent(`/d/${id}`)}${switchAccount ? "&switch=1" : ""}`;
}

/**
 * The web sign-in, on the API origin where the session cookie lives, coming
 * back to this page (server/src/web-signin.ts safeNext). The server sends an
 * /app page on the API origin on to the docs host, so `next` is a path.
 */
export function signInHref(route: WebRoute, apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, "")}/auth/web-signin?next=${encodeURIComponent(webRoutePath(route))}`;
}
