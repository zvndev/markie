"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useEditor,
  useEditorState,
  EditorContent,
  type AnyExtension,
  type Editor,
} from "@tiptap/react";
import { TableBar } from "@/components/format-rail";
import { formatMarkdownTables } from "@/lib/format-tables";
import { richBaseExtensions } from "@/lib/rich-extensions";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import {
  COLLAB_SCHEMA_VERSION,
  shouldWarnSchema,
  SCHEMA_MISMATCH_NOTICE,
  SEED_SETTLE_MS,
  type CollabConfig,
  type PeerUser,
} from "@/lib/collab";
import { CommentLayer } from "@/components/comments";
import { findHighlightPlugin, findPluginKey } from "@/lib/rich-find";

interface RichViewProps {
  value: string; // canonical markdown
  onChange: (md: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  // When set, the document lives in a shared Yjs room instead of the value
  // prop. The parent must remount this component (key) when collab changes.
  collab?: CollabConfig | null;
  // The share role the page resolved. It also covers the window before a role
  // resolves, which the collab config cannot: that is null until membership
  // comes back, and a null config used to read as "editable".
  readOnly?: boolean;
  /** The viewer owns this document, so may moderate (delete) others' comments. */
  canModerate?: boolean;
  onPeersChange?: (peers: PeerUser[]) => void;
  onCollabStatus?: (status: "connecting" | "connected" | "disconnected") => void;
  // Hands the parent a way to settle the 250 ms debounce on demand and get the
  // markdown back synchronously. Exporting or saving inside that window used to
  // write the document as it stood a keystroke ago. Called with null on unmount
  // so the parent never holds a flush for a destroyed editor.
  onFlushReady?: (flush: FlushRich | null) => void;
}

/** Returns the freshly serialized markdown, or null when nothing was pending. */
export type FlushRich = () => string | null;

interface CollabSession {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
}

// The document as markdown, exactly as an edit would emit it. Rich edits always
// emit pretty-aligned table pipes.
function serializeMarkdown(editor: Editor): string {
  const raw = (
    editor.storage as unknown as {
      markdown: { getMarkdown(): string };
    }
  ).markdown.getMarkdown();
  return formatMarkdownTables(raw);
}

export function RichView({
  value,
  onChange,
  onEditorReady,
  collab,
  readOnly = false,
  canModerate = false,
  onPeersChange,
  onCollabStatus,
  onFlushReady,
}: RichViewProps) {
  // The server told us, mid-session, that this user is no longer in the room.
  // The role prop cannot know that yet, so the editor has to lock itself.
  const [revoked, setRevoked] = useState(false);
  const locked = readOnly || !!collab?.readonly || revoked;
  // Guards the echo loop: rich edits → onChange(md) → value prop comes back
  // identical and must not re-parse (which would reset the cursor).
  const lastEmitted = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while we are pushing an external value into the editor, so onUpdate
  // can tell "the file changed underneath me" from "the user typed".
  const applyingExternal = useRef(false);
  // flush() has to be stable — the parent stores it — so it reads the current
  // editor and onChange through refs rather than through its closure.
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // The session is created disconnected so a StrictMode-discarded initializer
  // never opens a socket; the effect below owns connect/destroy.
  //
  // The Yjs binding is built here too, in the same try/catch: a room whose
  // content does not fit this editor's schema throws while the extension is
  // wired up, and a throw during render unmounts the whole app to a white
  // window. Falling back to a solo editor on the local file loses the live
  // session, which is a great deal better than losing the window.
  const [init] = useState<{
    session: CollabSession | null;
    extensions: AnyExtension[];
    error: string | null;
  }>(() => {
    if (!collab) return { session: null, extensions: [], error: null };
    let ydoc: Y.Doc | null = null;
    let provider: WebsocketProvider | null = null;
    try {
      ydoc = new Y.Doc();
      provider = new WebsocketProvider(collab.wsBase, collab.docId, ydoc, {
        connect: false,
        params: { token: collab.token },
      });
      const extensions: AnyExtension[] = [
        Collaboration.configure({ document: ydoc }),
        CollaborationCaret.configure({
          provider,
          user: collab.user,
        }),
      ];
      return { session: { ydoc, provider }, extensions, error: null };
    } catch (err) {
      console.error("Markie: couldn't start the live session", err);
      try {
        provider?.destroy();
        ydoc?.destroy();
      } catch {
        // already torn down
      }
      return {
        session: null,
        extensions: [],
        error: "Couldn't join the live session. You're editing the local copy.",
      };
    }
  });
  const session = init.session;
  const [collabError, setCollabError] = useState<string | null>(init.error);

  useEffect(() => {
    if (!session) return;
    session.provider.connect();
    return () => {
      session.provider.destroy();
      session.ydoc.destroy();
    };
  }, [session]);

  // The session never started, so the toolbar must stop saying "connecting"
  // for a connection nothing is going to make.
  useEffect(() => {
    if (init.error) onCollabStatus?.("disconnected");
  }, [init.error, onCollabStatus]);

  // The server closes with 4403 when this user may no longer be in the room
  // (share revoked, token rotated). y-websocket has no idea that is terminal:
  // it resets its backoff on every open, so the client reconnects several times
  // a second forever and every attempt re-renders the toolbar. Stop for good
  // and say why.
  useEffect(() => {
    if (!session) return;
    const provider = session.provider;
    const onClose = (event: CloseEvent | null) => {
      if (event?.code !== 4403) return;
      provider.disconnect();
      // Keystrokes after this point go nowhere: the room is gone and nothing
      // typed here can ever be saved. Lock the editor and say what is left.
      setRevoked(true);
      setCollabError(
        "Your access to this document was removed. It's read-only now — copy anything you still need."
      );
      onCollabStatus?.("disconnected");
    };
    provider.on("connection-close", onClose);
    return () => provider.off("connection-close", onClose);
  }, [session, onCollabStatus]);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !locked,
    // One shared list (src/lib/rich-extensions.ts) so the round-trip probe and
    // the block normalizer test the exact editor configuration, never a copy.
    extensions: [
      ...richBaseExtensions({ collab: !!session }),
      ...init.extensions,
    ],
    // In collab mode the Yjs doc is the source of truth from the first sync
    content: session ? undefined : value,
    onUpdate: ({ editor }) => {
      // Belt and braces alongside emitUpdate:false — an update raised while we
      // are loading an external value is never the user's edit, and echoing it
      // back would overwrite the file with the serializer's approximation.
      if (applyingExternal.current) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        const md = serializeMarkdown(editor);
        lastEmitted.current = md;
        onChange(md);
      }, 250);
    },
  });

  // Search highlights are a plugin, not marks in the document, so nothing about
  // finding text can be serialized into the file. Registered after the fact
  // rather than as an extension because it holds no configuration and the
  // editor is rebuilt whenever collab changes.
  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(findHighlightPlugin());
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(findPluginKey);
    };
  }, [editor]);

  // useEditor re-applies changed options on every render but deliberately keeps
  // whatever `editable` the editor already had (@tiptap/react's
  // EditorInstanceManager.onRender), so a role that resolves after mount only
  // takes effect if it is applied by hand.
  useEffect(() => {
    const shouldEdit = !locked;
    if (editor && editor.isEditable !== shouldEdit) editor.setEditable(shouldEdit);
  }, [editor, locked]);

  // Settle the debounce now and hand back what the document currently says.
  // Null means nothing was pending, so the parent's own copy is already current.
  const flush = useCallback((): string | null => {
    if (!debounceTimer.current) return null;
    clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return null;
    try {
      const md = serializeMarkdown(ed);
      lastEmitted.current = md;
      onChangeRef.current(md);
      return md;
    } catch (err) {
      // A serializer failure must not take the export or the save with it; the
      // caller falls back to the last value it was given.
      console.error("Markie: couldn't serialize the document", err);
      return null;
    }
  }, []);

  useEffect(() => {
    onFlushReady?.(flush);
    return () => onFlushReady?.(null);
  }, [onFlushReady, flush]);

  useEffect(() => {
    editorRef.current = editor;
    onEditorReady?.(editor);
    // Test/debug handle for driving the editor via CDP (kept in prod so the
    // packaged app stays automatable). Released on cleanup so it only ever
    // references the *current* editor/doc — never pins destroyed ones across
    // file/collab switches.
    const w = window as unknown as {
      __markieEditor?: Editor | null;
      __markieCollab?: CollabSession | null;
    };
    w.__markieEditor = editor;
    w.__markieCollab = session;
    return () => {
      onEditorReady?.(null);
      if (editorRef.current === editor) editorRef.current = null;
      if (w.__markieEditor === editor) w.__markieEditor = null;
      if (w.__markieCollab === session) w.__markieCollab = null;
    };
  }, [editor, session, onEditorReady]);

  // First peer to join an empty room seeds it from the local file.
  //
  // Snapshots and Yjs updates are stored separately on the server, so a doc
  // shared as a snapshot opens into an empty room and a client has to convert
  // the markdown. "Empty after sync" alone is not enough of a test: two editors
  // opening the same room in the same second both see an empty fragment and
  // both write, and the room ends up holding two interleaved copies of the
  // file. So this waits for the first sync, then looks again after a settle
  // delay, by which time the winner's content has arrived. The server elects a
  // single seeder per room as well, and drops everyone else's first update, so
  // a racer that still gets here writes only into its own copy.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!session || !editor) return;
    const { provider, ydoc } = session;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // Returns true when the room already has content, so there is nothing left
    // to decide.
    const roomHasContent = () => {
      if (ydoc.getXmlFragment("default").length === 0) return false;
      seededRef.current = true;
      return true;
    };

    const seedNow = () => {
      settle = null;
      if (cancelled || seededRef.current || locked) return;
      if (roomHasContent()) return;
      // Nothing to seed *with*. Marking the room seeded here is how an empty
      // buffer used to lock a real document out of its own room and then save
      // the blank back over the file.
      if (!valueRef.current.trim()) return;
      seededRef.current = true;
      // One transaction, one update on the wire. The server's seed lock opens
      // on the first update it persists, so the schema stamp must travel WITH
      // the content, not ahead of it: sent separately, a stamp-only update
      // would release the lock on a room that still holds nothing. Content
      // first inside the transaction, so even an unmerged write seeds the
      // document before it seeds the metadata.
      ydoc.transact(() => {
        editor.commands.setContent(valueRef.current);
        // Stamp what wrote this room, so a future build that cannot read this
        // shape can say so rather than quietly mangling it.
        ydoc.getMap("meta").set("schemaVersion", COLLAB_SCHEMA_VERSION);
      });
    };

    const trySeed = (isSynced: boolean) => {
      if (!isSynced || cancelled || seededRef.current || settle) return;
      // A viewer is not an author. Seeding from a read-only client writes the
      // room's first content from someone who was never allowed to edit it, and
      // when several viewers open an empty room they each write their own copy.
      if (locked) return;
      if (roomHasContent()) return;
      settle = setTimeout(seedNow, SEED_SETTLE_MS);
    };

    if (provider.synced) trySeed(true);
    provider.on("sync", trySeed);
    return () => {
      cancelled = true;
      if (settle) clearTimeout(settle);
      provider.off("sync", trySeed);
    };
  }, [session, editor, locked]);

  // A room seeded by a different build of Markie may hold nodes this editor's
  // schema does not know. That is not fatal and must not block editing, so it
  // is said out loud once and left at that.
  const schemaWarnedRef = useRef(false);
  useEffect(() => {
    if (!session) return;
    const meta = session.ydoc.getMap("meta");
    const check = () => {
      const version = meta.get("schemaVersion");
      if (!shouldWarnSchema(version, schemaWarnedRef.current)) return;
      schemaWarnedRef.current = true;
      console.warn(
        `Markie: this room was written with collab schema ${String(version)}, ` +
          `this build speaks ${COLLAB_SCHEMA_VERSION}`
      );
      // Never over-write a louder notice: a revoked session has more to say.
      setCollabError((prev) => prev ?? SCHEMA_MISMATCH_NOTICE);
    };
    check();
    meta.observe(check);
    return () => meta.unobserve(check);
  }, [session]);

  // Surface presence + connection state to the toolbar
  useEffect(() => {
    if (!session) return;
    const awareness = session.provider.awareness;
    const emitPeers = () => {
      const peers = [...awareness.getStates().entries()]
        .filter(([clientId]) => clientId !== awareness.clientID)
        .map(([, state]) => (state as { user?: PeerUser }).user)
        .filter((u): u is PeerUser => !!u?.name);
      onPeersChange?.(peers);
    };
    const emitStatus = ({ status }: { status: string }) => {
      onCollabStatus?.(status as "connecting" | "connected" | "disconnected");
    };
    awareness.on("change", emitPeers);
    session.provider.on("status", emitStatus);
    emitPeers();
    return () => {
      awareness.off("change", emitPeers);
      session.provider.off("status", emitStatus);
      onPeersChange?.([]);
      onCollabStatus?.("disconnected");
    };
  }, [session, onPeersChange, onCollabStatus]);

  // External value changes (CodeMirror edits, file opens) re-parse into the
  // editor — solo mode only; in collab the room is authoritative.
  //
  // `emitUpdate: false` is load-bearing. TipTap emits an update from setContent
  // by default, which ran onUpdate and serialized the freshly-parsed doc back
  // over the file the user just opened. Anything the markdown round trip cannot
  // preserve (YAML front matter, raw HTML, footnotes, math) was silently
  // rewritten, and the document was marked dirty without a keystroke.
  useEffect(() => {
    if (!editor || session) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    applyingExternal.current = true;
    try {
      editor.commands.setContent(value, { emitUpdate: false });
    } finally {
      applyingExternal.current = false;
    }
  }, [value, editor, session]);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const inTable = useEditorState({
    editor,
    selector: ({ editor: e }) => e?.isActive("table") ?? false,
  });

  // Comment gutter overlay needs the scroll container element
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  return (
    <div className="h-full relative">
      {collabError && (
        <div
          role="status"
          className="absolute top-2 left-1/2 -translate-x-1/2 z-20 max-w-[90%] rounded-md border border-border/70 bg-background/95 px-2.5 py-1.5 text-[11.5px] text-foreground shadow-sm"
        >
          {collabError}
        </div>
      )}
      {editor && inTable && !locked && <TableBar editor={editor} />}
      <div ref={setScrollEl} className="markie-document-scroll h-full overflow-y-auto relative">
        <article
          data-markie-rich-canvas
          className="markdown-body markie-document-canvas mx-auto"
          style={{
            width: "min(100%, var(--doc-width, 768px))",
            fontSize: "var(--doc-font-size, 16px)",
            // Set per document by the toolbar; falls through to the theme's
            // font when the document has no preference of its own.
            fontFamily: "var(--doc-font-family, inherit)",
          }}
        >
          <EditorContent editor={editor} />
        </article>
        {editor && session && collab && (
          <CommentLayer
            editor={editor}
            ydoc={session.ydoc}
            docId={collab.docId}
            readonly={locked}
            // Track 2 made commenting follow read access, so a viewer keeps the
            // composer. Someone revoked mid-session has no read access left;
            // their composer would 403 in silence.
            canComment={!revoked}
            canModerate={canModerate}
            container={scrollEl}
          />
        )}
      </div>
    </div>
  );
}
