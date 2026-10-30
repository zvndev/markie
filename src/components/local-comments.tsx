// Comments on a local markdown file (super-nightly only; the page mounts this
// behind nightlyFeaturesEnabled()).
//
// Main keeps the threads (electron/local-comments.js); this draws them. Each
// thread is anchored by quoted markdown, re-found in the text as it stands now
// (src/lib/local-comments.ts), so the highlights follow edits made here, by an
// agent through MCP, or by another editor. A thread whose quote is gone is
// listed under Detached, never dropped.
//
// Looks like the cloud comment layer (src/components/comments.tsx): the same
// cards, avatars and composer. The difference is where threads live: a side
// panel listing every thread with its quote, because a local file has no
// shared document to pin bubbles to, and highlights painted in both panes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { getElectronAPI } from "@/lib/electron";
import { colorForName, initials } from "@/lib/collab";
import type { SourceHandle } from "@/lib/source-handle";
import { commentIdAt, type CommentTarget } from "@/lib/comment-target";
import { richCommentTarget } from "@/lib/rich-comments";
import {
  anchorFor,
  authorName,
  markdownToVisible,
  placeThreads,
  visibleToMarkdown,
  type LocalCommentThread,
  type LocalCommentsResult,
  type PlacedThread,
  type TextAnchor,
} from "@/lib/local-comments";

const SETTLE_MS = 200;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortQuote(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface LocalCommentsProps {
  path: string;
  /** The markdown in the editor now, which may be ahead of the file on disk. */
  content: string;
  mode: "edit" | "preview" | "split";
  richEditor: Editor | null;
  sourceHandle: SourceHandle | null;
  canComment: boolean;
}

export function LocalComments({ path, content, mode, richEditor, sourceHandle, canComment }: LocalCommentsProps) {
  const api = getElectronAPI()?.localComments ?? null;
  const [threads, setThreads] = useState<LocalCommentThread[]>([]);
  const [docKey, setDocKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [composing, setComposing] = useState<TextAnchor | null>(null);
  const [selection, setSelection] = useState<{ anchor: TextAnchor; top: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Settle the text before re-finding every quote, so typing stays cheap.
  const [settled, setSettled] = useState(content);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(content), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [content]);

  const apply = useCallback((res: LocalCommentsResult | null | undefined) => {
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setDocKey(res.path);
    setThreads(res.threads);
  }, []);

  const reload = useCallback(() => {
    if (!api) return;
    void api.list(path).then(apply).catch(() => {});
  }, [api, path, apply]);

  useEffect(() => {
    setThreads([]);
    setActiveId(null);
    setComposing(null);
    reload();
  }, [reload]);

  // An agent commented through MCP: main says which document, and an open
  // one shows it without a reload.
  useEffect(() => {
    if (!api) return;
    return api.onChanged((info) => {
      if (info && (info.path === docKey || info.path === path)) reload();
    });
  }, [api, docKey, path, reload]);

  const placed = useMemo(() => placeThreads(settled, threads), [settled, threads]);
  const open = placed.filter((p) => p.thread.status === "open");
  const anchored = open.filter((p) => p.range).sort((a, b) => a.range!.from - b.range!.from);
  const detached = open.filter((p) => !p.range);
  const resolved = placed.filter((p) => p.thread.status === "resolved");

  // The panes that are on screen, each with its own view of the text.
  const targets = useMemo(() => {
    const out: CommentTarget[] = [];
    if (mode !== "preview" && sourceHandle?.commentTarget) out.push(sourceHandle.commentTarget());
    if (mode !== "edit" && richEditor && !richEditor.isDestroyed) out.push(richCommentTarget(richEditor));
    return out;
  }, [mode, sourceHandle, richEditor]);

  // Paint every open, anchored thread in every pane on screen.
  useEffect(() => {
    for (const target of targets) {
      try {
        const paneText = target.kind === "rich" ? target.text() : null;
        target.mark(
          anchored.flatMap(({ thread, range }) => {
            const r =
              target.kind === "source" ? range : paneText !== null ? markdownToVisible(settled, range!, paneText) : null;
            return r ? [{ from: r.from, to: r.to, id: thread.id, active: thread.id === activeId }] : [];
          })
        );
      } catch {
        // a pane mid-teardown; the next render paints again
      }
    }
    // anchored is derived from placed; listing placed keeps the dependency honest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, placed, activeId, settled]);

  // Clear the paint when the panel goes away (gate off, document closed).
  useEffect(
    () => () => {
      for (const target of targets) {
        try {
          target.mark([]);
        } catch {
          /* destroyed */
        }
      }
    },
    [targets]
  );

  // Where the reader's selection is, as a markdown anchor, so "Comment" can
  // be offered beside it. The focused pane decides; in split view both hold a
  // selection and only one of them is the one being read.
  const readSelection = useCallback(() => {
    if (!canComment) return setSelection(null);
    const active = document.activeElement;
    const pane = active?.closest("[data-markie-source-pane]")
      ? "source"
      : active?.closest("[data-markie-rich-pane]")
        ? "rich"
        : null;
    const target = targets.find((t) => t.kind === pane);
    const sel = target?.selection();
    if (!target || !sel) return setSelection(null);
    const range = target.kind === "source" ? sel : visibleToMarkdown(content, target.text(), sel);
    const anchor = range ? anchorFor(content, range) : null;
    const dom = window.getSelection();
    const root = rootRef.current?.parentElement;
    if (!anchor || !dom || dom.rangeCount === 0 || !root) return setSelection(null);
    const rect = dom.getRangeAt(0).getBoundingClientRect();
    const box = root.getBoundingClientRect();
    setSelection({ anchor, top: Math.max(8, rect.bottom - box.top + 6) });
  }, [canComment, targets, content]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(readSelection, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [readSelection]);

  // A click on a highlighted passage opens its thread.
  useEffect(() => {
    const area = rootRef.current?.parentElement;
    if (!area) return;
    const onClick = (event: MouseEvent) => {
      const id = commentIdAt(event.target);
      if (!id) return;
      setActiveId(id);
      setPanelOpen(true);
    };
    area.addEventListener("click", onClick);
    return () => area.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (!activeId || !panelOpen) return;
    rootRef.current
      ?.querySelector(`[data-local-thread="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId, panelOpen]);

  const focusThread = (p: PlacedThread) => {
    setActiveId(p.thread.id);
    if (!p.range) return;
    for (const target of targets) {
      const r = target.kind === "source" ? p.range : markdownToVisible(settled, p.range, target.text());
      if (r) target.reveal(r);
    }
  };

  const startComposer = () => {
    if (!selection) return;
    setComposing(selection.anchor);
    setSelection(null);
    setPanelOpen(true);
    setActiveId(null);
  };

  const submitThread = async (body: string) => {
    if (!api || !composing) return;
    const anchor = composing;
    setComposing(null);
    apply(await api.add({ path, anchor, body }));
  };

  if (!api) return null;
  const total = open.length;

  return (
    <div ref={rootRef} data-local-comments className="contents">
      {selection && !composing && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={startComposer}
          className="absolute z-40 flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-border text-muted hover:text-foreground shadow-lg"
          style={{ top: selection.top, right: panelOpen ? 316 : 20, background: "var(--surface-2)" }}
          data-local-comment-start
        >
          <CommentIcon />
          Comment
        </button>
      )}

      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="absolute z-40 flex items-center gap-1 h-6 px-2 rounded-md border border-border text-[11px] text-muted hover:text-foreground"
          style={{ top: 40, right: 18, background: "color-mix(in srgb, var(--surface) 88%, transparent)" }}
          aria-label={total ? `Show ${total} comment${total === 1 ? "" : "s"}` : "Show comments"}
          data-local-comments-toggle
        >
          <CommentIcon />
          {total > 0 ? total : "Comments"}
        </button>
      )}

      {panelOpen && (
        <aside
          className="absolute top-0 right-0 bottom-0 z-40 w-[300px] border-l border-border flex flex-col shadow-xl"
          style={{ background: "var(--surface-2)" }}
          aria-label="Comments"
          data-local-comments-panel
        >
          <header className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[12px] font-medium text-foreground">
              Comments{total > 0 ? ` (${total})` : ""}
            </span>
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false);
                setActiveId(null);
              }}
              aria-label="Close comments"
              className="text-muted hover:text-foreground text-[13px]"
            >
              ×
            </button>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
            {error && (
              <p role="alert" className="text-[11px] text-[var(--status-red)] px-1">
                {error}
              </p>
            )}

            {composing && (
              <div className="rounded-lg border border-border p-2 flex flex-col gap-2" data-local-comment-composer>
                <Quote text={composing.exact} />
                <Composer
                  autoFocus
                  placeholder="Comment…"
                  onSubmit={submitThread}
                  onCancel={() => setComposing(null)}
                />
              </div>
            )}

            {!composing && total === 0 && resolved.length === 0 && (
              <p className="text-[12px] text-muted px-1 py-2">
                Select text and choose Comment. Agents can comment here too, through Markie&apos;s MCP tools.
              </p>
            )}

            {anchored.map((p) => (
              <ThreadCard
                key={p.thread.id}
                placed={p}
                path={path}
                active={p.thread.id === activeId}
                canComment={canComment}
                onFocus={() => focusThread(p)}
                onResult={apply}
              />
            ))}

            {detached.length > 0 && (
              <section className="flex flex-col gap-2 mt-1" data-local-comments-detached>
                <h3 className="text-[10px] uppercase tracking-wide text-muted px-1">Detached</h3>
                <p className="text-[11px] text-muted px-1 -mt-1">
                  The text these were on has changed or been removed.
                </p>
                {detached.map((p) => (
                  <ThreadCard
                    key={p.thread.id}
                    placed={p}
                    path={path}
                    active={p.thread.id === activeId}
                    canComment={canComment}
                    onFocus={() => setActiveId(p.thread.id)}
                    onResult={apply}
                  />
                ))}
              </section>
            )}

            {resolved.length > 0 && (
              <section className="flex flex-col gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setShowResolved((v) => !v)}
                  className="self-start text-[11px] px-2 py-0.5 rounded-full border border-border text-muted hover:text-foreground"
                >
                  {resolved.length} resolved {showResolved ? "▴" : "▾"}
                </button>
                {showResolved &&
                  resolved.map((p) => (
                    <ThreadCard
                      key={p.thread.id}
                      placed={p}
                      path={path}
                      active={p.thread.id === activeId}
                      canComment={canComment}
                      onFocus={() => focusThread(p)}
                      onResult={apply}
                    />
                  ))}
              </section>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function CommentIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="m-0 border-l-2 pl-2 text-[11px] italic text-muted break-words" style={{ borderColor: "rgba(96, 165, 250, 0.7)" }}>
      {shortQuote(text)}
    </blockquote>
  );
}

function ThreadCard({
  placed,
  path,
  active,
  canComment,
  onFocus,
  onResult,
}: {
  placed: PlacedThread;
  path: string;
  active: boolean;
  canComment: boolean;
  onFocus: () => void;
  onResult: (res: LocalCommentsResult) => void;
}) {
  const api = getElectronAPI()?.localComments;
  const { thread } = placed;
  if (!api) return null;

  const toggleStatus = async () => {
    onResult(await api.setStatus({ path, threadId: thread.id, status: thread.status === "open" ? "resolved" : "open" }));
  };
  const submitReply = async (body: string) => {
    onResult(await api.reply({ path, threadId: thread.id, body }));
  };
  const remove = async (commentId: string) => {
    onResult(await api.remove({ path, threadId: thread.id, commentId }));
  };

  return (
    <div
      className={`rounded-lg border p-2.5 flex flex-col gap-2 ${active ? "border-accent" : "border-border"}`}
      style={{ background: "var(--surface)" }}
      data-local-thread={thread.id}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onFocus} className="text-left flex-1 min-w-0" title={placed.range ? "Show in document" : undefined}>
          <Quote text={thread.anchor.exact} />
        </button>
        {canComment && (
          <button type="button" onClick={toggleStatus} className="text-[11px] text-muted hover:text-foreground shrink-0">
            {thread.status === "open" ? "Resolve" : "Reopen"}
          </button>
        )}
      </div>

      {thread.comments.map((c) => {
        const name = authorName(c.author);
        return (
          <div key={c.id} className="flex gap-2">
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-semibold text-black/80 shrink-0 mt-0.5"
              style={{ background: colorForName(name) }}
            >
              {initials(name)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium text-foreground truncate">{name}</span>
                <span className="text-[9px] text-muted shrink-0">{fmtTime(c.createdAt)}</span>
              </div>
              <div className="text-[12px] text-foreground/90 whitespace-pre-wrap break-words">{c.body}</div>
            </div>
            {canComment && c.author?.kind === "user" && (
              <button
                type="button"
                onClick={() => remove(c.id)}
                aria-label="Delete comment"
                className="text-muted hover:text-[var(--status-red)] text-[11px] self-start"
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {thread.status === "resolved" && thread.resolvedBy && (
        <p className="text-[10px] text-[var(--status-green)]">Resolved by {authorName(thread.resolvedBy)}</p>
      )}

      {canComment && thread.status === "open" && <Composer placeholder="Reply…" onSubmit={submitReply} />}
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
    <div className="flex flex-col gap-1.5">
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
          <button type="button" onClick={onCancel} className="text-[11px] text-muted hover:text-foreground px-2">
            Cancel
          </button>
        )}
        <button
          type="button"
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
