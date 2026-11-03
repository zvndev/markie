// One cloud document, open in the desktop's own editors: Rich view and
// Source for Markdown (TipTap and CodeMirror, live through the collab room
// with comments when the document is shared), the source pane for plain text
// and data files (live through Y.Text), the sandboxed Darkmown preview, and
// the Word engine for Word, RTF and OpenDocument.
//
// Saving is versioned. A save names the version the edits started from, and
// the server refuses it when someone else saved first. On a document nobody
// else is editing live that refusal stops autosave and asks what to do; it is
// never merged over. In a live session the stored copy is written from the
// room by one client, under the shared policy in src/lib/live-snapshot.ts.
import "@/components/documents/document-workspace.css";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { collabWsBase, getAuthToken, getServerURL, sharesClient } from "@/lib/auth-client";
import { colorForName, initials, type CollabConfig, type PeerUser } from "@/lib/collab";
import { appearanceKey, appearanceVars, DEFAULT_APPEARANCE, normalizeAppearance, type DocAppearance } from "@/lib/doc-appearance";
import { createDocumentSession, editDocumentText, type DocumentSession } from "@/lib/document-session";
import { decodeTextDocument, encodeTextDocument, type DecodedTextDocument } from "@/lib/document-formats";
import { exportRichDocument, openRichDocument, type RichDocument } from "@/lib/office/rich-document";
import { useRichSafety } from "@/lib/use-rich-safety";
import { DocToolbar } from "@/components/doc-toolbar";
import { RichView, type LiveSession } from "@/components/rich-view";
import { RichLossBanner, RichPreparingNote } from "@/components/rich-guard";
import { RichSectionRail } from "@/components/section-rail";
import { SourceEditor } from "@/components/source-editor";
import { TextCollabEditor } from "@/components/text-collab-editor";
import { ShareDialog } from "@/components/share-dialog";
import { LiveSourceBanner, LiveUnavailableNote } from "@/components/share-banner";
import { ErrorBoundary } from "@/components/error-boundary";
import { DarkmownDocumentEditor } from "@/components/documents/darkmown-document-editor";
import {
  CloudConflictError, SessionEndedError, deletePlatformDoc, deleteTextDoc, editorKindFor,
  openPlatformDoc, openTextDoc, renamedDocName, savePlatformDoc, saveTextDoc, type CloudRole, type CloudStore, type EditorKind,
} from "./cloud";
import { PlatformShareDialog, PlatformHistoryDialog } from "./platform-dialogs";
import { CopyAllButton } from "@/components/copy-all-button";
import { HideBarButton } from "./bar-controls";
import { memberAssetUrl, viewHtml } from "./view-content";
import { WebExportMenu } from "./web-export";
import type { WebSessionUser } from "./session";
import {
  DIVERGED_NOTE, RoomTexts, SNAPSHOT_REFUSAL_NOTE, liveSnapshotRefusal, liveSnapshotWait, roomMatchesStored, useLiveRoom, writeLiveSnapshot,
  type LiveBase, type LiveRoom, type LiveRoomState, type SnapshotRefusal,
} from "@/lib/live-snapshot";

const WordDocumentEditor = lazy(() => import("@/components/documents/word-document-editor").then((m) => ({ default: m.WordDocumentEditor })));

const AUTOSAVE_MS = 1500;

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error" | "signed-out";

export interface OpenDoc {
  store: CloudStore;
  id: string;
  name: string;
  version: number;
  role: CloudRole;
  kind: EditorKind;
  /** Text formats: the document's text. */
  text: string;
  /** Platform text formats: how the bytes were encoded, kept on save. */
  textMetadata: DecodedTextDocument | null;
  /** Word, RTF and OpenDocument. */
  office: RichDocument | null;
}

/** One cloud document from either store, or null when this account has no such id. The editor and the read view both open with it. */
export async function loadDoc(id: string): Promise<OpenDoc | null> {
  const text = await openTextDoc(id);
  if (text) return { store: "docs", id, name: text.name, version: text.version, role: text.role, kind: editorKindFor(text.name), text: text.content, textMetadata: null, office: null };
  const platform = await openPlatformDoc(id);
  if (!platform) return null;
  const kind = editorKindFor(platform.name);
  if (kind === "office") {
    const format = platform.name.toLowerCase().endsWith(".rtf") ? "rtf" : platform.name.toLowerCase().endsWith(".odt") ? "odt" : "docx";
    const office = await openRichDocument(format, platform.bytes);
    return { store: "platform", id, name: platform.name, version: platform.version, role: platform.role, kind, text: office.text, textMetadata: null, office };
  }
  if (kind === "unsupported") return { store: "platform", id, name: platform.name, version: platform.version, role: platform.role, kind, text: "", textMetadata: null, office: null };
  const metadata = decodeTextDocument(platform.bytes);
  return { store: "platform", id, name: platform.name, version: platform.version, role: platform.role, kind, text: metadata.text, textMetadata: metadata, office: null };
}

export interface WebDocumentProps {
  id: string;
  user: WebSessionUser;
  onLibrary: () => void;
  onOpen: (id: string) => void;
  onSessionEnded: () => void;
  /** The document's name and role, for the window title and the header. */
  onTitle?: (name: string | null) => void;
  /** Back to the read view of this document (doc-view.tsx). */
  onView?: () => void;
  /** The bar is put away (bar-visibility.ts): the document bar is not drawn. */
  barHidden?: boolean;
  onHideBar?: () => void;
}

export function WebDocument({ id, user, onLibrary, onOpen, onSessionEnded, onTitle, onView, barHidden = false, onHideBar }: WebDocumentProps) {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setDoc(null);
    setLoadError(null);
    loadDoc(id).then(
      (loaded) => {
        if (!live) return;
        if (!loaded) setLoadError("This document was deleted, or it hasn't been shared with this account.");
        else setDoc(loaded);
      },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof SessionEndedError) onSessionEnded();
        else setLoadError(error instanceof Error ? error.message : "Couldn't open this document.");
      },
    );
    return () => { live = false; };
  }, [id, reload, onSessionEnded]);

  useEffect(() => { onTitle?.(doc?.name ?? null); }, [doc?.name, onTitle]);

  if (loadError) {
    return <div role="alert" className="mx-auto mt-16 max-w-md rounded-xl border border-border bg-surface px-5 py-4 text-sm">
      <p className="font-medium text-foreground">Couldn&apos;t open this document</p>
      <p className="mt-1 text-muted">{loadError}</p>
      <div className="mt-3 flex gap-2">
        <button type="button" className="markie-toolbar-action rounded-md border border-border px-3 py-1.5 text-[12px]" onClick={() => setReload((n) => n + 1)}>Try again</button>
        <button type="button" className="markie-toolbar-action rounded-md border border-border px-3 py-1.5 text-[12px]" onClick={onLibrary}>Back to documents</button>
      </div>
    </div>;
  }
  if (!doc) return <p role="status" className="p-6 text-sm text-muted">Opening document…</p>;
  return <DocumentEditor key={`${doc.store}:${doc.id}:${reload}`} initial={doc} user={user} onLibrary={onLibrary} onOpen={onOpen}
    onSessionEnded={onSessionEnded} onReload={() => setReload((n) => n + 1)} onRenamed={(name) => onTitle?.(name)}
    onView={onView} barHidden={barHidden} onHideBar={onHideBar} />;
}

function DocumentEditor({ initial, user, onLibrary, onOpen, onSessionEnded, onReload, onRenamed, onView, barHidden, onHideBar }: {
  initial: OpenDoc; user: WebSessionUser; onLibrary: () => void; onOpen: (id: string) => void; onSessionEnded: () => void; onReload: () => void; onRenamed: (name: string) => void;
  onView?: () => void; barHidden: boolean; onHideBar?: () => void;
}) {
  const { store, id, kind, role } = initial;
  const editable = role !== "viewer" && kind !== "unsupported";
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [office, setOffice] = useState<RichDocument | null>(initial.office);
  const [state, setState] = useState<SaveState>("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [collab, setCollab] = useState<CollabConfig | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  const [liveSession, setLiveSession] = useState<LiveRoom | null>(null);
  const [peers, setPeers] = useState<PeerUser[]>([]);
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [richEditor, setRichEditor] = useState<Editor | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const richSafety = useRichSafety();

  // What the server holds, as far as this page knows.
  const version = useRef(initial.version);
  const savedText = useRef(initial.text);
  const savedName = useRef(initial.name);
  const officeGeneration = useRef(0), savedOfficeGeneration = useRef(0);
  const textRef = useRef(text); textRef.current = text;
  const nameRef = useRef(name); nameRef.current = name;
  const officeRef = useRef(office); officeRef.current = office;
  const collabRef = useRef(collab); collabRef.current = collab;
  const stateRef = useRef(state); stateRef.current = state;
  // Every text this tab has held from the room, its own and its peers', so a
  // refused save can tell a room state from an outside one (live-snapshot.ts).
  const roomTexts = useRef<RoomTexts | null>(null);
  if (!roomTexts.current) { roomTexts.current = new RoomTexts(); roomTexts.current.add(initial.text); }
  const saving = useRef<Promise<void> | null>(null);
  const flushRich = useRef<(() => string | null) | null>(null);

  useEffect(() => {
    if (kind === "markdown") richSafety.assess(initial.text, `markie-cloud:${store}:${id}`);
    // Once per document: the probe protects the text as it was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Live editing ───────────────────────────────────────────────────────
  // The desktop's rule: a cloud document goes live when someone besides its
  // owner is on it. Only text documents have a room.
  const liveCapable = store === "docs" && (kind === "markdown" || kind === "text");
  const refreshLive = useCallback(async () => {
    if (!liveCapable) return;
    const members = await sharesClient.list(id);
    const token = getAuthToken();
    if (!members || members.length === 0 || !token) { setCollab(null); return; }
    const display = user.name || user.email;
    const readonly = role === "viewer";
    setCollab((prev) => prev && prev.readonly === readonly && prev.token === token ? prev : {
      docId: id, wsBase: collabWsBase(), token, fetchTicket: () => sharesClient.collabTicket(id),
      user: { name: display, color: colorForName(display) }, readonly,
    });
  }, [id, liveCapable, role, user.email, user.name]);
  useEffect(() => { void refreshLive(); }, [refreshLive]);

  const onCollabStatus = useCallback((status: "connecting" | "connected" | "disconnected" | "unavailable" | "empty") => {
    if (status === "unavailable" || status === "empty") {
      if (status === "unavailable") setLiveUnavailable(true);
      setCollab(null);
      setLiveStatus(null);
      return;
    }
    setLiveStatus(status);
  }, []);

  // Who writes the stored copy while live, and whether it can be written at
  // all (src/lib/live-snapshot.ts). The refusal is read from the stored copy
  // as the session starts: a rich room cannot carry front matter or raw HTML.
  const liveKindHere = kind === "markdown" ? "rich" : "text";
  const room = useLiveRoom(collab ? liveSession : null, liveKindHere, {
    documentEmpty: !initial.text.trim(),
    offer: editable && !!collab,
  });
  // savedText is read as the session starts, on purpose.
  const refusal = useMemo<SnapshotRefusal | null>(() => (collab ? liveSnapshotRefusal(savedText.current, liveKindHere) : null), [collab, liveKindHere]);
  const roomRef = useRef<LiveRoomState>(room); roomRef.current = room;
  const refusalRef = useRef(refusal); refusalRef.current = refusal;
  // Rule 6: whether the room the session joined holds the stored copy.
  const [liveBase, setLiveBase] = useState<LiveBase>("unknown");
  const base: LiveBase = refusal ? "room-state" : liveBase;
  const baseRef = useRef(base); baseRef.current = base;
  const onLiveSession = useCallback((session: LiveSession | LiveRoom | null) => {
    setLiveSession(session as unknown as LiveRoom | null);
    setLiveBase("unknown");
  }, []);

  // ── Saving ─────────────────────────────────────────────────────────────
  const currentText = useCallback(() => {
    if (kind === "markdown" && mode === "rich") {
      const flushed = flushRich.current?.();
      if (typeof flushed === "string") return flushed;
    }
    return textRef.current;
  }, [kind, mode]);

  const isDirty = useCallback(() => {
    if (nameRef.current !== savedName.current) return true;
    if (kind === "office") return officeGeneration.current !== savedOfficeGeneration.current;
    return textRef.current !== savedText.current;
  }, [kind]);

  const write = useCallback(async (content: string, docName: string, base: number, officeDoc: RichDocument | null) => {
    if (store === "docs") return (await saveTextDoc({ id, name: docName, content, baseVersion: base })).version;
    const bytes = officeDoc ? await exportRichDocument(officeDoc) : encodeTextDocument(content, initial.textMetadata ?? {});
    return (await savePlatformDoc({ id, name: docName, bytes: new Uint8Array(bytes), baseVersion: base })).version;
  }, [id, initial.textMetadata, store]);

  const save = useCallback(async (): Promise<void> => {
    if (!editable) return;
    if (saving.current) { await saving.current; if (!isDirty()) return; }
    if (stateRef.current === "conflict" || stateRef.current === "signed-out") return;
    const content = currentText();
    const docName = nameRef.current;
    const officeDoc = officeRef.current;
    const generation = officeGeneration.current;
    if (content === savedText.current && docName === savedName.current && generation === savedOfficeGeneration.current) {
      setState("saved");
      return;
    }
    // Live: only the room's elected writer pushes, only once the room is
    // connected, synced and holding the document, and never over a stored
    // copy the room cannot carry. Anything else waits; the room keeps the
    // edits either way.
    const live = !!collabRef.current;
    if (live && liveSnapshotWait(roomRef.current, { editable, refusal: refusalRef.current, base: baseRef.current })) return;
    setState("saving");
    const run = (async () => {
      try {
        let next: number;
        if (live) {
          // A 409 is resolved by the fingerprint rule: over a room state, or
          // surfaced as a conflict, never over an outside write.
          const result = await writeLiveSnapshot({
            save: (text, base) => write(text, docName, base, null),
            read: async () => {
              const server = await openTextDoc(id);
              return server ? { content: server.content, name: server.name, version: server.version } : null;
            },
            isConflict: (error) => error instanceof CloudConflictError,
          }, { content, name: docName, version: version.current, room: roomTexts.current! });
          if (result.kind === "conflict") throw new CloudConflictError(result.serverVersion);
          next = result.version;
        } else {
          next = await write(content, docName, version.current, officeDoc);
        }
        version.current = next;
        savedText.current = content;
        savedName.current = docName;
        savedOfficeGeneration.current = generation;
        setMessage(null);
        setState(isDirty() ? "dirty" : "saved");
      } catch (error) {
        if (error instanceof CloudConflictError) {
          setState("conflict");
          setMessage(live
            ? "Someone saved this document outside the live session, an agent or another device. The live edits are still here and weren't saved over theirs."
            : "Someone saved a newer version of this document. Your edits are still here and were not saved over theirs.");
        } else if (error instanceof SessionEndedError) {
          setState("signed-out");
          setMessage("Your session ended, so this edit wasn't saved. Sign in again in another tab, then save.");
        } else {
          setState("error");
          setMessage(error instanceof Error ? error.message : "Couldn't save. Your edits are still here.");
        }
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
  }, [currentText, editable, id, isDirty, write]);

  // Autosave a moment after the last edit, like the desktop.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(() => {
    if (!editable) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void save(); }, AUTOSAVE_MS);
  }, [editable, save]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const changed = useCallback(() => {
    const dirty = isDirty();
    setState((current) => current === "conflict" || current === "signed-out" ? current : dirty ? "dirty" : current === "saving" ? current : "saved");
    if (dirty) scheduleSave();
  }, [isDirty, scheduleSave]);

  const editText = useCallback((next: string) => {
    // Only text that came out of a ready room is a room state.
    if (collabRef.current && roomRef.current.ready) roomTexts.current?.add(next);
    textRef.current = next; setText(next); changed();
  }, [changed]);

  // A push that waited (not connected yet, not the writer yet) goes as soon
  // as it may.
  useEffect(() => {
    if (!collab || liveSnapshotWait(room, { editable, refusal, base })) return;
    if (isDirty()) scheduleSave();
  }, [collab, room, refusal, base, editable, isDirty, scheduleSave]);

  // The room's first text, as it becomes ready (rule 6). The same text as a
  // room seeded from the stored copy: that is the baseline, so opening never
  // rewrites the document. Anything else: the room drifted from a version
  // written outside it, and this session never writes over that.
  const onRoomReady = useCallback((roomText: string) => {
    roomTexts.current?.add(roomText);
    if (refusalRef.current || !editable) return;
    const stored = savedText.current;
    void roomMatchesStored(roomText, stored, liveKindHere).then((same) => {
      if (same) {
        if (textRef.current === roomText || textRef.current === stored) savedText.current = roomText;
        setLiveBase("room-state");
        changed();
        return;
      }
      setLiveBase("diverged");
      setState("conflict");
      setMessage(DIVERGED_NOTE);
    });
  }, [editable, liveKindHere, changed]);
  const editOffice = useCallback((next: RichDocument) => {
    officeRef.current = next; officeGeneration.current += 1; setOffice(next); changed();
  }, [changed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        void save();
      }
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      // Live edits are in the room whether or not this tab wrote them out.
      if (!isDirty() || !editable || collabRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onLeave); };
  }, [editable, isDirty, save]);

  // ── Rename, delete, conflict choices ───────────────────────────────────
  const rename = (typed: string) => {
    setRenaming(false);
    const next = renamedDocName(name, typed);
    if (!next || next === name) return;
    nameRef.current = next;
    setName(next);
    onRenamed(next);
    changed();
  };

  const remove = async () => {
    setMenu(false);
    if (!window.confirm(`Delete "${name}" from Markie Cloud? Everyone it is shared with loses it too. This can't be undone.`)) return;
    try {
      if (store === "docs") await deleteTextDoc(id);
      else await deletePlatformDoc(id, version.current);
      savedText.current = textRef.current; savedName.current = nameRef.current; savedOfficeGeneration.current = officeGeneration.current;
      onLibrary();
    } catch (error) {
      if (error instanceof SessionEndedError) onSessionEnded();
      else setMessage(error instanceof Error ? error.message : "Couldn't delete this document.");
    }
  };

  const saveMineAsCopy = async () => {
    const copyName = name.replace(/(\.[A-Za-z0-9]+)?$/, (ext) => ` (my copy)${ext}`);
    try {
      let newId: string;
      if (store === "docs") {
        newId = crypto.randomUUID();
        await saveTextDoc({ id: newId, name: copyName, content: currentText(), baseVersion: 0 });
      } else {
        const bytes = officeRef.current ? await exportRichDocument(officeRef.current) : encodeTextDocument(currentText(), initial.textMetadata ?? {});
        newId = (await savePlatformDoc({ id: null, name: copyName, bytes: new Uint8Array(bytes), baseVersion: 0 })).id;
      }
      savedText.current = textRef.current; savedName.current = nameRef.current; savedOfficeGeneration.current = officeGeneration.current;
      onOpen(newId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't save a copy.");
    }
  };

  const discardMine = () => {
    if (!window.confirm("Open the newer version? Your unsaved edits here will be lost.")) return;
    savedText.current = textRef.current; savedName.current = nameRef.current; savedOfficeGeneration.current = officeGeneration.current;
    onReload();
  };

  // ── Appearance, per document, as on the desktop ────────────────────────
  const appearanceStore = appearanceKey(`markie-cloud:${id}`);
  const [appearance, setAppearance] = useState<DocAppearance>(() => {
    try {
      const raw = window.localStorage.getItem(appearanceStore);
      return normalizeAppearance(raw ? JSON.parse(raw) : null);
    } catch {
      return DEFAULT_APPEARANCE;
    }
  });
  const changeAppearance = (next: DocAppearance) => {
    const clean = normalizeAppearance(next);
    setAppearance(clean);
    try { window.localStorage.setItem(appearanceStore, JSON.stringify(clean)); } catch { /* still applies here */ }
  };

  const darkmownSession = useDarkmownSession(kind === "darkmown" ? initial : null, text);

  const statusText = !editable
    ? kind === "unsupported" ? "Can't be edited here" : "View only"
    : collab && refusal ? "Live, not saved to Markie Cloud"
    : collab && state !== "conflict" && state !== "saving" && !room.writer ? "Live"
    : state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : state === "conflict" ? "Not saved" : state === "error" ? "Not saved" : state === "signed-out" ? "Signed out" : "Saved to Markie Cloud";

  const richReadOnly = !editable || !richSafety.armed;

  // ── View, Copy all and Export ──────────────────────────────────────────
  // Back to the read view saves first, so the view shows what was typed. A
  // save that cannot happen (a conflict, a lost session) keeps the editor
  // open with the reason; live edits are in the room either way.
  const goToView = async () => {
    if (!onView) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // The rich pane hands its text over on a debounce; take it now.
    if (editable && kind !== "office") {
      const latest = currentText();
      if (latest !== textRef.current) editText(latest);
    }
    if (editable && isDirty()) {
      // While live, this tab's push waits for the room (connected, synced,
      // this tab the writer), so give it a few seconds to land rather than
      // leave for a view of the copy before it. Another tab writing, or a
      // room that stays busy, does not keep anyone here: the edits are in the
      // room either way.
      const until = Date.now() + (collabRef.current ? 6000 : 0);
      for (;;) {
        await save();
        if (!isDirty() || Date.now() >= until || stateRef.current === "conflict" || stateRef.current === "signed-out") break;
        if (collabRef.current && (refusalRef.current || (roomRef.current.ready && !roomRef.current.writer))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (isDirty() && !collabRef.current) {
        setMessage((current) => current ?? "Your edits aren't saved yet, so the view would not show them. Save, then go back to View.");
        return;
      }
    }
    onView();
  };
  const exportText = useCallback(() => (kind === "office" ? officeRef.current?.text ?? "" : currentText()), [kind, currentText]);
  const exportHtml = useMemo(() => kind === "markdown" || kind === "text"
    ? () => viewHtml(kind, currentText(), store === "docs" ? memberAssetUrl(getServerURL(), id) : null)
    : undefined, [kind, currentText, store, id]);
  const exportOriginal = useMemo(() => kind === "office"
    ? async () => new Uint8Array(await exportRichDocument(officeRef.current ?? initial.office!))
    : undefined, [kind, initial.office]);

  return <div className="flex min-h-0 flex-1 flex-col" data-web-document={kind} data-web-store={store}>
    {barHidden ? null : <div className="markie-toolbar flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-4" data-web-doc-bar>
      <button type="button" onClick={onLibrary} aria-label="Back to documents" className="markie-toolbar-action flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:text-foreground">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
        <span className="hidden sm:inline">Documents</span>
      </button>
      <div className="h-4 w-px bg-border" />
      {renaming ? <input autoFocus defaultValue={name} aria-label="Document name"
        onBlur={(event) => rename(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") rename(event.currentTarget.value); else if (event.key === "Escape") setRenaming(false); }}
        className="w-56 min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-[12px] text-foreground outline-none" />
        : <button type="button" data-web-doc-title disabled={!editable} title={editable ? "Click to rename" : undefined} onClick={() => setRenaming(true)}
          className="min-w-0 max-w-[min(22rem,40vw)] truncate text-[12.5px] font-medium text-foreground/90 hover:text-foreground disabled:cursor-default">{name}</button>}
      <span role="status" data-web-save-state={editable ? state : "readonly"} className="hidden shrink-0 text-[11px] text-muted sm:inline">{statusText}</span>
      <div className="ml-auto flex items-center gap-2">
        {onView ? <button type="button" data-web-view-button onClick={() => void goToView()} title="Read this document as it is shared"
          className="markie-toolbar-action flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-foreground/90 hover:text-foreground">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
          View
        </button> : null}
        {collab ? <span role="status" data-web-live={liveStatus ?? "connecting"} className="hidden items-center gap-1.5 text-[11px] text-muted md:flex">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${liveStatus === "connected" ? "bg-[var(--status-green)]" : "bg-[var(--status-amber)]"}`} />Live
        </span> : null}
        {peers.length ? <span aria-label="People editing now" className="flex -space-x-1.5">{peers.slice(0, 4).map((peer, index) =>
          <span key={`${peer.name}-${index}`} title={peer.name} style={{ background: peer.color }} className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface text-[9px] font-semibold text-white">{initials(peer.name)}</span>)}</span> : null}
        {kind === "markdown" ? <div role="group" aria-label="View" className="flex rounded-md border border-border p-0.5">
          {(["rich", "source"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
            className={`rounded px-2 py-0.5 text-[11.5px] ${mode === value ? "bg-accent text-foreground" : "text-muted hover:text-foreground"}`}>{value === "rich" ? "Rich" : "Source"}</button>)}
        </div> : null}
        {editable && state !== "saved" && state !== "saving" && !(collab && liveSnapshotWait(room, { editable, refusal, base })) ? <button type="button" onClick={() => void save()} className="markie-toolbar-action h-7 rounded-md px-2 text-[12px] text-muted hover:text-foreground">Save</button> : null}
        {kind !== "unsupported" ? <CopyAllButton text={kind === "office" ? office?.text ?? "" : text} read={exportText} /> : null}
        {kind !== "unsupported" ? <WebExportMenu name={name} source={kind === "office" ? "office" : kind} read={exportText} html={exportHtml} original={exportOriginal} /> : null}
        <button type="button" onClick={() => setShowShare(true)} className="h-7 rounded-md bg-foreground px-3 text-[12px] font-medium text-background hover:opacity-90">Share</button>
        <div className="relative">
          <button type="button" aria-label="Document menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="markie-toolbar-action flex h-7 w-7 items-center justify-center rounded-md text-muted hover:text-foreground">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
          {menu ? <div className="markie-menu-panel absolute right-0 top-full z-50 mt-1.5 min-w-[170px] rounded-lg py-1.5" role="menu">
            {editable ? <button type="button" role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }} className="markie-menu-item w-full px-3 py-2 text-left text-[12px] text-muted">Rename…</button> : null}
            {store === "platform" && role !== "viewer" ? <button type="button" role="menuitem" onClick={() => { setMenu(false); setShowHistory(true); }} className="markie-menu-item w-full px-3 py-2 text-left text-[12px] text-muted">Version history…</button> : null}
            {role === "owner" ? <button type="button" role="menuitem" onClick={() => void remove()} className="markie-menu-item w-full px-3 py-2 text-left text-[12px] text-[var(--status-red)]">Delete…</button> : null}
            {!editable && role !== "owner" ? <p className="px-3 py-2 text-[11px] text-muted">Shared with you to read.</p> : null}
          </div> : null}
        </div>
        {onHideBar ? <HideBarButton onHide={onHideBar} className="markie-toolbar-action flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted hover:text-foreground" /> : null}
      </div>
    </div>}

    {state === "conflict" ? <div role="alert" data-web-conflict className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2 text-[12px]">
      <span className="min-w-0 flex-1 text-foreground">{message}</span>
      <button type="button" onClick={() => void saveMineAsCopy()} className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent">Save mine as a copy</button>
      <button type="button" onClick={discardMine} className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent">Open the newer version</button>
    </div> : message ? <div role="alert" className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-[12px] text-foreground">
      <span className="flex-1">{message}</span>
      {state === "signed-out" ? <a className="underline" href={`/auth/web-signin?next=${encodeURIComponent(`/app/d/${id}`)}`} target="_blank" rel="noreferrer">Sign in</a> : null}
      <button type="button" className="text-muted" onClick={() => setMessage(null)}>Dismiss</button>
    </div> : null}
    {collab && refusal && editable ? <p role="status" data-web-live-held className="border-b border-border bg-surface px-4 py-1.5 text-[11.5px] text-muted">{SNAPSHOT_REFUSAL_NOTE}</p> : null}
    {!editable && kind !== "unsupported" ? <p className="border-b border-border bg-surface px-4 py-1.5 text-[11.5px] text-muted">You can read and comment on this document. Its owner hasn&apos;t let you edit it.</p> : null}

    {kind === "markdown" && mode === "rich" ? <DocToolbar editor={richEditor} appearance={appearance} onAppearance={changeAppearance} canEdit={!richReadOnly} /> : null}

    <div data-markie-document-area style={appearanceVars(appearance) as React.CSSProperties} className="markie-document-area markie-document-area--single relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {kind === "markdown" && mode === "rich" ? <div data-markie-rich-pane className="markie-rich-pane flex h-full w-full min-w-0 flex-1 overflow-hidden">
        <RichSectionRail editor={richEditor} />
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          {richSafety.blocked && !collab ? <RichLossBanner risks={richSafety.risks ?? []} onEditSource={() => setMode("source")} onOverride={richSafety.override} /> : null}
          {richSafety.preparing && !collab ? <RichPreparingNote /> : null}
          {liveUnavailable ? <LiveUnavailableNote /> : null}
          <div className="min-h-0 flex-1">
            <ErrorBoundary fallback={(_error, reset) => <div role="alert" className="p-4 text-sm">The rich view stopped. <button type="button" className="underline" onClick={() => { reset(); setMode("source"); }}>Edit in Source</button></div>}>
              <RichView key={collab ? `live:${collab.docId}:${collab.readonly}` : "solo"} value={text} onChange={editText} onEditorReady={setRichEditor}
                collab={collab} readOnly={richReadOnly} canModerate={role === "owner"} onPeersChange={setPeers} onCollabStatus={onCollabStatus}
                holdUntilReady onLiveSession={onLiveSession} onRoomReady={onRoomReady}
                onFlushReady={(flush) => { flushRich.current = flush; }} />
            </ErrorBoundary>
          </div>
        </div>
      </div> : null}

      {kind === "markdown" && mode === "source" ? <div data-markie-source-pane className="markie-source-pane flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden">
        {collab ? <LiveSourceBanner /> : null}
        <div className="min-h-0 flex-1 overflow-hidden"><SourceEditor value={text} onChange={editText} readOnly={!!collab || !editable} /></div>
      </div> : null}

      {kind === "text" ? <div data-markie-source-pane className="markie-source-pane flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden">
        {liveUnavailable ? <LiveUnavailableNote /> : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {collab ? <TextCollabEditor key={`live-text:${collab.docId}:${collab.readonly}`} value={text} onChange={editText} collab={collab} readOnly={!editable}
            onPeersChange={setPeers} onCollabStatus={onCollabStatus} onLiveSession={onLiveSession} onRoomReady={onRoomReady} />
            : <SourceEditor value={text} plainText onChange={editText} readOnly={!editable} />}
        </div>
      </div> : null}

      {/* The desktop's documents workspace frame, so its editors lay out and
          style exactly as they do there. */}
      {kind === "darkmown" && darkmownSession ? <div className="docs-workspace docs-workspace-embedded w-full"><div className="docs-main"><div className="docs-editor-area">
        <DarkmownDocumentEditor session={darkmownSession} readOnly={!editable} onChange={editText} onFlushReady={() => {}} />
      </div></div></div> : null}

      {kind === "office" && office ? <div className="docs-workspace docs-workspace-embedded w-full"><div className="docs-main"><div className="docs-editor-area">
        <Suspense fallback={<p role="status" className="p-4 text-sm text-muted">Opening document…</p>}>
          <WordDocumentEditor document={office} readOnly={!editable} onChange={(next) => { if (editable && next.format === office.format) editOffice(next); }} />
        </Suspense>
      </div></div></div> : null}

      {kind === "unsupported" ? <p className="p-6 text-sm text-muted">Markie can&apos;t open this kind of file in the browser.</p> : null}
    </div>

    {showShare && store === "docs" ? <ShareDialog docId={id} fileName={name} body={kind === "markdown" ? text : ""} onClose={() => setShowShare(false)} onChanged={() => void refreshLive()} /> : null}
    {showShare && store === "platform" ? <PlatformShareDialog docId={id} name={name} role={role} onClose={() => setShowShare(false)} /> : null}
    {showHistory && store === "platform" ? <PlatformHistoryDialog docId={id} name={name} current={version.current} onClose={() => setShowHistory(false)}
      onOpenCopy={async (bytes) => {
        setShowHistory(false);
        if (kind === "office" && office) editOffice(await openRichDocument(office.format, bytes));
        else if (kind !== "office") editText(decodeTextDocument(bytes).text);
      }} /> : null}
  </div>;
}

/**
 * The Darkmown editor works on a DocumentSession, as in the desktop's
 * documents workspace. This keeps one for the open document, a new
 * generation per edit, so its trust grant and preview follow the text.
 */
function useDarkmownSession(initial: OpenDoc | null, text: string): DocumentSession | null {
  const [base, setBase] = useState<DocumentSession | null>(null);
  useEffect(() => {
    if (!initial) return;
    let live = true;
    void createDocumentSession("darkmown", initial.name).then((created) => {
      if (live) setBase({ ...created, text: initial.text, textMetadata: { text: initial.text, encoding: "utf-8", bom: false, newline: "lf" }, generation: 0, persistedGeneration: 0 });
    });
    return () => { live = false; };
    // One session per open document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.id]);
  return useMemo(() => {
    if (!base) return null;
    try {
      return editDocumentText(base, text);
    } catch {
      return base;
    }
  }, [base, text]);
}
