"use client";

import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import type * as Y from "yjs";
import {
  commentsClient,
  selectionToAnchor,
  anchorToAbsolute,
  type CommentThread,
} from "@/lib/comments";
import { authClient, type MarkieUser } from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";

const POLL_MS = 15000;
const BUBBLE_GAP = 30; // min vertical spacing between gutter bubbles

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface CommentLayerProps {
  editor: Editor;
  ydoc: Y.Doc;
  docId: string;
  readonly: boolean;
  // The scroll container of the View pane; the overlay scrolls with it
  container: HTMLDivElement | null;
}

export function CommentLayer({
  editor,
  ydoc,
  docId,
  readonly,
  container,
}: CommentLayerProps) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null);
  const [me, setMe] = useState<MarkieUser | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ from: number; to: number } | null>(null);
  const [pendingSel, setPendingSel] = useState<{ from: number; to: number } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useMemo(
    () => () => {
      commentsClient.list(docId).then((t) => {
        if (t) setThreads(t);
      });
    },
    [docId]
  );

  useEffect(() => {
    refresh();
    authClient.me().then(setMe);
    // Poll for new comments, but pause while the window is hidden so a doc
    // left open overnight doesn't hammer the API thousands of times.
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval === null) interval = setInterval(refresh, POLL_MS);
    };
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const onVis = () => {
      if (document.hidden) {
        stop();
      } else {
        refresh();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  // Re-measure anchor positions when the doc changes
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((x) => x + 1), 250);
    };
    editor.on("update", bump);
    return () => {
      clearTimeout(timer);
      editor.off("update", bump);
    };
  }, [editor]);

  // Non-empty selection offers the Comment affordance
  useEffect(() => {
    const onSel = () => {
      const { from, to, empty } = editor.state.selection;
      setPendingSel(empty || readonly ? null : { from, to });
    };
    editor.on("selectionUpdate", onSel);
    return () => {
      editor.off("selectionUpdate", onSel);
    };
  }, [editor, readonly]);

  const topFor = (pos: number): number | null => {
    if (!container) return null;
    try {
      const coords = editor.view.coordsAtPos(pos);
      const rect = container.getBoundingClientRect();
      return coords.top - rect.top + container.scrollTop;
    } catch {
      return null;
    }
  };

  // Open-thread bubbles, anchored and de-overlapped — tick re-measures
  void tick;
  const open = (threads ?? []).filter((t) => t.status === "open");
  const resolved = (threads ?? []).filter((t) => t.status === "resolved");
  const bubbles: Array<{ thread: CommentThread; top: number; from: number; to: number }> = [];
  for (const thread of open) {
    const abs = anchorToAbsolute(editor, ydoc, thread.anchor);
    if (!abs) continue; // anchored text was deleted
    const top = topFor(abs.from);
    if (top === null) continue;
    bubbles.push({ thread, top, ...abs });
  }
  bubbles.sort((a, b) => a.top - b.top);
  for (let i = 1; i < bubbles.length; i++) {
    if (bubbles[i].top - bubbles[i - 1].top < BUBBLE_GAP) {
      bubbles[i].top = bubbles[i - 1].top + BUBBLE_GAP;
    }
  }

  const selTop = pendingSel ? topFor(pendingSel.to) : null;
  const composerTop = composing ? topFor(composing.from) : null;
  const openBubble = bubbles.find((b) => b.thread.id === openThreadId);

  const startComposer = () => {
    if (!pendingSel) return;
    setComposing(pendingSel);
    setPendingSel(null);
    setOpenThreadId(null);
  };

  const submitThread = async (body: string) => {
    if (!composing) return;
    const anchor = selectionToAnchor(editor, composing.from, composing.to);
    setComposing(null);
    if (!anchor) return;
    await commentsClient.createThread(docId, anchor, body);
    refresh();
  };

  const jumpTo = (from: number, to: number) => {
    editor.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
  };

  return (
    <div className="absolute inset-y-0 right-0 w-0 z-20">
      {/* Resolved toggle */}
      {resolved.length > 0 && (
        <div className="absolute top-2 right-2">
          <button
            onClick={() => setShowResolved((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 border border-border text-muted hover:text-foreground"
            style={{ background: "var(--surface-2)" }}
          >
            {resolved.length} resolved {showResolved ? "▴" : "▾"}
          </button>
          {showResolved && (
            <div
              className="absolute right-0 mt-1.5 w-[280px] max-h-[50vh] overflow-y-auto rounded-lg border border-border shadow-xl p-2 flex flex-col gap-2"
              style={{ background: "var(--surface-2)" }}
            >
              {resolved.map((t) => (
                <ThreadCard
                  key={t.id}
                  thread={t}
                  me={me}
                  docId={docId}
                  readonly={readonly}
                  onChanged={refresh}
                  onClose={() => setShowResolved(false)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Comment affordance on selection */}
      {selTop !== null && !composing && (
        <button
          onClick={startComposer}
          className="absolute right-1.5 flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-border text-muted hover:text-foreground shadow-lg"
          style={{ top: selTop, background: "var(--surface-2)" }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Comment
        </button>
      )}

      {/* New-thread composer */}
      {composing && composerTop !== null && (
        <div className="absolute right-1.5 w-[260px]" style={{ top: composerTop }}>
          <Composer
            autoFocus
            placeholder="Comment…"
            onSubmit={submitThread}
            onCancel={() => setComposing(null)}
          />
        </div>
      )}

      {/* Gutter bubbles */}
      {bubbles.map((b) => (
        <button
          key={b.thread.id}
          onClick={() => {
            setOpenThreadId((cur) => (cur === b.thread.id ? null : b.thread.id));
            jumpTo(b.from, b.to);
          }}
          title={`${b.thread.comments[0]?.author_name}: ${b.thread.comments[0]?.body.slice(0, 60)}`}
          className="absolute right-1.5 w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-semibold text-black/80 shadow-md hover:scale-110 transition-transform"
          style={{
            top: b.top,
            background: colorForName(b.thread.comments[0]?.author_name ?? "?"),
          }}
          data-comment-thread={b.thread.id}
        >
          {b.thread.comments.length}
        </button>
      ))}

      {/* Open thread panel */}
      {openBubble && (
        <div
          className="absolute right-9 w-[280px] rounded-lg border border-border shadow-xl"
          style={{ top: openBubble.top, background: "var(--surface-2)" }}
        >
          <ThreadCard
            thread={openBubble.thread}
            me={me}
            docId={docId}
            readonly={readonly}
            onChanged={refresh}
            onClose={() => setOpenThreadId(null)}
          />
        </div>
      )}
    </div>
  );
}

function ThreadCard({
  thread,
  me,
  docId,
  readonly,
  onChanged,
  onClose,
}: {
  thread: CommentThread;
  me: MarkieUser | null;
  docId: string;
  readonly: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const toggleStatus = async () => {
    await commentsClient.setStatus(
      docId,
      thread.id,
      thread.status === "open" ? "resolved" : "open"
    );
    onChanged();
  };

  const submitReply = async (body: string) => {
    await commentsClient.reply(docId, thread.id, body);
    onChanged();
  };

  const remove = async (commentId: string) => {
    await commentsClient.deleteComment(docId, thread.id, commentId);
    onChanged();
  };

  return (
    <div className="p-2.5 flex flex-col gap-2" data-comment-panel={thread.id}>
      <div className="flex items-center justify-between">
        <span
          className={`text-[10px] uppercase tracking-wide ${
            thread.status === "resolved" ? "text-emerald-400" : "text-muted"
          }`}
        >
          {thread.status === "resolved" ? "Resolved" : "Open"}
        </span>
        <div className="flex items-center gap-2">
          {!readonly && (
            <button
              onClick={toggleStatus}
              className="text-[11px] text-muted hover:text-foreground"
            >
              {thread.status === "open" ? "Resolve" : "Reopen"}
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close thread"
            className="text-muted hover:text-foreground text-[13px]"
          >
            ×
          </button>
        </div>
      </div>

      {thread.comments.map((c) => (
        <div key={c.id} className="flex gap-2">
          <span
            className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-semibold text-black/80 shrink-0 mt-0.5"
            style={{ background: colorForName(c.author_name || c.author_email) }}
          >
            {initials(c.author_name || c.author_email)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-foreground truncate">
                {c.author_name || c.author_email}
              </span>
              <span className="text-[9px] text-muted shrink-0">
                {fmtTime(c.created_at)}
              </span>
            </div>
            <div className="text-[12px] text-foreground/90 whitespace-pre-wrap break-words">
              {c.body}
            </div>
          </div>
          {me?.id === c.author_id && (
            <button
              onClick={() => remove(c.id)}
              aria-label="Delete comment"
              className="text-muted hover:text-red-400 text-[11px] self-start"
            >
              ×
            </button>
          )}
        </div>
      ))}

      {!readonly && thread.status === "open" && (
        <Composer placeholder="Reply…" onSubmit={submitReply} />
      )}
    </div>
  );
}

function Composer({
  onSubmit,
  onCancel,
  placeholder,
  autoFocus = false,
}: {
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    onSubmit(body);
  };
  return (
    <div
      className="rounded-lg border border-border p-1.5 flex flex-col gap-1.5 shadow-xl"
      style={{ background: "var(--surface-2)" }}
    >
      <textarea
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            onCancel?.();
          }
        }}
        placeholder={placeholder}
        rows={2}
        className="text-[12px] bg-background border border-border rounded-md px-2 py-1.5 text-foreground outline-none resize-none focus:border-accent"
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-[11px] text-muted hover:text-foreground px-2"
          >
            Cancel
          </button>
        )}
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
