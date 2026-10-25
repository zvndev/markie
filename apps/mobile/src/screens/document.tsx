// One document: markdown as the desktop reads it, text as text, Darkmown as
// an interactive document behind the trust choice. The link goes to the share
// sheet; links inside the document open in the app when they are Markie
// documents and in the browser when they are anything else.
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { ApiError, documentErrorCopy, type ApiClient } from "../lib/api";
import { classifyDocumentLink, type LinkTarget } from "../lib/deep-links";
import { originLabel, type CloudDoc } from "../lib/docs";
import { openExternal, openSystemUrl, shareLink } from "../lib/native";
import { displayName, timeLabel } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { DarkmownView } from "../components/darkmown-view";
import { AlertIcon, LockIcon, ShareIcon, SparkleIcon } from "../components/icons";

interface DocumentProps {
  api: ApiClient;
  target: LinkTarget;
  /** The name from the list, shown while the document loads. */
  initialName?: string;
  backLabel: string;
  tone: Tone;
  onBack: () => void;
  onOpen: (target: LinkTarget) => void;
  onUnauthorized: () => void;
}

type State =
  | { status: "loading" }
  | { status: "ready"; doc: CloudDoc }
  | { status: "error"; error: unknown };

export function DocumentScreen({ api, target, initialName, backLabel, tone, onBack, onOpen, onUnauthorized }: DocumentProps) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [related, setRelated] = useState<Map<string, string>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const run = useRef(0);
  const docKey = target.kind === "doc" ? `d:${target.id}` : `s:${target.token}`;

  const load = useCallback(async () => {
    const current = ++run.current;
    try {
      const doc = target.kind === "doc" ? await api.doc(target.id) : await api.publicDoc(target.token);
      if (current !== run.current) return;
      setState({ status: "ready", doc });
      if (target.kind === "doc") void api.docLinks(target.id).then((links) => { if (current === run.current) setRelated(links); });
    } catch (error) {
      if (current !== run.current) return;
      if (error instanceof ApiError && error.status === 401 && target.kind === "doc") { onUnauthorized(); return; }
      setState({ status: "error", error });
    }
  }, [api, target, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const doc = state.status === "ready" ? state.doc : null;
  const title = doc ? displayName(doc.name) : initialName ? displayName(initialName) : "Document";

  const onLink = useCallback((href: string | null, anchor: HTMLAnchorElement) => {
    const link = classifyDocumentLink(href, api.origin, related);
    switch (link.kind) {
      case "markie": onOpen(link.target); return;
      case "related": onOpen({ kind: "doc", id: link.id, origin: api.origin }); return;
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
  }, [api.origin, onOpen, related]);

  const share = doc ? (
    <button type="button" className="m-nav-icon" aria-label="Share link" onClick={() => void shareLink(displayName(doc.name), doc.privateLink)}>
      <ShareIcon size={23} />
    </button>
  ) : null;

  const isWd = doc?.format === "darkmown";

  return (
    <Screen
      title={title}
      back={{ label: backLabel, onBack }}
      actions={share}
      onRefresh={doc && !isWd ? load : undefined}
      fill={isWd}
      className="m-document"
    >
      {state.status === "loading" ? <DocSkeleton /> : null}
      {state.status === "error" ? <DocError error={state.error} onRetry={() => { setState({ status: "loading" }); void load(); }} onSignIn={onUnauthorized} /> : null}
      {doc ? (
        <>
          <DocMeta doc={doc} />
          {doc.format === "markdown" ? <MarkdownView content={doc.content} onLink={onLink} /> : null}
          {doc.format === "text" ? <pre className="m-text-doc">{doc.content}</pre> : null}
          {doc.format === "darkmown" ? <DarkmownView docKey={docKey} source={doc.content} tone={tone} /> : null}
        </>
      ) : null}
      {notice ? <div className="m-toast" role="status">{notice}</div> : null}
    </Screen>
  );
}

function DocMeta({ doc }: { doc: CloudDoc }) {
  const from = originLabel(doc.origin);
  return (
    <div className="m-doc-meta">
      <DocumentFormatMark format={doc.format} size="sm" />
      <div className="m-doc-meta-text">
        <span className="m-doc-meta-name">{doc.name}</span>
        <span className="m-doc-meta-line">
          {from ? <span className="m-badge m-badge-agent"><SparkleIcon size={11} />{from}</span> : null}
          {doc.publicToken ? <span className="m-badge">Public link</span> : <span className="m-doc-private"><LockIcon size={12} />Private</span>}
          {doc.updatedAt ? <span>Updated {timeLabel(doc.updatedAt)}</span> : null}
        </span>
      </div>
    </div>
  );
}

function DocError({ error, onRetry, onSignIn }: { error: unknown; onRetry: () => void; onSignIn: () => void }) {
  const copy = documentErrorCopy(error);
  return (
    <div className="m-empty" role="alert">
      <AlertIcon size={30} />
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      {copy.detail ? <p className="m-empty-detail">{copy.detail}</p> : null}
      {copy.signIn
        ? <button type="button" className="m-button m-button-primary" onClick={onSignIn}>Sign in</button>
        : <button type="button" className="m-button m-button-secondary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function DocSkeleton() {
  return (
    <div className="m-skeleton m-doc-skeleton" aria-busy="true" aria-label="Loading document">
      <span className="m-skeleton-block" style={{ width: "58%", height: 26 }} />
      {[92, 100, 84, 96, 70, 0, 88, 100, 64].map((width, index) =>
        width ? <span key={index} className="m-skeleton-block" style={{ width: `${width}%` }} /> : <span key={index} className="m-skeleton-gap" />
      )}
    </div>
  );
}
