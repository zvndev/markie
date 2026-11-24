// A public share, read with no account. The client it is given holds no
// session, so nothing here can ask the server for anything a browser
// couldn't. Editing, comments and sharing with people need an account, so
// none of them is offered: the way to them is "Sign in".
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import type { ApiClient } from "../lib/api";
import { classifyDocumentLink, type LinkTarget, type PinnedPublicTarget } from "../lib/deep-links";
import { markFormat, type CloudDoc } from "../lib/docs";
import { openExternal, openSystemUrl } from "../lib/native";
import { docExportSource } from "../lib/export";
import { publicLinkErrorCopy } from "../lib/public-link";
import { displayName } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { docLookTokens, docStyleCss, docThemeStyle } from "../lib/doc-theme";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { CsvTable } from "@/components/csv-table/csv-table";
import { isCsvName } from "@/lib/csv-table";
import { DarkmownView } from "../components/darkmown-view";
import { AlertIcon, ShareIcon } from "../components/icons";
import { ExportSheet } from "../components/share-sheet";

// A web address in a CSV cell opens outside the app, as a link in a document does.
const openCsvLink = (url: string) => { void openExternal(url).catch(() => undefined); };

interface PublicDocProps {
  /** A client with no token, on the server the link names. */
  api: ApiClient;
  target: PinnedPublicTarget;
  tone: Tone;
  onSignIn: () => void;
  /** A Markie link inside the document: another public share opens here, a private one asks for sign-in. */
  onOpen: (target: LinkTarget) => void;
}

type State =
  | { status: "loading" }
  | { status: "ready"; doc: CloudDoc }
  | { status: "error"; error: unknown };

export function PublicDocScreen({ api, target, tone, onSignIn, onOpen }: PublicDocProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const run = useRef(0);
  // The look the owner pinned to the document, raw from the server (lib/doc-theme.ts decides what is used).
  const [pinned, setPinned] = useState<{ tokens: unknown; style: unknown } | null>(null);

  const load = useCallback(async () => {
    const current = ++run.current;
    try {
      const doc = await api.publicDoc(target.token);
      if (current === run.current) setState({ status: "ready", doc });
      // Decoration: any failure leaves the phone's own look.
      if (doc.format === "markdown") void api.publicLook(target.token).then((look) => { if (current === run.current) setPinned(look); }, () => undefined);
      else setPinned(null);
    } catch (error) {
      if (current === run.current) setState({ status: "error", error });
    }
  }, [api, target.token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const onLink = useCallback((href: string | null, anchor: HTMLAnchorElement) => {
    const link = classifyDocumentLink(href, api.origin);
    switch (link.kind) {
      case "markie": onOpen(link.target); return;
      case "external": void openExternal(link.url); return;
      case "system": openSystemUrl(link.url); return;
      case "anchor": {
        const root = anchor.closest(".markdown-body");
        const el = root?.querySelector(`[id="${CSS.escape(link.id)}"], [id="user-content-${CSS.escape(link.id)}"], [name="${CSS.escape(link.id)}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      default:
        setNotice(href ? "This link points to a file on the author's computer, so it can't open here." : "This link has no destination.");
    }
  }, [api.origin, onOpen]);

  const loadAsset = useCallback((ref: string) => api.asset({ kind: "public", token: target.token }, ref).catch(() => null), [api, target.token]);

  const doc = state.status === "ready" ? state.doc : null;
  const isWd = doc?.format === "darkmown";
  const themed = useMemo(() => docThemeStyle(docLookTokens(pinned?.tokens, pinned?.style), tone), [pinned, tone]);
  const styleCss = useMemo(() => (themed ? docStyleCss(pinned?.style) : ""), [themed, pinned]);
  // A CSV or TSV reads as its table, which scrolls itself both ways.
  const isCsv = doc?.format === "text" && isCsvName(doc.name);
  const error = state.status === "error" ? publicLinkErrorCopy(state.error) : null;

  return (
    <div className="m-guest">
      <div className="m-guest-screen">
        <Screen
          title={doc ? displayName(doc.name) : "Document"}
          back={{ label: "Sign in", onBack: onSignIn }}
          actions={doc ? (
            <button type="button" className="m-nav-icon" aria-label="Share" onClick={() => setSharing(true)}>
              <ShareIcon size={23} />
            </button>
          ) : null}
          onRefresh={doc && !isWd && !isCsv ? load : undefined}
          fill={isWd || isCsv}
          className="m-document"
        >
          {state.status === "loading" ? (
            <div className="m-skeleton m-doc-skeleton" aria-busy="true" aria-label="Loading document">
              <span className="m-skeleton-block" style={{ width: "58%", height: 26 }} />
              {[92, 100, 84, 96, 70].map((width, index) => <span key={index} className="m-skeleton-block" style={{ width: `${width}%` }} />)}
            </div>
          ) : null}
          {error ? (
            <div className="m-empty" role="alert">
              <AlertIcon size={30} />
              <h2>{error.title}</h2>
              <p>{error.body}</p>
              {error.retry
                ? <button type="button" className="m-button m-button-secondary" onClick={() => { setState({ status: "loading" }); void load(); }}>Try again</button>
                : <button type="button" className="m-button m-button-primary" onClick={onSignIn}>Sign in</button>}
            </div>
          ) : null}
          {doc ? (
            <>
              <div className="m-doc-meta">
                <DocumentFormatMark format={markFormat(doc)} size="sm" />
                <div className="m-doc-meta-text">
                  <span className="m-visually-hidden">{doc.name}</span>
                  <span className="m-doc-meta-line">
                    <span className="m-badge">Public link</span>
                    <span>View only</span>
                  </span>
                </div>
              </div>
              {doc.format === "markdown" ? <div className={themed ? `m-doc-themed${themed.colors ? " has-colors" : ""}` : undefined} style={themed ? (themed.vars as CSSProperties) : undefined}>{styleCss ? <style data-doc-style="">{styleCss}</style> : null}<MarkdownView content={doc.content} onLink={onLink} loadAsset={loadAsset} /></div> : null}
              {doc.format === "text" && !isCsv ? <pre className="m-text-doc">{doc.content}</pre> : null}
              {isCsv ? <div className="m-csv-doc" data-csv-doc><CsvTable text={doc.content} name={doc.name} readOnly compact onOpenLink={openCsvLink} /></div> : null}
              {doc.format === "darkmown" ? <DarkmownView docKey={`s:${target.token}`} source={doc.content} tone={tone} /> : null}
            </>
          ) : null}
          {notice ? <div className="m-toast" role="status">{notice}</div> : null}
          {/* The link, and what this reader can already read as a file. Nothing here needs an account. */}
          {sharing && doc ? <ExportSheet title={doc.name} link={doc.privateLink} source={docExportSource(doc, loadAsset, themed ? pinned?.style : null)} onClose={() => setSharing(false)} /> : null}
        </Screen>
      </div>
      {doc ? (
        <footer className="m-guest-bar">
          <span>Sign in to edit, comment or share.</span>
          <button type="button" className="m-button m-button-primary m-button-small" onClick={onSignIn}>Sign in</button>
        </footer>
      ) : null}
    </div>
  );
}
