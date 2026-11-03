// Writing on the phone, with the desktop's own editors.
//
// Markdown opens in the desktop's rich view (src/components/rich-view.tsx),
// with Source one tap away and a formatting row above the keyboard that runs
// the desktop format rail's commands. Everything else is edited as its text.
//
// A document nobody else is on is saved through the same versioned route the
// desktop's sync uses: a save that started from an old version is refused,
// never merged over. A document someone else is on is edited live in the
// desktop's room for it (the same websocket, the same short-lived pass), with
// the others' carets and names, and its comments. Its text is written back as
// the stored version under the shared policy the web app follows
// (src/lib/live-snapshot.ts): from a ready room only, by the room's one
// writer, never over a stored copy the room cannot carry, and never over a
// version written from outside the room.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";
import { RichView, type FlushRich, type LiveSession } from "@/components/rich-view";
import { TextCollabEditor } from "@/components/text-collab-editor";
import type { PeerUser } from "@/lib/collab";
import { ApiError, type ApiClient } from "../lib/api";
import type { DocFormat } from "../lib/docs";
import { haptics } from "../lib/native";
import { useKeyboardInset } from "../lib/keyboard-inset";
import { applyMarkdownAction, type MarkdownAction } from "../lib/markdown-edits";
import { displayName } from "../lib/recent";
import { liveConfig, liveKind, saveLiveSnapshot, shouldGoLive } from "../lib/live";
import {
  RoomTexts, SNAPSHOT_REFUSAL_NOTE, liveSnapshotRefusal, liveSnapshotWait, useLiveRoom,
  type LiveRoom, type LiveSnapshotWait,
} from "@/lib/live-snapshot";
import { Screen } from "../components/screen";
import { AlertIcon, CommentIcon } from "../components/icons";
import { Presence, type LiveStatus } from "../components/presence";
import { RichToolbar, ToolButton } from "../components/rich-toolbar";
import { CommentsSheet, useThreads, type CommentDraft } from "../components/comments-sheet";
import { Sheet } from "../components/sheet";

/** What the editor opens: a version of a cloud document, or text that isn't in the cloud yet. */
export type EditorDraft =
  | { kind: "cloud"; id: string; name: string; format: DocFormat; content: string; version: number; role?: string | null; openComments?: boolean }
  | { kind: "new"; name: string; format: DocFormat; content: string };

export interface EditorUser {
  id: string;
  name: string;
  email: string;
}

interface EditorProps {
  api: ApiClient;
  draft: EditorDraft;
  me: EditorUser;
  /** reload: the document changed elsewhere, so the screen underneath should read it again. */
  onCancel: (reload?: boolean) => void;
  /** The saved document's id. A new document has just been created under it. */
  onSaved: (saved: { id: string; name: string; created: boolean }) => void;
  onUnauthorized: () => void;
  /** Android's back button asks the editor first, so unsaved text isn't dropped. */
  backGuard: MutableRefObject<(() => void) | null>;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "conflict" }
  | { status: "error"; message: string };

/** solo: saved by hand. live: a room with others in it. checking: asking who else is on it. */
type Session = { mode: "checking" } | { mode: "solo" } | { mode: "live"; owner: boolean };

const MARKDOWN_ACTIONS: { action: MarkdownAction; label: string; text: string }[] = [
  { action: "heading", label: "Heading", text: "H" },
  { action: "bold", label: "Bold", text: "B" },
  { action: "italic", label: "Italic", text: "I" },
  { action: "list", label: "Bulleted list", text: "•" },
  { action: "task", label: "Checklist", text: "☐" },
  { action: "link", label: "Link", text: "Link" },
  { action: "code", label: "Code", text: "</>" },
];

// How long a live document waits after the last change before writing its
// text back as the stored version.
const LIVE_SAVE_DELAY_MS = 3_000;

export function EditorScreen({ api, draft, me, onCancel, onSaved, onUnauthorized, backGuard }: EditorProps) {
  const [value, setValue] = useState(draft.content);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [view, setView] = useState<"rich" | "source">("rich");
  const box = useRef<HTMLTextAreaElement>(null);
  const keyboard = useKeyboardInset();
  const isNew = draft.kind === "new";
  // What the server says this account may do, read from /access as the
  // screen opens. The list's role is only the fallback while that answer is
  // on its way or if it never comes.
  const [accessRole, setAccessRole] = useState<string | null>(null);
  const readOnly = draft.kind === "cloud" && (accessRole ?? draft.role) === "viewer";
  const markdown = draft.format === "markdown" && /\.(md|markdown|mdx)$/i.test(draft.name);
  const prose = markdown || (draft.format === "text" && /\.(txt|text)$/i.test(draft.name));
  const kind = liveKind(draft.name, draft.format);

  // Who else is on it decides solo or live, exactly as on the desktop.
  const [session, setSession] = useState<Session>(() => (draft.kind === "cloud" && kind ? { mode: "checking" } : { mode: "solo" }));
  useEffect(() => {
    if (draft.kind !== "cloud") return;
    let live = true;
    if (!kind) {
      void api.access(draft.id).then((access) => { if (live && access) setAccessRole(access.role); }, () => {});
      return () => { live = false; };
    }
    void (async () => {
      try {
        const [access, members] = await Promise.all([api.access(draft.id).catch(() => null), api.shares(draft.id)]);
        if (!live) return;
        if (access) setAccessRole(access.role);
        setSession(shouldGoLive(members, kind, draft.content.length) ? { mode: "live", owner: access?.role === "owner" } : { mode: "solo" });
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
        // Not knowing is not a reason to write over a room: edit the stored
        // version alone, which the server version-checks anyway.
        setSession({ mode: "solo" });
      }
    })();
    return () => { live = false; };
    // The draft is fixed for this screen's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isLive = session.mode === "live";

  // ── Live session ────────────────────────────────────────────────────────
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  // The text pane's session, for the same policy (it has no comments).
  const [textSession, setTextSession] = useState<LiveRoom | null>(null);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const flushRef = useRef<FlushRich | null>(null);
  const collab = useMemo(() => {
    if (!isLive || draft.kind !== "cloud") return null;
    return liveConfig({
      origin: api.origin,
      docId: draft.id,
      displayName: me.name || me.email,
      readonly: readOnly,
      fetchTicket: () => api.collabTicket(draft.id),
    });
  }, [isLive, api, draft, me.name, me.email, readOnly]);
  // No pass, or no runtime: there is no room, so the phone edits alone, as
  // the desktop does (src/app/page.tsx handleCollabStatus). Nothing typed
  // into a session that never joined is written anywhere.
  const onStatus = useCallback((next: LiveStatus) => {
    if (next === "unavailable") {
      setLiveUnavailable(true);
      setSession({ mode: "solo" });
      return;
    }
    setStatus(next);
  }, []);
  const onFlushReady = useCallback((flush: FlushRich | null) => { flushRef.current = flush; }, []);

  // The stored version the live text is written over, and what it last said.
  const version = useRef(draft.kind === "cloud" ? draft.version : 0);
  const stored = useRef(draft.content);
  const [liveSave, setLiveSave] = useState<"saved" | "pending" | "saving" | "error" | "conflict">("saved");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The shared policy (src/lib/live-snapshot.ts): whether this room is
  // ready, whether this phone is its writer, and whether the room can carry
  // the stored copy at all (read once, from the copy the session opened on).
  const room = useLiveRoom(isLive ? (kind === "text" ? textSession : (liveSession as unknown as LiveRoom | null)) : null, kind ?? "rich", {
    documentEmpty: !draft.content.trim(),
    offer: isLive && !readOnly,
  });
  const refusal = useMemo(() => (isLive && kind ? liveSnapshotRefusal(stored.current, kind) : null), [isLive, kind]);
  const wait: LiveSnapshotWait | null = isLive && status !== "empty" ? liveSnapshotWait(room, { editable: !readOnly, refusal }) : "read-only";
  const waitRef = useRef(wait);
  waitRef.current = wait;
  // Every text this phone has held from the ready room, for the 409 rule.
  const roomTexts = useRef<RoomTexts | null>(null);
  if (!roomTexts.current) { roomTexts.current = new RoomTexts(); roomTexts.current.add(draft.content); }
  const roomReady = room.ready;
  const onLiveText = useCallback((text: string) => {
    if (roomReady) roomTexts.current?.add(text);
    setValue(text);
  }, [roomReady]);

  const writeLive = useCallback(async (text: string) => {
    // Callers only write when the policy says this phone may; checked again
    // here because the room can change between the timer and the write.
    if (draft.kind !== "cloud" || waitRef.current) return true;
    if (text === stored.current) { setLiveSave("saved"); return true; }
    setLiveSave("saving");
    try {
      const result = await saveLiveSnapshot(api, { id: draft.id, name: draft.name, content: text, version: version.current, room: roomTexts.current! });
      if (result.kind === "conflict") { setLiveSave("conflict"); return false; }
      version.current = result.version;
      stored.current = text;
      setLiveSave("saved");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return false; }
      setLiveSave("error");
      return false;
    }
  }, [api, draft, onUnauthorized]);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Debounced, and only while this phone may write: a peer's keystroke here
  // is a room change like any other, and only the writer pushes it.
  useEffect(() => {
    if (wait || liveSave === "conflict") return;
    if (value === stored.current) return;
    setLiveSave("pending");
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => { liveTimer.current = null; void writeLive(valueRef.current); }, LIVE_SAVE_DELAY_MS);
    return () => { if (liveTimer.current) clearTimeout(liveTimer.current); };
  }, [wait, liveSave, value, writeLive]);

  const [closing, setClosing] = useState(false);
  const done = useCallback(async () => {
    if (closing) return;
    setClosing(true);
    if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
    const text = flushRef.current?.() ?? valueRef.current;
    // Offline: what was typed since the connection dropped is only on this
    // phone, and closing drops it.
    if (!readOnly && isLive && !room.connected && text !== stored.current
      && !window.confirm("You're offline, so your latest edits haven't reached the live session. Close anyway and lose them?")) {
      setClosing(false);
      return;
    }
    // Only the room's writer writes the stored copy, and never over what the
    // room cannot carry; everyone else's edits are in the room already.
    if (!wait && text !== stored.current && draft.kind === "cloud") {
      const ok = await writeLive(text);
      if (!ok && !window.confirm("Your latest changes are in the live session, but the stored copy couldn't be updated. Close anyway? The next editor to open it saves them.")) {
        setClosing(false);
        return;
      }
      haptics.success();
      onSaved({ id: draft.id, name: draft.name, created: false });
      return;
    }
    onCancel(true);
  }, [closing, readOnly, isLive, room.connected, wait, draft, writeLive, onSaved, onCancel]);

  // ── Comments (live markdown only, as on the desktop) ────────────────────
  const commentable = isLive && kind === "rich" && draft.kind === "cloud";
  const { threads, error: threadsError, refresh: refreshThreads } = useThreads(api, draft.kind === "cloud" ? draft.id : "", commentable, onUnauthorized);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const openedComments = useRef(false);
  useEffect(() => {
    if (openedComments.current || !commentable || draft.kind !== "cloud" || !draft.openComments || !liveSession) return;
    openedComments.current = true;
    setCommentsOpen(true);
  }, [commentable, draft, liveSession]);
  const startComment = useCallback(() => {
    if (!editor) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    setCommentDraft({ from, to, quote: editor.state.doc.textBetween(from, to, " ").slice(0, 280) });
    setCommentsOpen(true);
  }, [editor]);
  const openThreads = (threads ?? []).filter((thread) => thread.status === "open").length;

  // ── Solo saving ─────────────────────────────────────────────────────────
  const dirty = value !== draft.content;
  const cancel = useCallback(() => {
    if (isLive) { void done(); return; }
    if (save.status === "saving") return;
    if (dirty && !window.confirm(isNew ? "Discard this document? It hasn't been saved." : "Discard your changes? They haven't been saved.")) return;
    onCancel();
  }, [isLive, done, dirty, isNew, onCancel, save.status]);

  useEffect(() => {
    backGuard.current = cancel;
    return () => { if (backGuard.current === cancel) backGuard.current = null; };
  }, [backGuard, cancel]);

  // A new document starts with the caret in it; an existing one opens to read first.
  useEffect(() => {
    if (!isNew || markdown) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isNew, markdown]);

  const write = useCallback(async (asCopy: boolean) => {
    const text = flushRef.current?.() ?? value;
    setSave({ status: "saving" });
    try {
      if (draft.kind === "cloud" && !asCopy) {
        // version.current: a live session this screen wrote before it dropped
        // to solo has moved the stored version on.
        const saved = await api.saveDoc({ id: draft.id, name: draft.name, content: text, baseVersion: version.current });
        haptics.success();
        onSaved({ id: saved.id, name: draft.name, created: false });
        return;
      }
      const name = asCopy ? copyName(draft.name) : draft.name;
      const created = await api.createDoc({ name, content: text });
      haptics.success();
      onSaved({ id: created.id, name, created: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      if (error instanceof ApiError && error.status === 409 && error.code === "conflict") { setSave({ status: "conflict" }); return; }
      setSave({ status: "error", message: error instanceof Error ? error.message : "Couldn't save. Try again." });
    }
  }, [api, draft, onSaved, onUnauthorized, value]);

  const formatSource = useCallback((action: MarkdownAction) => {
    const el = box.current;
    if (!el) return;
    haptics.selection();
    const next = applyMarkdownAction({ value, start: el.selectionStart, end: el.selectionEnd }, action);
    setValue(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  }, [value]);

  // ── Links in the rich editor ────────────────────────────────────────────
  const [linkSheet, setLinkSheet] = useState<{ href: string; text: string } | null>(null);
  const openLink = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) { editor.chain().focus().unsetLink().run(); return; }
    const { from, to } = editor.state.selection;
    const attrs = editor.getAttributes("link");
    setLinkSheet({ href: typeof attrs.href === "string" ? attrs.href : "", text: editor.state.doc.textBetween(from, to, " ") });
  }, [editor]);
  const applyLink = (href: string, text: string) => {
    setLinkSheet(null);
    if (!editor || !href.trim()) return;
    const url = href.trim();
    const chain = editor.chain().focus();
    if (text.trim()) chain.insertContent({ type: "text", text: text.trim(), marks: [{ type: "link", attrs: { href: url, target: null, rel: null } }] }).run();
    else chain.setLink({ href: url }).run();
  };

  // Taps on links while writing place the caret; they never leave the app.
  const swallowLinkTaps = (event: ReactMouseEvent) => {
    if ((event.target as HTMLElement | null)?.closest?.("a")) { event.preventDefault(); event.stopPropagation(); }
  };

  const saving = save.status === "saving";
  const canSave = !saving && (isNew || dirty);
  const title = displayName(draft.name);
  const richShown = markdown && view === "rich";
  const liveText = isLive && kind === "text" && collab;

  const leading = isLive || readOnly
    ? <button type="button" className="m-nav-text m-nav-text-strong" onClick={() => void done()} disabled={closing}>{closing ? "Saving" : "Done"}</button>
    : <button type="button" className="m-nav-text" onClick={cancel} disabled={saving}>Cancel</button>;
  const actions = isLive ? (
    <>
      <Presence peers={peers} status={status} />
      {commentable ? (
        <button type="button" className="m-nav-icon m-nav-badged" aria-label={openThreads ? `Comments, ${openThreads} open` : "Comments"} onClick={() => { setCommentDraft(null); setCommentsOpen(true); }}>
          <CommentIcon size={22} />
          {openThreads ? <span className="m-nav-badge" aria-hidden="true">{openThreads}</span> : null}
        </button>
      ) : null}
    </>
  ) : readOnly ? null : (
    <button type="button" className="m-nav-text m-nav-text-strong" onClick={() => void write(false)} disabled={!canSave || session.mode === "checking"}>
      {saving ? <span className="m-spinner m-spinner-small" aria-hidden="true" /> : null}
      {saving ? "Saving" : isNew ? "Create" : "Save"}
    </button>
  );

  return (
    <Screen title={title} leading={leading} actions={actions} fill className="m-editor-screen">
      <div className="m-editor" style={{ paddingBottom: keyboard }}>
        {save.status === "conflict" ? (
          <div className="m-editor-banner" role="alert">
            <AlertIcon size={18} />
            <div>
              <strong>Someone saved this document while you were editing.</strong>
              <p>Your text is still here. Keep it as a separate copy, or throw it away and read the newer version.</p>
              <div className="m-editor-banner-actions">
                <button type="button" className="m-button m-button-small m-button-primary" onClick={() => void write(true)}>Save as a copy</button>
                <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => onCancel(true)}>Discard mine</button>
              </div>
            </div>
          </div>
        ) : null}
        {save.status === "error" ? <p className="m-editor-error" role="alert">{save.message}</p> : null}
        {liveSave === "conflict" ? (
          <div className="m-editor-banner" role="alert" data-live-conflict>
            <AlertIcon size={18} />
            <div>
              <strong>Someone saved this document outside the live session.</strong>
              <p>An agent or another device wrote a newer version. The live edits are still here and weren't saved over it.</p>
              <div className="m-editor-banner-actions">
                <button type="button" className="m-button m-button-small m-button-primary" onClick={() => void write(true)}>Save as a copy</button>
                <button type="button" className="m-button m-button-small m-button-secondary" onClick={() => onCancel(true)}>Read the newer version</button>
              </div>
            </div>
          </div>
        ) : null}
        {liveUnavailable && !isLive ? <p className="m-editor-note" role="note">The live session couldn't start, so you're editing your copy alone. Save when you're done.</p> : null}
        {isLive ? <LiveLine status={status} save={liveSave} readOnly={readOnly} wait={wait} /> : null}
        {markdown ? (
          <div className="m-segmented m-editor-views" role="tablist" aria-label="Editor view">
            {(["rich", "source"] as const).map((mode) => (
              <button key={mode} type="button" role="tab" aria-selected={view === mode} className={view === mode ? "is-selected" : ""}
                onClick={() => {
                  if (view === mode) return;
                  haptics.selection();
                  // Settle the rich view's pending edit before the text is shown as source.
                  if (mode === "source") { const flushed = flushRef.current?.(); if (flushed != null) setValue(flushed); }
                  setView(mode);
                }}>
                {mode === "rich" ? "Rich" : "Source"}
              </button>
            ))}
          </div>
        ) : null}

        {session.mode === "checking" ? (
          <div className="m-editor-wait" role="status"><span className="m-spinner" aria-hidden="true" />Opening…</div>
        ) : richShown ? (
          <div className="m-rich-host" onClickCapture={swallowLinkTaps}>
            <RichView
              key={collab ? `live:${collab.docId}` : "solo"}
              value={value}
              onChange={isLive ? onLiveText : setValue}
              onEditorReady={setEditor}
              collab={collab}
              readOnly={readOnly}
              canModerate={session.mode === "live" && session.owner}
              onPeersChange={setPeers}
              onCollabStatus={onStatus}
              onFlushReady={onFlushReady}
              showCommentLayer={false}
              onLiveSession={setLiveSession}
              holdUntilReady
            />
          </div>
        ) : liveText ? (
          <div className="m-text-live">
            <TextCollabEditor
              key={`live-text:${collab.docId}`}
              value={value}
              onChange={onLiveText}
              collab={collab}
              readOnly={readOnly}
              onPeersChange={setPeers}
              onCollabStatus={onStatus}
              onLiveSession={setTextSession}
            />
          </div>
        ) : (
          <>
            {markdown && isLive ? (
              <p className="m-editor-note" role="note">Others are editing live, so Source is read-only. Switch to Rich to edit with them.</p>
            ) : null}
            <textarea
              ref={box}
              className={`m-editor-text${prose ? "" : " is-code"}`}
              value={value}
              onChange={(event) => { setValue(event.target.value); if (save.status === "error") setSave({ status: "idle" }); }}
              aria-label={`Text of ${title}`}
              spellCheck={prose}
              autoCorrect={prose ? "on" : "off"}
              autoCapitalize={prose ? "sentences" : "none"}
              readOnly={saving || readOnly || isLive}
            />
          </>
        )}

        {richShown && editor && session.mode !== "checking" && (!readOnly || commentable) ? (
          <RichToolbar editor={editor} locked={readOnly} onLink={openLink} onComment={commentable ? startComment : undefined} />
        ) : null}
        {markdown && view === "source" && !isLive && !readOnly && session.mode !== "checking" ? (
          <div className="m-keyboard-bar" role="toolbar" aria-label="Formatting">
            {MARKDOWN_ACTIONS.map((item) => (
              <ToolButton key={item.action} label={item.label} className={`m-editor-tool-${item.action}`} onClick={() => formatSource(item.action)}>
                {item.text}
              </ToolButton>
            ))}
          </div>
        ) : null}
      </div>

      {commentsOpen && draft.kind === "cloud" ? (
        <CommentsSheet
          api={api}
          docId={draft.id}
          editor={editor}
          live={liveSession}
          threads={threads}
          error={threadsError}
          refresh={refreshThreads}
          meId={me.id}
          canResolve={!readOnly}
          canModerate={session.mode === "live" && session.owner}
          canComment
          draft={commentDraft}
          onDraftDone={() => setCommentDraft(null)}
          onClose={() => { setCommentsOpen(false); setCommentDraft(null); }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {linkSheet ? <LinkSheet initial={linkSheet} onApply={applyLink} onClose={() => setLinkSheet(null)} /> : null}
    </Screen>
  );
}

function LiveLine({ status, save, readOnly, wait }: { status: LiveStatus; save: "saved" | "pending" | "saving" | "error" | "conflict"; readOnly: boolean; wait: LiveSnapshotWait | null }) {
  const text = status === "empty"
    ? "Nobody has opened this live yet, so there is nothing to show here. Read it on the document screen."
    : status === "unavailable"
      ? "The live session isn't available right now. Close and reopen to try again."
      : status === "disconnected"
        ? "Offline. Your edits wait here and go out when the connection is back."
        : status === "connecting"
          ? "Joining the live session…"
          : readOnly
            ? "Live. You can read and comment."
            : wait === "held-constructs"
              ? SNAPSHOT_REFUSAL_NOTE
            : wait === "not-synced" || wait === "not-ready"
              ? "Joining the live session…"
            : wait === "not-writer"
              ? "Live. Another editor here keeps the stored copy up to date."
            : save === "conflict"
              ? "Live. Not saved: someone saved a newer version outside the session."
            : save === "error"
              ? "Live. The stored copy couldn't be updated; it retries on your next edit."
              : save === "saved"
                ? "Live. Everyone's changes are saved."
                : "Live. Saving…";
  return <p className={`m-live-line is-${status}`} role="status">{text}</p>;
}

function LinkSheet({ initial, onApply, onClose }: { initial: { href: string; text: string }; onApply: (href: string, text: string) => void; onClose: () => void }) {
  const [href, setHref] = useState(initial.href);
  const [text, setText] = useState(initial.text);
  return (
    <Sheet title="Link" onClose={onClose}>
      <form className="m-link-form" onSubmit={(event) => { event.preventDefault(); onApply(href, text); }}>
        <label className="m-field">
          <span className="m-field-label">Address</span>
          <input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://" value={href} onChange={(event) => setHref(event.target.value)} autoFocus />
        </label>
        <label className="m-field">
          <span className="m-field-label">Text</span>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Shown in the document" />
        </label>
        <button type="submit" className="m-button m-button-primary" disabled={!href.trim()}>Add link</button>
      </form>
    </Sheet>
  );
}

/** "Plan.md" becomes "Plan (copy).md". */
export function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (copy)${name.slice(dot)}` : `${name} (copy)`;
}
