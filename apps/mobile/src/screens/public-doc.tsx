// A public share, read with no account. The client it is given holds no
// session, so nothing here can ask the server for anything a browser
// couldn't. Editing, comments and sharing with people need an account, so
// none of them is offered: the way to them is "Sign in".
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import type { ApiClient } from "../lib/api";
import { classifyDocumentLink, type LinkTarget, type PinnedPublicTarget } from "../lib/deep-links";
import { markFormat, type CloudDoc } from "../lib/docs";
import { openExternal, openSystemUrl, shareLink } from "../lib/native";
import { publicLinkErrorCopy } from "../lib/public-link";
import { displayName } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { DarkmownView } from "../components/darkmown-view";
import { AlertIcon, ShareIcon } from "../components/icons";

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
  const run = useRef(0);

  const load = useCallback(async () => {
    const current = ++run.current;
    try {
      const doc = await api.publicDoc(target.token);
      if (current === run.current) setState({ status: "ready", doc });
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
  const error = state.status === "error" ? publicLinkErrorCopy(state.error) : null;

  return (
    <div className="m-guest">
      <div className="m-guest-screen">
        <Screen
          title={doc ? displayName(doc.name) : "Document"}
          back={{ label: "Sign in", onBack: onSignIn }}
          actions={doc ? (
            <button type="button" className="m-nav-icon" aria-label="Share link" onClick={() => void shareLink(displayName(doc.name), doc.privateLink)}>
              <ShareIcon size={23} />
            </button>
          ) : null}
          onRefresh={doc && !isWd ? load : undefined}
          fill={isWd}
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
              {doc.format === "markdown" ? <MarkdownView content={doc.content} onLink={onLink} loadAsset={loadAsset} /> : null}
              {doc.format === "text" ? <pre className="m-text-doc">{doc.content}</pre> : null}
              {doc.format === "darkmown" ? <DarkmownView docKey={`s:${target.token}`} source={doc.content} tone={tone} /> : null}
            </>
          ) : null}
          {notice ? <div className="m-toast" role="status">{notice}</div> : null}
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
