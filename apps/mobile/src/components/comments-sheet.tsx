// Comments on a document, the desktop's threads (server/src/comments.ts) in a
// sheet a thumb can use: read every thread with the text it is on, add one on
// a selection, reply, resolve or reopen, and delete your own.
//
// There are two ways in. In a live room (CommentsSheet) threads are anchored
// exactly as the desktop anchors them (src/lib/comment-anchors.ts through the
// loaded runtime). On the reading screen (ReadingCommentsSheet) there is no
// room, so a thread is anchored by the words it quotes
// (src/lib/quote-anchor.ts) and the desktop finds those words. Either way a
// comment made on the phone sits on the same words on the computer, and a
// thread whose words can't be found is listed as not placed, never left out.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { LiveSession } from "@/components/rich-view";
import { quoteAnchor, quoteOf, type Quote } from "@/lib/quote-anchor";
import { ApiError, type ApiClient, type CommentThread } from "../lib/api";
import { haptics } from "../lib/native";
import { Sheet } from "./sheet";
import { Avatar } from "./presence";

const POLL_MS = 15_000;

/** A selection waiting for its first comment. */
export interface CommentDraft {
  from: number;
  to: number;
  quote: string;
}

/** Words chosen on the reading screen, waiting for their first comment. */
export interface ReadingDraft {
  quote: Quote;
}

interface Located {
  thread: CommentThread;
  /** Whether the commented words are in the document as it is now. */
  placed: boolean;
  /** The words, when they are known: where it sits, or what it was left on. */
  quote: string | null;
  /** Said in place of a jump when the thread has no place. */
  lostNote: string;
}

export const WORDS_GONE_NOTE = "These words are no longer in the document.";
export const TEXT_DELETED_NOTE = "The commented text was deleted";
/** A thread from a live room, made before anchors carried their words. */
export const LIVE_ONLY_NOTE = "Its place shows when the document is open for editing.";
export const ACCESS_LOST_TITLE = "You no longer have access";
export const ACCESS_LOST_BODY = "This document isn't shared with you any more. Ask its owner to share it again.";

/** Threads, polled while a document is open: the count in the nav bar comes from here. */
export function useThreads(api: ApiClient, docId: string, enabled: boolean, onUnauthorized: () => void) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server refused the list: this account can no longer read the document.
  const [forbidden, setForbidden] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setThreads(await api.threads(docId));
      setError(null);
      setForbidden(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      if (failure instanceof ApiError && failure.status === 403) setForbidden(true);
      setError(failure instanceof Error ? failure.message : "Couldn't load comments.");
    }
  }, [api, docId, onUnauthorized]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { threads, error, refresh, forbidden };
}

/** A number that changes whenever the editor's document does. */
export function useDocRevision(editor: Editor | null): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const bump = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) setRevision((n) => n + 1); };
    editor.on("transaction", bump);
    return () => { editor.off("transaction", bump); };
  }, [editor]);
  return revision;
}

interface CommentsSheetProps {
  api: ApiClient;
  docId: string;
  editor: Editor | null;
  live: LiveSession | null;
  threads: CommentThread[] | null;
  error: string | null;
  refresh: () => Promise<void>;
  meId: string;
  /** Owners and editors resolve and reopen; the server refuses anyone else. */
  canResolve: boolean;
  /** The owner may delete anyone's comment. */
  canModerate: boolean;
  /** Viewers comment too; someone whose access went away does not. */
  canComment: boolean;
  draft: CommentDraft | null;
  onDraftDone: () => void;
  onClose: () => void;
  onUnauthorized: () => void;
}

export function CommentsSheet({ api, docId, editor, live, threads, error, refresh, meId, canResolve, canModerate, canComment, draft, onDraftDone, onClose, onUnauthorized }: CommentsSheetProps) {
  // The words a thread is on are found in the editor's document as it is
  // now. The sheet can open before the room has synced, or while a peer is
  // typing, so every change to the document finds them again; otherwise a
  // thread reads "deleted" until the sheet is closed and opened.
  const revision = useDocRevision(editor);
  const ranges = useMemo(() => {
    const found = new Map<string, { from: number; to: number }>();
    if (!editor || editor.isDestroyed || !live) return found;
    for (const thread of threads ?? []) {
      try {
        const range = live.runtime.anchorToAbsolute(editor, live.ydoc, thread.anchor as never);
        if (range) found.set(thread.id, range);
      } catch {
        // Not placed.
      }
    }
    return found;
  }, [threads, editor, live, revision]);
  const located = useMemo<Located[]>(() => (threads ?? []).map((thread) => {
    const range = ranges.get(thread.id);
    if (range && editor && !editor.isDestroyed) return { thread, placed: true, quote: editor.state.doc.textBetween(range.from, range.to, " "), lostNote: "" };
    const kept = quoteOf(thread.anchor)?.exact ?? null;
    return { thread, placed: false, quote: kept, lostNote: kept ? WORDS_GONE_NOTE : TEXT_DELETED_NOTE };
  }), [threads, ranges, editor]);

  const anchorForDraft = () => (draft && editor && live ? live.runtime.selectionToAnchor(editor, draft.from, draft.to) : null);

  const jump = (threadId: string) => {
    const range = ranges.get(threadId);
    if (!range || !editor) return;
    onClose();
    // After the sheet is gone, so the keyboard the focus raises has room.
    requestAnimationFrame(() => editor.chain().focus().setTextSelection(range).scrollIntoView().run());
  };

  return (
    <ThreadsSheet
      api={api} docId={docId} located={located} loaded={threads !== null} error={error} refresh={refresh}
      meId={meId} canResolve={canResolve} canModerate={canModerate} canComment={canComment}
      draftQuote={draft ? draft.quote : null} anchorForDraft={anchorForDraft} onDraftDone={onDraftDone}
      emptyHint="Select some text, then tap the comment button above the keyboard."
      onJump={jump} onClose={onClose} onUnauthorized={onUnauthorized}
    />
  );
}

interface ReadingCommentsSheetProps {
  api: ApiClient;
  docId: string;
  threads: CommentThread[] | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** The threads whose words the reading screen found in the document. */
  placed: ReadonlySet<string>;
  /** This account, by address: the reading screen is not told its id. */
  meEmail: string;
  canResolve: boolean;
  canModerate: boolean;
  canComment: boolean;
  draft: ReadingDraft | null;
  onDraftDone: () => void;
  /** Shows a placed thread's words in the document. */
  onJump: (threadId: string) => void;
  /** The thread a tapped highlight belongs to: scrolled to when the sheet opens. */
  focusThreadId?: string | null;
  /** The server said this account can no longer comment or read here. */
  onAccessLost: () => void;
  /** Already known to be gone when the sheet opened. */
  lost?: boolean;
  onClose: () => void;
  onUnauthorized: () => void;
}

/** Comments beside a document that is only being read: no live room, no editor. */
export function ReadingCommentsSheet({ api, docId, threads, error, refresh, placed, meEmail, canResolve, canModerate, canComment, draft, onDraftDone, onJump, focusThreadId = null, onAccessLost, lost = false, onClose, onUnauthorized }: ReadingCommentsSheetProps) {
  const located = useMemo<Located[]>(() => (threads ?? []).map((thread) => {
    const quote = quoteOf(thread.anchor);
    if (!quote) return { thread, placed: false, quote: null, lostNote: LIVE_ONLY_NOTE };
    return { thread, placed: placed.has(thread.id), quote: quote.exact, lostNote: WORDS_GONE_NOTE };
  }), [threads, placed]);
  return (
    <ThreadsSheet
      api={api} docId={docId} located={located} loaded={threads !== null} error={error} refresh={refresh}
      meId="" meEmail={meEmail} canResolve={canResolve} canModerate={canModerate} canComment={canComment}
      draftQuote={draft ? draft.quote.exact : null} anchorForDraft={() => (draft ? quoteAnchor(draft.quote) : null)} onDraftDone={onDraftDone}
      emptyHint="Select some words in the document, then tap Comment."
      onJump={onJump} focusThreadId={focusThreadId} onAccessLost={onAccessLost} lost={lost}
      onClose={onClose} onUnauthorized={onUnauthorized}
    />
  );
}

interface ThreadsSheetProps {
  api: ApiClient;
  docId: string;
  located: Located[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  meId: string;
  meEmail?: string;
  canResolve: boolean;
  canModerate: boolean;
  canComment: boolean;
  /** The words a new thread is about to be left on, or null when none is being written. */
  draftQuote: string | null;
  /** The anchor for those words, made when the comment is sent. */
  anchorForDraft: () => unknown | null;
  onDraftDone: () => void;
  emptyHint: string;
  onJump: (threadId: string) => void;
  focusThreadId?: string | null;
  onAccessLost?: () => void;
  lost?: boolean;
  onClose: () => void;
  onUnauthorized: () => void;
}

function ThreadsSheet({ api, docId, located, loaded, error, refresh, meId, meEmail = "", canResolve, canModerate, canComment, draftQuote, anchorForDraft, onDraftDone, emptyHint, onJump, focusThreadId = null, onAccessLost, lost: lostAlready = false, onClose, onUnauthorized }: ThreadsSheetProps) {
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lostNow, setLostNow] = useState(false);
  const lost = lostNow || lostAlready;
  const drafting = draftQuote !== null;

  const open = located.filter((item) => item.thread.status === "open");
  const resolved = located.filter((item) => item.thread.status === "resolved");

  // The server answers 403 both to someone who was removed and to someone
  // who may still read but not do this one thing (a viewer resolving). Asking
  // for the document tells them apart: it is gone for the first.
  const stillHasAccess = async (): Promise<boolean> => {
    try {
      await api.doc(docId);
      return true;
    } catch (failure) {
      return !(failure instanceof ApiError && (failure.status === 403 || failure.status === 404));
    }
  };

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      haptics.success();
      await refresh();
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return false; }
      if (failure instanceof ApiError && failure.status === 403) {
        if (!(await stillHasAccess())) {
          setLostNow(true);
          onAccessLost?.();
          return false;
        }
        setActionError("You can't do that on this document any more.");
        void refresh();
        return false;
      }
      if (failure instanceof ApiError && failure.status === 404) {
        setActionError("That comment is no longer there.");
        void refresh();
        return false;
      }
      setActionError(failure instanceof Error ? failure.message : "That didn't go through. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = async (body: string) => {
    if (!drafting) return false;
    const anchor = anchorForDraft();
    if (!anchor) { setActionError("Those words changed while you were writing. Select them again."); return false; }
    const ok = await act(() => api.createThread(docId, anchor, body));
    if (ok) onDraftDone();
    return ok;
  };

  // A tapped highlight opens the sheet on its thread.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusThreadId || !loaded) return;
    const card = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-thread]") ?? []).find((el) => el.dataset.thread === focusThreadId);
    if (!card) return;
    card.scrollIntoView?.({ block: "center" });
    card.classList.add("is-shown");
    const timer = setTimeout(() => card.classList.remove("is-shown"), 1600);
    return () => clearTimeout(timer);
  }, [focusThreadId, loaded]);

  const card = (item: Located) => (
    <ThreadCard key={item.thread.id} item={item} meId={meId} meEmail={meEmail} busy={busy} canResolve={canResolve} canModerate={canModerate} canComment={canComment}
      onJump={() => onJump(item.thread.id)}
      onReply={(text) => act(() => api.reply(docId, item.thread.id, text))}
      onStatus={(status) => void act(() => api.setThreadStatus(docId, item.thread.id, status))}
      onDelete={(commentId) => void act(() => api.deleteComment(docId, item.thread.id, commentId))}
    />
  );

  const count = open.length;
  if (lost) {
    return (
      <Sheet title="Comments" onClose={onClose} tall className="m-comments">
        <div className="m-empty m-empty-compact" role="alert" data-access-lost>
          <h2>{ACCESS_LOST_TITLE}</h2>
          <p>{ACCESS_LOST_BODY}{lostNow ? " What you just did wasn't saved." : ""}</p>
          <button type="button" className="m-button m-button-secondary" onClick={onClose}>Close</button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet
      title={drafting ? "New comment" : "Comments"}
      onClose={onClose}
      tall
      className="m-comments"
      accessory={!drafting && count ? <span className="m-sheet-count">{count} open</span> : null}
    >
      <div ref={body}>
        {drafting ? (
          <div className="m-comment-new">
            <blockquote className="m-comment-quote">{draftQuote || "The selected text"}</blockquote>
            <Composer placeholder="Add a comment" autoFocus busy={busy} onSubmit={submitDraft} onCancel={onDraftDone} submitLabel="Comment" />
          </div>
        ) : null}
        {actionError ? <p className="m-form-error" role="alert">{actionError}</p> : null}
        {!drafting && error && !loaded ? <p className="m-form-error" role="alert">{error}</p> : null}
        {!drafting && !loaded && !error ? <div className="m-list-more"><span className="m-spinner" aria-hidden="true" /><span className="m-visually-hidden" role="status">Loading comments</span></div> : null}
        {!drafting && loaded && open.length === 0 ? (
          <div className="m-empty m-empty-compact">
            <h2>No open comments</h2>
            <p>{canComment ? emptyHint : "Comments from people on this document show up here."}</p>
          </div>
        ) : null}
        {!drafting ? open.map(card) : null}
        {!drafting && resolved.length > 0 ? (
          <button type="button" className="m-comments-resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
        ) : null}
        {!drafting && showResolved ? resolved.map(card) : null}
      </div>
    </Sheet>
  );
}

function ThreadCard({ item, meId, meEmail, busy, canResolve, canModerate, canComment, onJump, onReply, onStatus, onDelete }: {
  item: Located;
  meId: string;
  meEmail: string;
  busy: boolean;
  canResolve: boolean;
  canModerate: boolean;
  canComment: boolean;
  onJump: () => void;
  onReply: (body: string) => Promise<boolean>;
  onStatus: (status: "open" | "resolved") => void;
  onDelete: (commentId: string) => void;
}) {
  const { thread, quote, placed, lostNote } = item;
  const resolved = thread.status === "resolved";
  const mine = (comment: { authorId: string; authorEmail: string }) =>
    (!!meId && comment.authorId === meId) || (!!meEmail && comment.authorEmail.toLowerCase() === meEmail.toLowerCase());
  return (
    <article className={`m-thread${resolved ? " is-resolved" : ""}`} data-thread={thread.id}>
      <header className="m-thread-head">
        {placed ? (
          <button type="button" className="m-comment-quote m-comment-quote-link" onClick={onJump} aria-label={`Show "${quote}" in the document`}>{quote || "…"}</button>
        ) : (
          <span className="m-comment-quote is-gone" data-unplaced>
            <span className="m-comment-unplaced">Not placed</span>
            {quote ? <q>{quote}</q> : null}
            <span className="m-comment-lost-note">{lostNote}</span>
          </span>
        )}
        {canResolve ? (
          <button type="button" className="m-chip" disabled={busy} onClick={() => onStatus(resolved ? "open" : "resolved")}>{resolved ? "Reopen" : "Resolve"}</button>
        ) : resolved ? <span className="m-chip is-static">Resolved</span> : null}
      </header>
      <ol className="m-thread-comments">
        {thread.comments.map((comment) => {
          const who = comment.authorName || comment.authorEmail || "Someone";
          return (
            <li key={comment.id} className="m-comment">
              <Avatar name={who} size={28} />
              <div className="m-comment-main">
                <div className="m-comment-meta">
                  <span className="m-comment-author">{who}</span>
                  <time dateTime={comment.createdAt}>{commentTime(comment.createdAt)}</time>
                </div>
                <p className="m-comment-body m-selectable">{comment.body}</p>
              </div>
              {mine(comment) || canModerate ? (
                <button type="button" className="m-comment-delete" aria-label={`Delete ${who}'s comment`} disabled={busy} onClick={() => onDelete(comment.id)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {canComment && !resolved ? <Composer placeholder="Reply" busy={busy} onSubmit={onReply} submitLabel="Reply" /> : null}
    </article>
  );
}

function Composer({ placeholder, onSubmit, onCancel, autoFocus = false, busy, submitLabel }: {
  placeholder: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
  busy: boolean;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState("");
  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    if (await onSubmit(body)) setDraft("");
  };
  return (
    <form className="m-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        autoFocus={autoFocus}
        enterKeyHint="send"
      />
      <div className="m-composer-actions">
        {onCancel ? <button type="button" className="m-button m-button-small m-button-secondary" onClick={onCancel}>Cancel</button> : null}
        <button type="submit" className="m-button m-button-small m-button-primary" disabled={!draft.trim() || busy}>{submitLabel}</button>
      </div>
    </form>
  );
}

function commentTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
