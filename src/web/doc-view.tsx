// The read view: how a document shared on the web opens, at /d/<id> for its
// members and /s/<token> for anyone with its public link. The hosted page's
// look (brand left, the title, the actions right, one centred column) with
// what a reader reaches for: the section rail, pictures that enlarge, Copy
// all, Export, and Edit for an account that may edit. The editor is one
// click away, in place; this is always where a link lands.
//
// The server serves this as the web app's shell and holds nothing about the
// document in it (server/src/doc-view.ts, public.ts). What the page reads, it
// reads from the API origin itself: a member's document with the browser's
// own session, exactly what that account may read, and a public link's text
// from /s/<token>/raw with no session at all, as the phone does. A browser
// that is not signed in sees the sign-in, never the document.
import "./doc-view.css";
import "@/components/documents/document-workspace.css";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAuthToken } from "@/lib/auth-client";
import { compileDarkmownPreview } from "@/lib/darkmown/preview";
import { darkmownFrameSandbox, projectDarkmownTheme } from "@/lib/darkmown/frame";
import { exportRichDocument, type RichDocument } from "@/lib/office/rich-document";
import { THEME_APPLIED_EVENT } from "@/lib/theme";
import { MarkieLogo } from "@/components/markie-logo";
import { CopyAllButton } from "@/components/copy-all-button";
import { ImageLightbox } from "@/components/image-lightbox";
import { HtmlSectionRail } from "@/components/section-rail";
import { HideBarButton, ShowBarButton } from "./bar-controls";
import { useBarVisibility } from "./bar-visibility";
import { SessionEndedError, type EditorKind } from "./cloud";
import { viewSignInHref, type ViewRoute } from "./routes";
import type { WebSessionUser } from "./session";
import { memberAssetUrl, publicAssetUrl, viewHtml, type AssetUrl } from "./view-content";
import { loadDoc } from "./web-document";
import { WebExportMenu, type WebExportSource } from "./web-export";

const WordDocumentEditor = lazy(() => import("@/components/documents/word-document-editor").then((m) => ({ default: m.WordDocumentEditor })));

/** One document, as the read view draws it. */
export interface ViewDoc {
  name: string;
  kind: EditorKind;
  text: string;
  office: RichDocument | null;
  /** The id the editor opens, when this account may edit. */
  editId: string | null;
  assetUrl: AssetUrl | null;
}

type ViewState =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "no-access" }
  | { state: "gone" }
  | { state: "error"; message: string }
  | { state: "ready"; doc: ViewDoc };

/** The name and format the server put on a public link's page (server/src/web-app.ts withDocMeta). */
export function publicDocMeta(doc: Pick<Document, "querySelector">): { name: string; format: string } {
  const read = (key: string) => doc.querySelector(`meta[name="${key}"]`)?.getAttribute("content") ?? "";
  return { name: read("markie-doc-name") || "Shared document", format: read("markie-doc-format") || "markdown" };
}

export function publicKind(format: string): EditorKind {
  return format === "darkmown" ? "darkmown" : format === "text" ? "text" : "markdown";
}

async function loadMember(id: string, apiOrigin: string, user: WebSessionUser | null): Promise<ViewState> {
  if (!user) return { state: "signed-out" };
  try {
    const doc = await loadDoc(id);
    if (!doc) return { state: "no-access" };
    const editable = doc.role !== "viewer" && doc.kind !== "unsupported";
    return {
      state: "ready",
      doc: {
        name: doc.name, kind: doc.kind, text: doc.text, office: doc.office,
        editId: editable ? doc.id : null,
        // Only the text store has per-document assets (server/src/assets.ts).
        assetUrl: doc.store === "docs" ? memberAssetUrl(apiOrigin, id) : null,
      },
    };
  } catch (error) {
    if (error instanceof SessionEndedError) return { state: "signed-out" };
    return { state: "error", message: error instanceof Error ? error.message : "Couldn't open this document." };
  }
}

async function loadPublic(token: string, apiOrigin: string, user: WebSessionUser | null, fetcher: typeof fetch = fetch): Promise<ViewState> {
  const { name, format } = publicDocMeta(document);
  let response: Response;
  try {
    // No credentials: the link alone is what reads a public document.
    response = await fetcher(`${apiOrigin}/s/${encodeURIComponent(token)}/raw`, { cache: "no-store", credentials: "omit" });
  } catch {
    return { state: "error", message: "Can't reach Markie. Check your connection and reload." };
  }
  if (response.status === 404) return { state: "gone" };
  if (!response.ok) return { state: "error", message: "Markie couldn't load this document. Reload to try again." };
  const text = await response.text();
  // Edit is offered to an account that may edit the document behind the
  // link, and the server names its id to that account only.
  let editId: string | null = null;
  const bearer = user ? getAuthToken() : null;
  if (bearer) {
    try {
      const res = await fetcher(`${apiOrigin}/api/public-links/${encodeURIComponent(token)}/editor`, { cache: "no-store", headers: { Authorization: `Bearer ${bearer}` } });
      const data = res.ok ? ((await res.json()) as { docId?: unknown }) : null;
      if (typeof data?.docId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.docId)) editId = data.docId;
    } catch {
      // Reading never depends on it.
    }
  }
  return { state: "ready", doc: { name, kind: publicKind(format), text, office: null, editId, assetUrl: publicAssetUrl(apiOrigin, token) } };
}

function exportSource(kind: EditorKind): WebExportSource {
  return kind === "darkmown" ? "darkmown" : kind === "office" ? "office" : kind === "text" ? "text" : "markdown";
}

/** The page's tone, as the app's colour mode painted it. */
function usePageTone(): "light" | "dark" {
  const read = () => (document.documentElement.dataset.themeTone === "dark" ? "dark" : "light");
  const [tone, setTone] = useState<"light" | "dark">(read);
  useEffect(() => {
    const update = () => setTone(read());
    window.addEventListener(THEME_APPLIED_EVENT, update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-tone"] });
    return () => { window.removeEventListener(THEME_APPLIED_EVENT, update); observer.disconnect(); };
  }, []);
  return tone;
}

export interface DocViewProps {
  route: ViewRoute;
  apiOrigin: string;
  user: WebSessionUser | null;
  /** Opens the editor on this id, in place. */
  onEdit: (id: string) => void;
}

export function DocView({ route, apiOrigin, user, onEdit }: DocViewProps) {
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const bar = useBarVisibility("view");
  const routeKey = route.kind === "member" ? `d:${route.id}` : `s:${route.token}`;

  useEffect(() => {
    let live = true;
    setView({ state: "loading" });
    const load = route.kind === "member" ? loadMember(route.id, apiOrigin, user) : loadPublic(route.token, apiOrigin, user);
    void load.then((next) => { if (live) setView(next); });
    return () => { live = false; };
    // routeKey stands for the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, apiOrigin, user, reload]);

  const doc = view.state === "ready" ? view.doc : null;
  useEffect(() => {
    document.title = doc ? `${doc.name} · Markie` : view.state === "loading" ? "Markie" : "Sign in to read this · Markie";
  }, [doc, view.state]);

  const signIn = route.kind === "member" ? viewSignInHref(route.id, apiOrigin) : null;
  const html = useMemo(() => (doc && (doc.kind === "markdown" || doc.kind === "text") ? viewHtml(doc.kind, doc.text, doc.assetUrl) : null), [doc]);
  const readText = useCallback(() => doc?.text ?? "", [doc]);
  const original = useMemo(() => (doc?.office ? async () => new Uint8Array(await exportRichDocument(doc.office!)) : undefined), [doc]);

  return <div className="markie-view flex h-screen flex-col" data-web-view={route.kind} data-bar-hidden={bar.hidden ? "true" : "false"} data-view-state={view.state}>
    {bar.hidden ? <ShowBarButton onShow={bar.show} /> : <header className="markie-view-bar" data-web-view-bar>
      <a className="markie-view-brand" href={user ? "/app" : "/"} aria-label={user ? "Your Markie documents" : "Markie"}><MarkieLogo width={104} title={null} /></a>
      <span className="markie-view-title" data-web-view-title>{doc?.name ?? ""}</span>
      <nav className="markie-view-nav" aria-label="Document">
        {user ? <a className="markie-view-icon" href="/app">Library</a> : null}
        {doc ? <CopyAllButton text={doc.text} read={readText} /> : null}
        {doc && doc.kind !== "unsupported" ? <WebExportMenu name={doc.name} source={exportSource(doc.kind)} read={readText}
          html={html ? () => html : undefined} original={original} buttonClassName="markie-view-icon" /> : null}
        {doc?.editId ? <button type="button" data-web-edit className="markie-view-btn primary" onClick={() => onEdit(doc.editId!)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          Edit
        </button> : null}
        {!user && signIn ? <a data-web-sign-in-to-edit className="markie-view-btn primary" href={signIn}>Sign in to edit</a> : null}
        {!user && route.kind === "public" ? <a className="markie-view-btn ghost" href="/download">Get Markie</a> : null}
        {user ? <span className="markie-view-who" title={`Signed in as ${user.email}`}><span className="sr-only">Signed in as </span>{user.email}</span> : null}
        <span className="markie-view-sep" aria-hidden="true" />
        <HideBarButton onHide={bar.hide} className="markie-view-icon" />
      </nav>
    </header>}

    <ViewBody view={view} html={html} signIn={signIn} user={user} apiOrigin={apiOrigin} route={route} onRetry={() => setReload((n) => n + 1)} />
  </div>;
}

function ViewBody({ view, html, signIn, user, apiOrigin, route, onRetry }: {
  view: ViewState; html: string | null; signIn: string | null; user: WebSessionUser | null; apiOrigin: string; route: ViewRoute; onRetry: () => void;
}) {
  if (view.state === "loading") return <p role="status" className="markie-view-notice">Opening document…</p>;
  if (view.state === "signed-out") {
    // The same notice for every id, existing or not: it names nothing.
    return <main className="markie-view-notice" data-web-view-notice="signed-out">
      <h1>Sign in to read this document</h1>
      <p>Markie documents are never public. Sign in with the account it was shared with, or open the link from your invite email.</p>
      <div className="markie-view-actions">
        {signIn ? <a className="markie-view-btn primary" href={signIn}>Sign in</a> : null}
        <a className="markie-view-btn ghost" href="/download">Get Markie</a>
      </div>
    </main>;
  }
  if (view.state === "no-access") {
    // Names who is signed in, which this browser already knows, and nothing
    // about the document: the same answer for an id that does not exist.
    const other = route.kind === "member" ? viewSignInHref(route.id, apiOrigin, { switchAccount: true }) : null;
    return <main className="markie-view-notice" data-web-view-notice="no-access">
      <h1>This account can&apos;t open this document</h1>
      <p>You&apos;re signed in as <strong>{user?.email}</strong>. If it was shared with a different address, sign in with that one.</p>
      <div className="markie-view-actions">
        {other ? <a className="markie-view-btn primary" href={other}>Sign in with a different account</a> : null}
        <a className="markie-view-btn ghost" href="/app">Your documents</a>
      </div>
    </main>;
  }
  if (view.state === "gone") {
    return <main className="markie-view-notice" data-web-view-notice="gone">
      <h1>This link is no longer available</h1>
      <p>The document was unshared, or the link changed.</p>
    </main>;
  }
  if (view.state === "error") {
    return <main className="markie-view-notice" role="alert">
      <h1>Couldn&apos;t open this document</h1>
      <p>{view.message}</p>
      <div className="markie-view-actions"><button type="button" className="markie-view-btn ghost" onClick={onRetry}>Try again</button></div>
    </main>;
  }
  const { doc } = view;
  if (doc.kind === "darkmown") return <DarkmownView source={doc.text} name={doc.name} />;
  if (doc.kind === "office" && doc.office) {
    return <div className="markie-view-office docs-workspace docs-workspace-embedded w-full min-h-0 flex-1"><div className="docs-main"><div className="docs-editor-area">
      <Suspense fallback={<p role="status" className="markie-view-notice">Opening document…</p>}>
        <WordDocumentEditor document={doc.office} readOnly onChange={() => {}} />
      </Suspense>
    </div></div></div>;
  }
  if (doc.kind === "unsupported" || html === null) {
    return <main className="markie-view-notice"><h1>{doc.name}</h1><p>Markie can&apos;t show this kind of file in the browser. Export it to download the original.</p></main>;
  }
  return <ReadingColumn html={html} />;
}

/** The rendered document, with the section rail beside it and pictures that enlarge. */
function ReadingColumn({ html }: { html: string }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [article, setArticle] = useState<HTMLElement | null>(null);

  // Pictures open in the viewer on a click. A picture inside a link stays the
  // link's (collectImages), so only the others become buttons the keyboard
  // can reach: Enter or Space opens the viewer the same way.
  useEffect(() => {
    if (!article) return;
    for (const img of Array.from(article.querySelectorAll<HTMLImageElement>("img"))) {
      if (img.closest("a, [data-markie-embed]")) continue;
      img.dataset.markieZoomable = "";
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      const alt = img.getAttribute("alt")?.trim();
      img.setAttribute("aria-label", alt ? `Enlarge picture: ${alt}` : "Enlarge picture");
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !("markieZoomable" in target.dataset)) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      target.click();
    };
    article.addEventListener("keydown", onKey);
    return () => article.removeEventListener("keydown", onKey);
  }, [article, html]);

  // Math needs KaTeX's stylesheet, which is large: fetched only for a
  // document that has math in it.
  useEffect(() => {
    if (!html.includes('class="katex')) return;
    let style: HTMLStyleElement | null = null;
    let live = true;
    void import("@/lib/katex-css.generated").then(({ KATEX_CSS }) => {
      if (!live || document.querySelector("style[data-markie-katex]")) return;
      style = Object.assign(document.createElement("style"), { textContent: KATEX_CSS });
      style.dataset.markieKatex = "";
      document.head.appendChild(style);
    });
    return () => { live = false; style?.remove(); };
  }, [html]);

  return <div className="markie-view-body">
    <HtmlSectionRail root={article} scroller={scroller} content={html} />
    <div ref={setScroller} className="markie-view-scroll" data-web-view-scroll>
      <main className="markie-view-main">
        <article ref={setArticle} className="markdown-body" data-web-view-content dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
    <ImageLightbox container={scroller} openOn="click" />
  </div>;
}

/**
 * A Darkmown document on the web, in the same sandboxed frame the web app's
 * editor uses (src/lib/darkmown/frame.ts): an opaque origin, no network, no
 * storage, no host bridge, and only the pinned interpreter may run. It opens
 * as a still preview; its controls run after the reader turns them on, for
 * exactly this text, as DESIGN.md asks of every Darkmown host.
 */
function DarkmownView({ source, name }: { source: string; name: string }) {
  const tone = usePageTone();
  const [running, setRunning] = useState(false);
  const [reset, setReset] = useState(0);
  const [result, setResult] = useState<{ key: string; srcDoc?: string; error?: string } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // A running frame follows the tone by message; a still one is rebuilt in it.
  const key = `${running}:${reset}:${running ? "runtime" : tone}`;

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void compileDarkmownPreview(source, running, { signal: controller.signal, colorScheme: tone }).then(
      (preview) => { if (live) setResult({ key, srcDoc: preview.srcDoc }); },
      (error: unknown) => { if (live) setResult({ key, error: error instanceof Error ? error.message : "Darkmown could not build this document." }); },
    );
    return () => { live = false; controller.abort(); };
    // The key covers running, reset and the still frame's tone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key]);

  useEffect(() => { if (running) projectDarkmownTheme(frame.current, tone); }, [running, tone, result]);
  const current = result?.key === key ? result : null;

  return <div className="markie-view-darkmown" data-web-view-darkmown={running ? "running" : "still"}>
    <div className="markie-view-darkmown-head">
      <strong>Interactive document</strong>
      <span>{running ? "Controls on. Local state only: no network, files or storage." : "Its controls are off until you turn them on."}</span>
      <span className="flex-1" />
      {running
        ? <><button type="button" className="markie-view-btn ghost" onClick={() => setReset((n) => n + 1)}>Reset</button>
          <button type="button" className="markie-view-btn ghost" onClick={() => setRunning(false)}>Turn off</button></>
        : <button type="button" data-web-darkmown-run className="markie-view-btn primary" onClick={() => setRunning(true)}>Turn on controls</button>}
    </div>
    {current?.error ? <p role="alert">{current.error}</p>
      : current?.srcDoc ? <iframe ref={frame} key={key} title={name} sandbox={darkmownFrameSandbox(running)} referrerPolicy="no-referrer"
        style={{ colorScheme: tone }} srcDoc={current.srcDoc} onLoad={() => { if (running) projectDarkmownTheme(frame.current, tone); }} />
      : <p role="status">Building the document…</p>}
  </div>;
}
