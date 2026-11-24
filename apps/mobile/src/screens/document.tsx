// One document: markdown as the desktop reads it, text as text, Darkmown as
// an interactive document behind the trust choice. The link goes to the share
// sheet; links inside the document open in the app when they are Markie
// documents and in the browser when they are anything else.
//
// A Markdown document takes comments right here, with or without a live room:
// open threads are highlighted on the words they quote, and a selection
// becomes a new thread (components/comments-sheet.tsx ReadingCommentsSheet).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DocumentFormatMark } from "@/components/document-format-mark";
import { quoteOf, type Quote } from "@/lib/quote-anchor";
import { ApiError, documentErrorCopy, type ApiClient, type AssetSource } from "../lib/api";
import { classifyDocumentLink, type LinkTarget } from "../lib/deep-links";
import { canEditDoc, markFormat, originLabel, type CloudDoc } from "../lib/docs";
import { openExternal, openSystemUrl } from "../lib/native";
import { serverLabel } from "../lib/server-origin";
import { displayName, timeLabel } from "../lib/recent";
import type { Tone } from "../lib/theme-mode";
import { Screen } from "../components/screen";
import { MarkdownView, showThreadMark, type MarkdownComments, type ThreadQuote } from "../components/markdown-view";
import { CsvTable } from "@/components/csv-table/csv-table";
import { isCsvName } from "@/lib/csv-table";
import { ACCESS_LOST_BODY, ACCESS_LOST_TITLE, ReadingCommentsSheet, useThreads, type ReadingDraft } from "../components/comments-sheet";
import { DarkmownView } from "../components/darkmown-view";
import { AlertIcon, CommentIcon, EyeIcon, LockIcon, PeopleIcon, PencilIcon, ShareIcon, SparkleIcon, UserPlusIcon } from "../components/icons";
import { ExportSheet, ShareSheet } from "../components/share-sheet";
import { docExportSource } from "../lib/export";
import { COMMENTS_OFFLINE_NOTE, OfflineNote, useOffline } from "../components/offline-note";
import { docsPeople, docsPublicLink } from "../lib/share-people";
import { LIVE_MAX_CHARS, liveKind } from "../lib/live";
import { docLookTokens, docStyleCss, docThemeStyle } from "../lib/doc-theme";
import type { ShareMember } from "../lib/api";

interface DocumentProps {
  api: ApiClient;
  target: LinkTarget;
  /** The name from the list, shown while the document loads. */
  initialName?: string;
  /** Who shared it with this account, from the list: its owner, for the share sheet. */
  sharedBy?: string | null;
  backLabel: string;
  tone: Tone;
  onBack: () => void;
  /** Back to the list, past any documents in between. */
  onRecent: () => void;
  onOpen: (target: LinkTarget) => void;
  /** Opens the editor on the version shown. For a viewer it is the live document, read-only. */
  onEdit: (doc: CloudDoc) => void;
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

export function DocumentScreen({ api, target, initialName, sharedBy = null, backLabel, tone, onBack, onRecent, onOpen, onEdit, me, onUnauthorized, reloadKey = 0 }: DocumentProps) {
  const [sharing, setSharing] = useState(false);
  // Who else is on it: null until known, and for a public share, which has no members to ask about.
  const [members, setMembers] = useState<ShareMember[] | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [state, setState] = useState<State>({ status: "loading" });
  const [related, setRelated] = useState<Map<string, string>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const run = useRef(0);
  // The theme its owner pinned to it, raw from the server (lib/doc-theme.ts decides what is used).
  const [pinnedTheme, setPinnedTheme] = useState<unknown>(null);
  // The Markdown style pinned beside it, raw too.
  const [pinnedStyle, setPinnedStyle] = useState<unknown>(null);
  // This account was on the document and no longer is: found out by a comment the server refused.
  const [lost, setLost] = useState(false);
  const docKey = target.kind === "doc" ? `d:${target.id}` : `s:${target.token}`;

  const load = useCallback(async () => {
    const current = ++run.current;
    try {
      const doc = target.kind === "doc" ? await api.doc(target.id) : await api.publicDoc(target.token);
      if (current !== run.current) return;
      setState({ status: "ready", doc });
      setLost(false);
      if (target.kind === "doc") void api.docLinks(target.id).then((links) => { if (current === run.current) setRelated(links); });
      if (target.kind === "doc") void api.shares(target.id).then((list) => { if (current === run.current) setMembers(list); }, () => undefined);
      // Asked for a Live Doc too: an older or self-hosted server may have given
      // it a public link, and the owner must see it to turn it off.
      // Members read a Markdown document the way its owner styled it. The
      // owner keeps their own look, as on the desktop. Never an error: a
      // server with no such route, or no network, leaves the phone's own theme.
      const pinned = doc.format !== "markdown" ? null : target.kind === "doc" ? (doc.role !== "owner" ? api.docLook(target.id) : null) : api.publicLook(target.token);
      if (pinned) void pinned.then((look) => { if (current === run.current) { setPinnedTheme(look?.tokens ?? null); setPinnedStyle(look?.style ?? null); } }, () => undefined);
      else { setPinnedTheme(null); setPinnedStyle(null); }
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

  // ── Comments ──────────────────────────────────────────────────────────
  // The desktop shows comments on a Markdown document it edits live, so those
  // are the documents that take them here: not text, Darkmown or a public
  // link, and not one too large for the desktop to open live. Word, RTF and
  // OpenDocument files have their own screen and no comments at all.
  const docId = target.kind === "doc" ? target.id : "";
  const takesComments = !!doc && target.kind === "doc" && !doc.publicToken && doc.format === "markdown"
    && liveKind(doc.name, doc.format) === "rich" && doc.content.length <= LIVE_MAX_CHARS;
  const { threads, error: threadsError, refresh: refreshThreads, forbidden } = useThreads(api, docId, takesComments && !lost, onUnauthorized);
  // On the owner's own unshared document nobody else would ever see a
  // comment, and the desktop opens no room to show one. Threads already
  // there are still shown.
  const commentable = takesComments && (!owner || shared || (threads?.length ?? 0) > 0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<ReadingDraft | null>(null);
  const [focusThread, setFocusThread] = useState<string | null>(null);
  // The words selected in the document right now, ready to comment on.
  const [picked, setPicked] = useState<Quote | null>(null);
  const [placedThreads, setPlacedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const articleHost = useRef<HTMLDivElement>(null);
  const openThreads = threads?.filter((thread) => thread.status === "open").length ?? 0;

  const threadQuotes = useMemo<ThreadQuote[]>(() => (threads ?? []).flatMap((thread) => {
    const quote = quoteOf(thread.anchor);
    return quote ? [{ id: thread.id, quote, highlight: thread.status === "open" }] : [];
  }), [threads]);
  const onPlaced = useCallback((ids: ReadonlySet<string>) => {
    setPlacedThreads((current) => (current.size === ids.size && [...ids].every((id) => current.has(id)) ? current : ids));
  }, []);
  const onThread = useCallback((id: string) => {
    setCommentDraft(null);
    setFocusThread(id);
    setCommentsOpen(true);
  }, []);
  // A tapped notification names its thread (?thread=<id>, lib/push.ts): the
  // sheet opens on it, once, when the threads have loaded. An id that is not
  // one of this document's threads (deleted since, or made up) opens nothing.
  const linkedThread = target.kind === "doc" ? target.thread ?? null : null;
  const linkedShown = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedThread || !threads || lost || linkedShown.current === linkedThread) return;
    linkedShown.current = linkedThread;
    if (threads.some((thread) => thread.id === linkedThread)) onThread(linkedThread);
  }, [linkedThread, threads, lost, onThread]);
  const markdownComments = useMemo<MarkdownComments | undefined>(
    () => (commentable ? { threads: threadQuotes, onPlaced, onThread, onSelect: setPicked } : undefined),
    [commentable, threadQuotes, onPlaced, onThread],
  );
  // A press on the Comment button can clear the selection before the tap is
  // over (iOS does), so the words are held from the press until the tap lands.
  const [held, setHeld] = useState<Quote | null>(null);
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(null), 1500);
    return () => clearTimeout(timer);
  }, [held]);
  const startComment = () => {
    const quote = held ?? picked;
    if (!quote) return;
    setCommentDraft({ quote });
    setFocusThread(null);
    setCommentsOpen(true);
    setPicked(null);
    setHeld(null);
    window.getSelection()?.removeAllRanges();
  };
  const closeComments = () => {
    setCommentsOpen(false);
    setCommentDraft(null);
    setFocusThread(null);
  };
  // The list was refused while reading: the document is no longer shared here.
  useEffect(() => { if (forbidden) setLost(true); }, [forbidden]);
  // Access is gone, so the copy kept on this phone goes too: asking for the
  // document once more lets the store hear the server's refusal and drop it.
  useEffect(() => { if (lost && target.kind === "doc") void api.doc(target.id).catch(() => undefined); }, [lost, api, target]);
  // Comments are not kept on the phone. With no connection the document
  // still reads from the store; the sheet says comments need a connection,
  // and nothing is offered that could only fail.
  const offlineNow = useOffline(api)?.offline ?? false;
  // A viewer can't edit, but can watch the people who can: the same live
  // document, read-only, where their changes arrive as they type. It sits
  // where the pencil would be. (The Comments button used to be the only way
  // in; comments moved to this screen and the way in went with them.)
  const canFollowLive = !!doc && target.kind === "doc" && doc.role === "viewer" && doc.version !== null && !doc.publicToken
    && liveKind(doc.name, doc.format) !== null && doc.content.length <= LIVE_MAX_CHARS;
  const actions = doc && !lost ? (
    <>
      {canEditDoc(doc) ? (
        <button type="button" className="m-nav-icon" aria-label="Edit" onClick={() => onEdit(doc)}>
          <PencilIcon size={22} />
        </button>
      ) : canFollowLive && !offlineNow ? (
        <button type="button" className="m-nav-icon" aria-label="Follow live" onClick={() => onEdit(doc)}>
          <EyeIcon size={23} />
        </button>
      ) : null}
      {commentable && !lost ? (
        <button type="button" className="m-nav-icon m-nav-badged" aria-label={openThreads ? `Comments, ${openThreads} open` : "Comments"} onClick={() => { setCommentDraft(null); setFocusThread(null); setCommentsOpen(true); }}>
          <CommentIcon size={22} />
          {openThreads ? <span className="m-nav-badge" aria-hidden="true">{openThreads}</span> : null}
        </button>
      ) : null}
      {doc.publicToken ? (
        <button type="button" className="m-nav-icon" aria-label="Share" onClick={() => setSharing(true)}>
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
  // A CSV or TSV reads as its table, which scrolls itself both ways.
  const isCsv = doc?.format === "text" && isCsvName(doc.name);
  const themed = useMemo(() => docThemeStyle(docLookTokens(pinnedTheme, pinnedStyle), tone), [pinnedTheme, pinnedStyle, tone]);
  const styleCss = useMemo(() => (themed ? docStyleCss(pinnedStyle) : ""), [themed, pinnedStyle]);
  const loadAsset = useCallback((ref: string) => {
    const source: AssetSource = target.kind === "doc" ? { kind: "doc", id: target.id } : { kind: "public", token: target.token };
    return api.asset(source, ref).catch(() => null);
  }, [api, target]);

  return (
    <Screen
      title={title}
      back={{ label: backLabel, onBack }}
      actions={actions}
      onRefresh={doc && !isWd && !isCsv && !lost ? async () => { await Promise.all([load(), takesComments ? refreshThreads() : null]); } : undefined}
      fill={isWd || isCsv}
      className="m-document"
    >
      {state.status === "loading" ? <DocSkeleton /> : null}
      {state.status === "error" ? <DocError error={state.error} server={serverLabel(api.origin)} onRetry={() => { setState({ status: "loading" }); void load(); }} onRecent={onRecent} onSignIn={onUnauthorized} /> : null}
      {doc && lost ? (
        // The text is taken off the screen with the access: it is not this reader's to see any more.
        <div className="m-empty" role="alert" data-access-lost>
          <AlertIcon size={30} />
          <h2>{ACCESS_LOST_TITLE}</h2>
          <p>{ACCESS_LOST_BODY}</p>
          <button type="button" className="m-button m-button-secondary" onClick={onRecent}>Back to Recent</button>
        </div>
      ) : null}
      {doc && !lost ? (
        <>
          <DocMeta doc={doc} members={members} publicUrl={publicUrl} />
          <OfflineNote api={api} doc={doc} onChanged={() => void load()} onGone={onRecent} onUnauthorized={onUnauthorized} />
          {doc.format === "markdown" ? <div ref={articleHost} className={themed ? `m-doc-themed${themed.colors ? " has-colors" : ""}` : undefined} style={themed ? (themed.vars as CSSProperties) : undefined}>{styleCss ? <style data-doc-style="">{styleCss}</style> : null}<MarkdownView content={doc.content} onLink={onLink} loadAsset={loadAsset} comments={markdownComments} /></div> : null}
          {doc.format === "text" && !isCsv ? <pre className="m-text-doc">{doc.content}</pre> : null}
          {isCsv ? <div className="m-csv-doc" data-csv-doc><CsvTable text={doc.content} name={doc.name} readOnly compact /></div> : null}
          {doc.format === "darkmown" ? <DarkmownView docKey={docKey} source={doc.content} tone={tone} /> : null}
        </>
      ) : null}
      {notice ? <div className="m-toast" role="status">{notice}</div> : null}
      {commentable && !lost && !offlineNow && (picked || held) && !commentsOpen ? (
        <button type="button" className="m-select-comment" onPointerDown={(event) => { event.preventDefault(); setHeld(picked); }} onClick={startComment}>
          <CommentIcon size={18} />Comment
        </button>
      ) : null}
      {commentsOpen && doc && target.kind === "doc" ? (
        <ReadingCommentsSheet
          api={api}
          docId={target.id}
          threads={threads}
          error={offlineNow && threadsError ? COMMENTS_OFFLINE_NOTE : threadsError}
          refresh={refreshThreads}
          placed={placedThreads}
          meEmail={me.email}
          canResolve={doc.role === "owner" || doc.role === "editor"}
          canModerate={owner}
          canComment
          draft={commentDraft}
          onDraftDone={() => setCommentDraft(null)}
          onJump={(id) => {
            closeComments();
            // After the sheet is gone, so the scroll is seen.
            requestAnimationFrame(() => showThreadMark(articleHost.current, id));
          }}
          focusThreadId={focusThread}
          onAccessLost={() => setLost(true)}
          lost={lost}
          onClose={closeComments}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {sharing && doc && target.kind === "doc" ? (
        <ShareSheet
          title={doc.name}
          people={docsPeople(api, target.id)}
          publicLink={owner ? docsPublicLink(api, target.id) : null}
          liveDoc={isLiveDoc(doc)}
          editsTogether={liveKind(doc.name, doc.format) !== null && doc.content.length <= LIVE_MAX_CHARS}
          canManage={owner}
          owner={owner ? null : sharedBy}
          me={me}
          link={doc.privateLink}
          exportSource={docExportSource(doc, loadAsset, themed ? pinnedStyle : null)}
          onClose={() => setSharing(false)}
          onUnauthorized={onUnauthorized}
          onChanged={() => {
            void api.shares(target.id).then(setMembers, () => undefined);
            if (owner) void api.publicLink(target.id).then(setPublicUrl, () => undefined);
          }}
        />
      ) : null}
      {sharing && doc && target.kind !== "doc" ? <ExportSheet title={doc.name} link={doc.privateLink} source={docExportSource(doc, loadAsset, themed ? pinnedStyle : null)} onClose={() => setSharing(false)} /> : null}
    </Screen>
  );
}

/** A Live Doc: Darkmown, by format or by its .wd name. Never public. */
function isLiveDoc(doc: CloudDoc): boolean {
  return doc.format === "darkmown" || /\.wd$/i.test(doc.name.trim());
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
