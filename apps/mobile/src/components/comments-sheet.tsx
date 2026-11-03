// Comments on a live document, the desktop's threads (server/src/comments.ts)
// in a sheet a thumb can use: read every thread with the text it is on, add
// one on a selection, reply, resolve or reopen, and delete your own. Threads
// are anchored in the live room exactly as the desktop anchors them
// (src/lib/comment-anchors.ts through the loaded runtime), so a comment made
// on the phone sits on the same words on the computer.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { LiveSession } from "@/components/rich-view";
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

interface Located {
  thread: CommentThread;
  /** Where the commented words are now, or null when they were deleted. */
  range: { from: number; to: number } | null;
  quote: string | null;
}

/** Threads, polled while a live document is open: the count in the nav bar comes from here. */
export function useThreads(api: ApiClient, docId: string, enabled: boolean, onUnauthorized: () => void) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setThreads(await api.threads(docId));
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) { onUnauthorized(); return; }
      setError(failure instanceof Error ? failure.message : "Couldn't load comments.");
    }
  }, [api, docId, onUnauthorized]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { threads, error, refresh };
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
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The words a thread is on are found in the editor's document as it is
  // now. The sheet can open before the room has synced, or while a peer is
  // typing, so every change to the document finds them again; otherwise a
  // thread reads "deleted" until the sheet is closed and opened.
  const revision = useDocRevision(editor);
  const located = useMemo<Located[]>(() => (threads ?? []).map((thread) => {
    if (!editor || editor.isDestroyed || !live) return { thread, range: null, quote: null };
    try {
      const range = live.runtime.anchorToAbsolute(editor, live.ydoc, thread.anchor as never);
      if (!range) return { thread, range: null, quote: null };
      return { thread, range, quote: editor.state.doc.textBetween(range.from, range.to, " ") };
    } catch {
      return { thread, range: null, quote: null };
    }
  }), [threads, editor, live, revision]);

  const open = located.filter((item) => item.thread.status === "open");
  const resolved = located.filter((item) => item.thread.status === "resolved");

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
      setActionError(failure instanceof Error ? failure.message : "That didn't go through. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = async (body: string) => {
    if (!draft || !editor || !live) return false;
    const anchor = live.runtime.selectionToAnchor(editor, draft.from, draft.to);
    if (!anchor) { setActionError("Those words changed while you were writing. Select them again."); return false; }
    const ok = await act(() => api.createThread(docId, anchor, body));
    if (ok) onDraftDone();
    return ok;
  };

  const jump = (range: { from: number; to: number } | null) => {
    if (!range || !editor) return;
    onClose();
    // After the sheet is gone, so the keyboard the focus raises has room.
    requestAnimationFrame(() => editor.chain().focus().setTextSelection(range).scrollIntoView().run());
  };

  const count = open.length;
  return (
    <Sheet
      title={draft ? "New comment" : "Comments"}
      onClose={onClose}
      tall
      className="m-comments"
      accessory={!draft && count ? <span className="m-sheet-count">{count} open</span> : null}
    >
      {draft ? (
        <div className="m-comment-new">
          <blockquote className="m-comment-quote">{draft.quote || "The selected text"}</blockquote>
          <Composer placeholder="Add a comment" autoFocus busy={busy} onSubmit={submitDraft} onCancel={onDraftDone} submitLabel="Comment" />
        </div>
      ) : null}
      {actionError ? <p className="m-form-error" role="alert">{actionError}</p> : null}
      {!draft && error && !threads ? <p className="m-form-error" role="alert">{error}</p> : null}
      {!draft && threads === null && !error ? <div className="m-list-more"><span className="m-spinner" aria-hidden="true" /><span className="m-visually-hidden" role="status">Loading comments</span></div> : null}
      {!draft && threads !== null && open.length === 0 ? (
        <div className="m-empty m-empty-compact">
          <h2>No open comments</h2>
          <p>{canComment ? "Select some text, then tap the comment button above the keyboard." : "Comments from people on this document show up here."}</p>
        </div>
      ) : null}
      {!draft ? open.map((item) => (
        <ThreadCard key={item.thread.id} item={item} meId={meId} busy={busy} canResolve={canResolve} canModerate={canModerate} canComment={canComment}
          onJump={() => jump(item.range)}
          onReply={(body) => act(() => api.reply(docId, item.thread.id, body))}
          onStatus={(status) => void act(() => api.setThreadStatus(docId, item.thread.id, status))}
          onDelete={(commentId) => void act(() => api.deleteComment(docId, item.thread.id, commentId))}
        />
      )) : null}
      {!draft && resolved.length > 0 ? (
        <button type="button" className="m-comments-resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved((value) => !value)}>
          {showResolved ? "Hide" : "Show"} {resolved.length} resolved
        </button>
      ) : null}
      {!draft && showResolved ? resolved.map((item) => (
        <ThreadCard key={item.thread.id} item={item} meId={meId} busy={busy} canResolve={canResolve} canModerate={canModerate} canComment={canComment}
          onJump={() => jump(item.range)}
          onReply={(body) => act(() => api.reply(docId, item.thread.id, body))}
          onStatus={(status) => void act(() => api.setThreadStatus(docId, item.thread.id, status))}
          onDelete={(commentId) => void act(() => api.deleteComment(docId, item.thread.id, commentId))}
        />
      )) : null}
    </Sheet>
  );
}

function ThreadCard({ item, meId, busy, canResolve, canModerate, canComment, onJump, onReply, onStatus, onDelete }: {
  item: Located;
  meId: string;
  busy: boolean;
  canResolve: boolean;
  canModerate: boolean;
  canComment: boolean;
  onJump: () => void;
  onReply: (body: string) => Promise<boolean>;
  onStatus: (status: "open" | "resolved") => void;
  onDelete: (commentId: string) => void;
}) {
  const { thread, quote, range } = item;
  const resolved = thread.status === "resolved";
  return (
    <article className={`m-thread${resolved ? " is-resolved" : ""}`} data-thread={thread.id}>
      <header className="m-thread-head">
        {range ? (
          <button type="button" className="m-comment-quote m-comment-quote-link" onClick={onJump} aria-label={`Show "${quote}" in the document`}>{quote || "…"}</button>
        ) : (
          <span className="m-comment-quote is-gone">The commented text was deleted</span>
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
              {comment.authorId === meId || canModerate ? (
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
