// One document: markdown as the desktop reads it, text as text, Darkmown as
// an interactive document behind the trust choice. The link goes to the share
// sheet; links inside the document open in the app when they are Markie
// documents and in the browser when they are anything else.
import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { ApiError, documentErrorCopy, type ApiClient, type AssetSource } from "../lib/api";
import { classifyDocumentLink, type LinkTarget } from "../lib/deep-links";
import { canEditDoc, markFormat, originLabel, type CloudDoc } from "../lib/docs";
import { openExternal, openSystemUrl, shareLink } from "../lib/native";
import { serverLabel } from "../lib/server-origin";
import { displayName, timeLabel } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView } from "../components/markdown-view";
import { DarkmownView } from "../components/darkmown-view";
import { AlertIcon, CommentIcon, LockIcon, PeopleIcon, PencilIcon, ShareIcon, SparkleIcon, UserPlusIcon } from "../components/icons";
import { ShareSheet } from "../components/share-sheet";
import { docsPeople, docsPublicLink } from "../lib/share-people";
import { liveKind } from "../lib/live";
import type { ShareMember } from "../lib/api";

interface DocumentProps {
  api: ApiClient;
  target: LinkTarget;
  /** The name from the list, shown while the document loads. */
  initialName?: string;
  backLabel: string;
  tone: Tone;
  onBack: () => void;
  /** Back to the list, past any documents in between. */
  onRecent: () => void;
  onOpen: (target: LinkTarget) => void;
  /** Opens the editor on the version shown. */
  onEdit: (doc: CloudDoc) => void;
  /** Opens the live document with its comments showing. */
  onComments: (doc: CloudDoc) => void;
  /** Who is signed in, for the share sheet. */
  me: { email: string; name: string };
  onUnauthorized: () => void;
  /** Bumped by the app after a save, so the screen reads the new version. */
  reloadKey?: number;
}

type State =
  | { status: "loading" }
  | { status: "ready"; doc: CloudDoc }
  | { status: "error"; error: unknown };

export function DocumentScreen({ api, target, initialName, backLabel, tone, onBack, onRecent, onOpen, onEdit, onComments, me, onUnauthorized, reloadKey = 0 }: DocumentProps) {
  const [sharing, setSharing] = useState(false);
  // Who else is on it: null until known, and for a public share, which has no members to ask about.
  const [members, setMembers] = useState<ShareMember[] | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
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
      if (target.kind === "doc") void api.shares(target.id).then((list) => { if (current === run.current) setMembers(list); }, () => undefined);
      if (target.kind === "doc" && doc.role === "owner") void api.publicLink(target.id).then((url) => { if (current === run.current) setPublicUrl(url); }, () => undefined);
    } catch (error) {
      if (current !== run.current) return;
      if (error instanceof ApiError && error.status === 401 && target.kind === "doc") { onUnauthorized(); return; }
      setState({ status: "error", error });
    }
  }, [api, target, onUnauthorized]);

  useEffect(() => { void load(); }, [load, reloadKey]);
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

  const shared = !!members && members.length > 0;
  const owner = doc?.role === "owner";
  // Comments live on the live document, as on the desktop: a Markdown file someone else is on.
  const commentable = !!doc && !doc.publicToken && shared && liveKind(doc.name, doc.format) === "rich";
  const actions = doc ? (
    <>
      {canEditDoc(doc) ? (
        <button type="button" className="m-nav-icon" aria-label="Edit" onClick={() => onEdit(doc)}>
          <PencilIcon size={22} />
        </button>
      ) : null}
      {commentable ? (
        <button type="button" className="m-nav-icon" aria-label="Comments" onClick={() => onComments(doc)}>
          <CommentIcon size={22} />
        </button>
      ) : null}
      {doc.publicToken ? (
        <button type="button" className="m-nav-icon" aria-label="Share link" onClick={() => void shareLink(displayName(doc.name), doc.privateLink)}>
          <ShareIcon size={23} />
        </button>
      ) : (
        <button type="button" className="m-nav-icon" aria-label="Share" onClick={() => setSharing(true)}>
          <UserPlusIcon size={23} />
        </button>
      )}
    </>
  ) : null;

  const isWd = doc?.format === "darkmown";
  const loadAsset = useCallback((ref: string) => {
    const source: AssetSource = target.kind === "doc" ? { kind: "doc", id: target.id } : { kind: "public", token: target.token };
    return api.asset(source, ref).catch(() => null);
  }, [api, target]);

  return (
    <Screen
      title={title}
      back={{ label: backLabel, onBack }}
      actions={actions}
      onRefresh={doc && !isWd ? load : undefined}
      fill={isWd}
      className="m-document"
    >
      {state.status === "loading" ? <DocSkeleton /> : null}
      {state.status === "error" ? <DocError error={state.error} server={serverLabel(api.origin)} onRetry={() => { setState({ status: "loading" }); void load(); }} onRecent={onRecent} onSignIn={onUnauthorized} /> : null}
      {doc ? (
        <>
          <DocMeta doc={doc} members={members} publicUrl={publicUrl} />
          {doc.format === "markdown" ? <MarkdownView content={doc.content} onLink={onLink} loadAsset={loadAsset} /> : null}
          {doc.format === "text" ? <pre className="m-text-doc">{doc.content}</pre> : null}
          {doc.format === "darkmown" ? <DarkmownView docKey={docKey} source={doc.content} tone={tone} /> : null}
        </>
      ) : null}
      {notice ? <div className="m-toast" role="status">{notice}</div> : null}
      {sharing && doc && target.kind === "doc" ? (
        <ShareSheet
          title={doc.name}
          people={docsPeople(api, target.id)}
          publicLink={owner ? docsPublicLink(api, target.id) : null}
          canManage={owner}
          me={me}
          link={doc.privateLink}
          onClose={() => setSharing(false)}
          onUnauthorized={onUnauthorized}
          onChanged={() => {
            void api.shares(target.id).then(setMembers, () => undefined);
            if (owner) void api.publicLink(target.id).then(setPublicUrl, () => undefined);
          }}
        />
      ) : null}
    </Screen>
  );
}

// The nav bar names the document and its own first heading usually does too,
// so this line is only what neither says: its format, who made it, who can
// read it, and when it last changed. The file name is there for VoiceOver.
function DocMeta({ doc, members, publicUrl }: { doc: CloudDoc; members: ShareMember[] | null; publicUrl: string | null }) {
  const from = originLabel(doc.origin);
  return (
    <div className="m-doc-meta">
      <DocumentFormatMark format={markFormat(doc)} size="sm" />
      <div className="m-doc-meta-text">
        <span className="m-visually-hidden">{doc.name}</span>
        <span className="m-doc-meta-line">
          {from ? <span className="m-badge m-badge-agent"><SparkleIcon size={11} />{from}</span> : null}
          {doc.publicToken || publicUrl ? <span className="m-badge">Public link</span> : <span className="m-doc-private"><LockIcon size={12} />Private</span>}
          {members && members.length > 0 ? <span className="m-doc-private"><PeopleIcon size={13} />{members.length === 1 ? "1 person" : `${members.length} people`}</span> : null}
          {doc.role === "viewer" ? <span>View only</span> : null}
          {doc.updatedAt ? <span>Updated {timeLabel(doc.updatedAt)}</span> : null}
        </span>
      </div>
    </div>
  );
}

function DocError({ error, server, onRetry, onRecent, onSignIn }: { error: unknown; server: string; onRetry: () => void; onRecent: () => void; onSignIn: () => void }) {
  const copy = documentErrorCopy(error, server);
  return (
    <div className="m-empty" role="alert">
      <AlertIcon size={30} />
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      {copy.detail ? <p className="m-empty-detail">{copy.detail}</p> : null}
      {copy.signIn
        ? <button type="button" className="m-button m-button-primary" onClick={onSignIn}>Sign in</button>
        : copy.retry
          ? <button type="button" className="m-button m-button-secondary" onClick={onRetry}>Try again</button>
          : <button type="button" className="m-button m-button-secondary" onClick={onRecent}>Back to Recent</button>}
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
