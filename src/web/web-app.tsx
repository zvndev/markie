// The Markie web app's shell: the app bar, the cloud library, one document,
// and the desktop's new-document chooser. Desktop-only surfaces (the disk
// library and browser, terminal, local index, MCP and skills installs, the
// updater, Live Docs) have no meaning without the desktop and are not here
// at all, rather than present and broken.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServerURL } from "@/lib/auth-client";
import { authStore } from "@/lib/auth-store";
import { applyColorMode, getColorMode, type ColorMode } from "@/lib/color-mode";
import { createDocumentSession, serializeDocumentSession, type EditableDocumentFormat } from "@/lib/document-session";
import { DEFAULT_LIBRARY_DOCUMENT_QUERY, queryLibraryDocuments, type LibraryDocumentQuery } from "@/lib/library-document-query";
import { shortAgo } from "@/lib/relative-time";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { MarkieLogo } from "@/components/markie-logo";
import { NewDocumentModal } from "@/components/new-document-modal";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { LibraryDocumentFilters } from "@/components/library-document-filters";
import { listCloudDocuments, savePlatformDoc, saveTextDoc, SessionEndedError, type CloudDocSummary } from "./cloud";
import { parseWebRoute, signInHref, webRoutePath, type WebRoute } from "./routes";
import { WebDocument } from "./web-document";
import { ShowBarButton } from "./bar-controls";
import { useBarVisibility } from "./bar-visibility";
import type { WebSessionUser } from "./session";

/** Starts a blank document of `format` in the cloud and returns its id. */
export async function createCloudDocument(format: EditableDocumentFormat): Promise<string> {
  const session = await createDocumentSession(format);
  if (session.office) {
    const bytes = await serializeDocumentSession(session);
    return (await savePlatformDoc({ id: null, name: session.name, bytes, baseVersion: 0 })).id;
  }
  const id = crypto.randomUUID();
  await saveTextDoc({ id, name: session.name, content: session.text, baseVersion: 0 });
  return id;
}

const MODES: ReadonlyArray<readonly [ColorMode, string]> = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

function AccountMenu({ user, onSignOut }: { user: WebSessionUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ColorMode>(getColorMode);
  const root = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, root, () => setOpen(false));
  const label = user.name || user.email;
  return <div ref={root} className="relative">
    <button type="button" aria-label="Account and appearance" aria-expanded={open} onClick={() => setOpen(!open)}
      className="markie-toolbar-action flex h-7 items-center gap-2 rounded-md px-2 text-[12px] text-muted hover:text-foreground">
      <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-foreground">{label.slice(0, 1).toUpperCase()}</span>
      <span className="hidden max-w-[14rem] truncate sm:inline">{user.email}</span>
    </button>
    {open ? <div className="markie-menu-panel absolute right-0 top-full z-50 mt-1.5 w-60 rounded-lg p-2" role="menu">
      <p className="truncate px-1 pb-2 text-[11.5px] text-muted">Signed in as <span className="text-foreground">{user.email}</span></p>
      <div role="radiogroup" aria-label="Appearance" className="mb-2 grid grid-cols-3 gap-1 rounded-md border border-border p-0.5">
        {MODES.map(([value, title]) => <button key={value} type="button" role="radio" aria-checked={mode === value} data-color-mode={value}
          onClick={() => { applyColorMode(value); setMode(value); }}
          className={`rounded px-2 py-1 text-[11.5px] ${mode === value ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`}>{title}</button>)}
      </div>
      <button type="button" role="menuitem" onClick={onSignOut} className="markie-menu-item w-full rounded px-2 py-1.5 text-left text-[12px] text-muted">Sign out</button>
    </div> : null}
  </div>;
}

function roleLine(doc: CloudDocSummary): string {
  const when = doc.updatedAt ? `Edited ${shortAgo(doc.updatedAt)}${shortAgo(doc.updatedAt) === "now" ? "" : " ago"}` : "";
  const how = doc.role === "owner"
    ? doc.sharedOut ? "Shared by you" : "Only you"
    : `${doc.sharedBy ? `Shared by ${doc.sharedBy}` : "Shared with you"} · ${doc.role === "editor" ? "can edit" : "can view"}`;
  return [how, when].filter(Boolean).join(" · ");
}

function Library({ onOpen, onNew, onSessionEnded }: { onOpen: (id: string) => void; onNew: () => void; onSessionEnded: () => void }) {
  const [docs, setDocs] = useState<CloudDocSummary[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [query, setQuery] = useState<LibraryDocumentQuery>({ ...DEFAULT_LIBRARY_DOCUMENT_QUERY, sort: "recent" });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    listCloudDocuments().then((result) => {
      if (!live) return;
      setDocs(result.docs);
      setErrors(result.errors);
    }, (error: unknown) => {
      if (!live) return;
      if (error instanceof SessionEndedError) onSessionEnded();
      else setErrors([error instanceof Error ? error.message : "Couldn't list your documents."]);
    });
    return () => { live = false; };
  }, [refresh, onSessionEnded]);
  const rows = useMemo(() => docs ? queryLibraryDocuments(docs, query, (doc) => ({ key: doc.key, name: doc.name, format: doc.format, updatedAt: doc.updatedAt })) : [], [docs, query]);

  return <main className="min-h-0 flex-1 overflow-auto" aria-label="Your documents">
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-foreground">Documents</h1>
          <p role="status" className="text-[12px] text-muted">{docs === null ? "Loading your cloud documents…" : `${rows.length} of ${docs.length} documents in Markie Cloud`}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setRefresh((n) => n + 1)} className="markie-toolbar-action h-8 rounded-md px-2 text-[12px] text-muted hover:text-foreground">Refresh</button>
          <button type="button" onClick={onNew} className="h-8 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background hover:opacity-90">＋ New document</button>
        </div>
      </div>
      <div className="mb-4"><LibraryDocumentFilters query={query} onChange={setQuery} layout="workspace" /></div>
      {errors.map((error) => <p key={error} role="alert" className="mb-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-foreground">{error} <button type="button" className="underline" onClick={() => setRefresh((n) => n + 1)}>Try again</button></p>)}
      {docs !== null && docs.length === 0 && errors.length === 0 ? <div className="rounded-xl border border-border bg-surface px-5 py-8 text-center">
        <p className="text-[14px] font-medium text-foreground">Nothing in Markie Cloud yet</p>
        <p className="mt-1 text-[12.5px] text-muted">Start a document here, or sync one from Markie on your desktop.</p>
      </div> : null}
      {docs !== null && docs.length > 0 && rows.length === 0 ? <p className="text-[12.5px] text-muted">No documents match these filters.</p> : null}
      <ul className="grid gap-2 lg:grid-cols-2" aria-label="Cloud documents">
        {rows.map((doc) => <li key={doc.key}>
          <a href={webRoutePath({ page: "doc", id: doc.id })} data-doc-id={doc.id} data-doc-format={doc.format}
            onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onOpen(doc.id); }}
            className="group flex w-full items-center gap-3 rounded-xl border border-border/75 bg-surface-2/65 px-3 py-2.5 text-left shadow-[inset_0_1px_rgba(255,255,255,0.045),0_2px_8px_rgba(0,0,0,0.08)] transition hover:border-foreground/20 hover:bg-accent/45 focus-visible:outline-2 focus-visible:outline-[color:var(--status-blue)]">
            <DocumentFormatMark format={doc.format} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-foreground">{doc.name}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted">{roleLine(doc)}</span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">Open</span>
          </a>
        </li>)}
      </ul>
    </div>
  </main>;
}

export function WebApp({ user, onView }: { user: WebSessionUser; onView?: (id: string) => void }) {
  const [route, setRoute] = useState<WebRoute>(() => parseWebRoute(window.location.pathname));
  // The editor's bar can be put away like the read view's (bar-visibility.ts).
  // The library keeps its header: there is nothing there to read full-bleed.
  const bar = useBarVisibility("editor", route.page === "doc");
  const barHidden = bar.hidden && route.page === "doc";
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(parseWebRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: WebRoute, replace = false) => {
    const path = webRoutePath(next);
    if (path !== window.location.pathname) window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setRoute(next);
  }, []);

  const sessionEnded = useCallback(() => { window.location.assign(signInHref(parseWebRoute(window.location.pathname), getServerURL())); }, []);
  const signOut = useCallback(() => {
    void authStore.signOut().finally(() => window.location.assign(signInHref({ page: "library", create: false }, getServerURL())));
  }, []);
  const setTitle = useCallback((name: string | null) => { document.title = name ? `${name} · Markie` : "Markie"; }, []);
  useEffect(() => { if (route.page === "library") setTitle(null); }, [route, setTitle]);

  const create = async (format: EditableDocumentFormat) => {
    setCreating(true);
    setCreateError(null);
    try {
      const id = await createCloudDocument(format);
      go({ page: "doc", id });
    } catch (error) {
      if (error instanceof SessionEndedError) sessionEnded();
      else setCreateError(error instanceof Error ? error.message : "Couldn't start a document.");
    } finally {
      setCreating(false);
    }
  };

  return <div className="markie-shell flex h-screen flex-col bg-background text-foreground" data-web-app data-bar-hidden={barHidden ? "true" : "false"}>
    {barHidden ? <ShowBarButton onShow={bar.show} /> : <header className="markie-toolbar flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
      <a href="/app" aria-label="Markie documents" onClick={(event) => { event.preventDefault(); go({ page: "library", create: false }); }} className="flex items-center text-foreground/90">
        <MarkieLogo width={64} className="mt-1" />
      </a>
      <div className="ml-auto flex items-center gap-2">
        {route.page === "doc" ? <button type="button" onClick={() => go({ page: "library", create: true })} className="markie-toolbar-action h-7 rounded-md px-2 text-[12px] text-muted hover:text-foreground">＋ New</button> : null}
        <AccountMenu user={user} onSignOut={signOut} />
      </div>
    </header>}
    {createError ? <p role="alert" className="border-b border-border bg-surface px-4 py-2 text-[12px]">{createError}</p> : null}
    {route.page === "doc"
      ? <WebDocument key={route.id} id={route.id} user={user} onLibrary={() => go({ page: "library", create: false })} onOpen={(id) => go({ page: "doc", id })} onSessionEnded={sessionEnded} onTitle={setTitle}
        onView={onView ? () => onView(route.id) : undefined} barHidden={barHidden} onHideBar={bar.hide} />
      : <Library onOpen={(id) => go({ page: "doc", id })} onNew={() => go({ page: "library", create: true })} onSessionEnded={sessionEnded} />}
    {route.page === "library" && route.create ? <NewDocumentModal onClose={() => go({ page: "library", create: false }, true)} onCreate={(format) => { if (!creating) void create(format); }} /> : null}
  </div>;
}
