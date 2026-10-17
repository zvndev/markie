import { useEffect, useRef, useState } from "react";
import { getAuthToken, getConfirmedAuthIdentity, getServerURL } from "@/lib/auth-client";
import { authStore, useAuth } from "@/lib/auth-store";
import { DocumentCloudClient, type CloudDocumentMetadata } from "@/lib/document-cloud";
import { queryLibraryDocuments, type LibraryDocumentQuery } from "@/lib/library-document-query";

function identity() {
  const { user, status } = authStore.getSnapshot();
  return JSON.stringify([getServerURL(), getAuthToken(), status, user?.id ?? null, getConfirmedAuthIdentity()]);
}
type Listing = { identity: string; rows: CloudDocumentMetadata[]; error: string | null; loading: boolean };

/** The ordinary snapshot service is separate from legacy Markdown sync. GET metadata only. */
export function DocumentCloudLibrary({ query, onOpen }: { query: LibraryDocumentQuery; onOpen: (id: string) => void }) {
  const { user, status } = useAuth();
  const currentIdentity = identity();
  const confirmed = getConfirmedAuthIdentity();
  const authorized = status === "in" && !!user && confirmed?.userId === user.id && confirmed.serverURL === getServerURL();
  const [listing, setListing] = useState<Listing | null>(null);
  const [retry, setRetry] = useState(0);
  const [storageEpoch, setStorageEpoch] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const changed = () => setStorageEpoch((value) => value + 1);
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    const ticket = ++generation.current;
    const controller = new AbortController();
    const boundIdentity = identity(), token = getAuthToken();
    const stale = () => controller.signal.aborted || ticket !== generation.current || boundIdentity !== identity();
    if (!authorized || !token) return () => controller.abort();
    setListing({ identity: boundIdentity, rows: [], error: null, loading: true });
    void (async () => {
      try {
        const client = new DocumentCloudClient({ baseUrl: getServerURL(), token }, async (input, init) => {
          if (stale()) throw new Error("The account changed. Refresh the cloud list.");
          const response = await fetch(input, init);
          if (stale()) throw new Error("The account changed. The cloud list was not applied.");
          return response;
        });
        const rows = await client.list(controller.signal);
        if (!stale()) setListing({ identity: boundIdentity, rows, error: null, loading: false });
      } catch (failure) {
        if (!stale()) setListing({ identity: boundIdentity, rows: [], error: failure instanceof Error && failure.name !== "TypeError" ? failure.message : "Cloud documents could not be reached. Check your connection and retry.", loading: false });
      }
    })();
    return () => controller.abort();
  }, [currentIdentity, authorized, retry, storageEpoch]);

  // Never render an old account's title while effect cleanup is pending.
  const visible = listing?.identity === currentIdentity && authorized ? listing : null;
  const rows = queryLibraryDocuments(visible?.rows ?? [], query, (row) => ({ key: `snapshot:${row.id}`, name: row.name, format: row.format, updatedAt: row.updatedAt }));
  return <section aria-label="Cloud document snapshots" className="border-t border-border py-2">
    <div className="flex items-center justify-between gap-2 px-3"><h3 className="text-xs font-medium text-muted">Document snapshots</h3><button type="button" aria-label="Refresh cloud document snapshots" disabled={!authorized || !!visible?.loading} className="text-xs text-muted hover:text-foreground disabled:opacity-40" onClick={() => setRetry((value) => value + 1)}>Refresh</button></div>
    <p className="px-3 pt-1 text-[11px] text-muted">Search names only; filter by format. Content stays in the cloud until opened.</p>
    {status === "checking" ? <p role="status" className="px-3 py-2 text-xs text-muted">Checking account…</p>
      : status !== "in" || !user ? <p className="px-3 py-2 text-xs text-muted">Sign in to browse document snapshots.</p>
        : !authorized ? <p className="px-3 py-2 text-xs text-muted">Sign in again to confirm your account on this server.</p>
          : visible?.error ? <p role="alert" className="px-3 py-2 text-xs text-muted">{visible.error}</p>
          : !visible || visible.loading ? <p role="status" className="px-3 py-2 text-xs text-muted">Loading cloud document snapshots…</p>
            : <><p role="status" className="px-3 py-1 text-[11px] text-muted">{rows.length} of {visible.rows.length} snapshots</p>
              {rows.length ? <ul>{rows.map((row) => <li key={row.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { if (visible.identity === identity()) onOpen(row.id); }}><span className="block truncate text-sm">{row.name}</span><span className="block text-[11px] text-muted">{row.format.toUpperCase()} · {row.role} · version {row.version}</span></button></li>)}</ul>
                : <p className="px-3 py-2 text-xs text-muted">{visible.rows.length ? "No snapshots match these filters." : "No document snapshots yet. Share a local document to create one."}</p>}</>}
  </section>;
}
