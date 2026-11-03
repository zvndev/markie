// Which page of the web bundle is open: the read view of a shared document
// (/d/<id>, /s/<token>) or the app (/app, the library and the editor). Edit in
// the view and View in the editor move between the two in place, with the
// browser's history, so Back goes where it should and nothing reloads.
import { useCallback, useEffect, useState } from "react";
import { DocView } from "./doc-view";
import { parseViewRoute, parseWebRoute, signInHref, viewRoutePath, webRoutePath, type ViewRoute } from "./routes";
import type { WebSessionUser } from "./session";
import { WebApp } from "./web-app";

/**
 * Where the editor's View goes for document `id`: back to the read view it
 * was opened from (a public link's, say), or the document's own.
 */
export function viewPathFor(id: string, cameFrom: ViewRoute | null, cameFromId: string | null): string {
  if (cameFrom && cameFromId === id) return viewRoutePath(cameFrom);
  return viewRoutePath({ kind: "member", id });
}

export function WebRoot({ user, apiOrigin }: { user: WebSessionUser | null; apiOrigin: string }) {
  const [path, setPath] = useState(() => window.location.pathname);
  // The read view Edit was pressed on, so View in the editor returns to it.
  const [origin, setOrigin] = useState<{ view: ViewRoute; id: string } | null>(null);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    if (next !== window.location.pathname) window.history.pushState(null, "", next);
    setPath(next);
    window.scrollTo(0, 0);
  }, []);

  const view = parseViewRoute(path);
  const onEdit = useCallback((id: string) => {
    if (view) setOrigin({ view, id });
    navigate(webRoutePath({ page: "doc", id }));
  }, [navigate, view]);
  const onView = useCallback((id: string) => {
    navigate(viewPathFor(id, origin?.view ?? null, origin?.id ?? null));
  }, [navigate, origin]);

  if (view) return <DocView key={path} route={view} apiOrigin={apiOrigin} user={user} onEdit={onEdit} />;
  if (!user) {
    // The app needs an account. Reached only from a link, since the view
    // offers Edit to a signed-in account alone.
    window.location.replace(signInHref(parseWebRoute(path), apiOrigin));
    return null;
  }
  return <WebApp key="app" user={user} onView={onView} />;
}
