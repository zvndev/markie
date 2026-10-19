import { useEffect, useRef, useState } from "react";
import { getAuthToken, getConfirmedAuthIdentity, getServerURL } from "@/lib/auth-client";
import { authStore, useAuth } from "@/lib/auth-store";
import { DocumentCloudClient, type CloudDocumentMetadata } from "@/lib/document-cloud";
import { queryLibraryDocuments, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { CloudAreaPicker, useCloudAreaScope } from "./cloud-area-picker";
import type { CloudAreas } from "@/lib/account-identities";
import { DocumentFormatMark } from "./document-format-mark";
import { updatedAgo } from "@/lib/relative-time";

function errorPresentation(error: string): { title: string; body: string } {
  if (/does not provide the new document-sharing service/i.test(error)) {
    return { title: "Snapshots unavailable on this server", body: "Update the Markie server to use document snapshots." };
  }
  if (/could not be reached|connection|fetch failed/i.test(error)) {
    return { title: "Snapshots could not be reached", body: "Check your connection and try again." };
  }
  if (/sign in again|session|account changed/i.test(error)) {
    return { title: "Account confirmation needed", body: "Sign in again, then refresh snapshots." };
  }
  return { title: "Snapshots could not load", body: error };
}

function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function identity() {
  const { user, status } = authStore.getSnapshot();
  return JSON.stringify([getServerURL(), getAuthToken(), status, user?.id ?? null, getConfirmedAuthIdentity()]);
}
type Listing = { identity: string; rows: CloudDocumentMetadata[]; error: string | null; loading: boolean };

/** The ordinary snapshot service is separate from legacy Markdown sync. GET metadata only. */
export function DocumentCloudLibrary({ query, onOpen, presentation = "panel" }: { query: LibraryDocumentQuery; onOpen: (id: string) => void; presentation?: "panel" | "workspace" }) {
  const { user, status } = useAuth();
  const currentIdentity = identity();
  const confirmed = getConfirmedAuthIdentity();
  const authorized = status === "in" && !!user && confirmed?.userId === user.id && confirmed.serverURL === getServerURL();
  const [listing, setListing] = useState<Listing | null>(null);
  const [retry, setRetry] = useState(0);
  const [storageEpoch, setStorageEpoch] = useState(0);
  const sharedArea = useCloudAreaScope();
  const [localAreaId, setAreaId] = useState(""), [localAreas, setAreas] = useState<CloudAreas | null>(null);
  const areaId = sharedArea ? sharedArea.areaId : localAreaId, areas = sharedArea ? sharedArea.areas : localAreas;
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
  const areaRows = (visible?.rows ?? []).filter((row) => !areaId || (row.areaId ?? areas?.placements.find((item) => item.kind === "snapshot" && item.documentId === row.id)?.areaId) === areaId);
  const rows = queryLibraryDocuments(areaRows, query, (row) => ({ key: `snapshot:${row.id}`, name: row.name, format: row.format, updatedAt: row.updatedAt }));
  const workspace = presentation === "workspace";
  const error = visible?.error ? errorPresentation(visible.error) : null;
  const renderRefresh = (label = "Refresh") => <button type="button" aria-label={label === "Refresh" ? "Refresh cloud document snapshots" : "Retry loading cloud document snapshots"} disabled={!authorized || !!visible?.loading} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)] disabled:opacity-40" onClick={() => setRetry((value) => value + 1)}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={visible?.loading ? "animate-spin" : ""}><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></svg>{label}</button>;
  const refresh = renderRefresh();
  const stateCard = (title: string, body?: string, role: "status" | "alert" = "status") => <div role={role} className={workspace ? "flex max-w-xl items-start gap-3 rounded-xl border border-border/80 bg-surface-2/70 px-4 py-3 shadow-[inset_0_1px_rgba(255,255,255,0.05)]" : "mx-3 my-2 flex items-start gap-2 rounded-lg border border-border/70 bg-background/45 px-3 py-2.5"}>
    <span aria-hidden="true" className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${role === "alert" ? "border-[color:var(--status-red)]/50 text-[var(--status-red)]" : "border-border text-muted"}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 19a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 19z" /></svg>
    </span>
    <span className="min-w-0"><span className="block text-xs font-medium text-foreground">{title}</span>{body ? <span className="mt-0.5 block text-[11px] leading-snug text-muted">{body}</span> : null}</span>
    {role === "alert" ? <span className="ml-auto shrink-0">{renderRefresh("Try again")}</span> : null}
  </div>;
  return <section aria-label="Cloud document snapshots" className={workspace ? "min-w-0" : "border-t border-border py-2"}>
    {workspace ? <div className="mb-3 flex items-center justify-between gap-3">
      <p role="status" className="text-[11px] tabular-nums text-muted">{visible && !visible.loading && !error ? `${rows.length} of ${visible.rows.length} snapshots` : authorized ? "Snapshots" : "Account required"}</p>{refresh}
    </div> : <div className="flex items-center justify-between gap-2 px-3"><h3 className="text-xs font-medium text-muted">Document snapshots</h3>{refresh}</div>}
    {authorized && !sharedArea ? <div className={workspace ? "mb-3 max-w-[300px]" : "px-3 py-1"}><CloudAreaPicker label="Snapshot cloud area" value={areaId} onChange={setAreaId} onLoaded={setAreas} fullWidth /></div> : null}
    {status === "checking" ? stateCard("Checking account…")
      : status !== "in" || !user ? stateCard("Sign in to view snapshots")
        : !authorized ? stateCard("Confirm your account", "Sign in again on this server.")
          : error ? stateCard(error.title, error.body, "alert")
          : !visible || visible.loading ? stateCard("Loading snapshots…")
            : <>{!workspace ? <p role="status" className="px-3 py-1 text-[11px] text-muted">{rows.length} of {visible.rows.length} snapshots</p> : null}
              {rows.length ? <ul className={workspace ? "grid gap-2 xl:grid-cols-2" : undefined}>{rows.map((row) => {
                const updated = updatedAgo(typeof row.updatedAt === "number" ? row.updatedAt : Date.parse(String(row.updatedAt)));
                const metadata = [row.format.toUpperCase(), `${row.role[0].toUpperCase()}${row.role.slice(1)}`, `v${row.version}`, fileSize(row.byteLength), updated].filter(Boolean).join(" · ");
                return <li key={row.id}><button type="button" aria-label={row.name} className={workspace ? "group flex w-full items-center gap-3 rounded-xl border border-border/75 bg-surface-2/65 px-3 py-2.5 text-left shadow-[inset_0_1px_rgba(255,255,255,0.045),0_2px_8px_rgba(0,0,0,0.08)] transition hover:border-foreground/20 hover:bg-accent/45 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]" : "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]"} onClick={() => { if (visible.identity === identity()) onOpen(row.id); }}>
                  <DocumentFormatMark format={row.format} size={workspace ? "md" : "sm"} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm text-foreground">{row.name}</span><span className="mt-0.5 block truncate text-[11px] text-muted">{metadata}</span></span>
                  <span aria-hidden="true" className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100">Open</span>
                </button></li>;
              })}</ul>
                : stateCard(visible.rows.length ? "No snapshots match these filters" : "No document snapshots yet", visible.rows.length ? undefined : "Share a local document to create one.")}</>}
  </section>;
}
