"use client";

import { useEffect, useRef, useState } from "react";
import {
  useEditor,
  useEditorState,
  EditorContent,
  type Editor,
} from "@tiptap/react";
import { TableBar } from "@/components/format-rail";
import { formatMarkdownTables } from "@/lib/format-tables";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Image } from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { CollabConfig, PeerUser } from "@/lib/collab";
import { CommentLayer } from "@/components/comments";

interface RichViewProps {
  value: string; // canonical markdown
  onChange: (md: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  // When set, the document lives in a shared Yjs room instead of the value
  // prop. The parent must remount this component (key) when collab changes.
  collab?: CollabConfig | null;
  onPeersChange?: (peers: PeerUser[]) => void;
  onCollabStatus?: (status: "connecting" | "connected" | "disconnected") => void;
}

interface CollabSession {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
}

export function RichView({
  value,
  onChange,
  onEditorReady,
  collab,
  onPeersChange,
  onCollabStatus,
}: RichViewProps) {
  // Guards the echo loop: rich edits → onChange(md) → value prop comes back
  // identical and must not re-parse (which would reset the cursor).
  const lastEmitted = useRef<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // The session is created disconnected so a StrictMode-discarded initializer
  // never opens a socket; the effect below owns connect/destroy.
  const [session] = useState<CollabSession | null>(() => {
    if (!collab) return null;
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(collab.wsBase, collab.docId, ydoc, {
      connect: false,
      params: { token: collab.token },
    });
    return { ydoc, provider };
  });

  useEffect(() => {
    if (!session) return;
    session.provider.connect();
    return () => {
      session.provider.destroy();
      session.ydoc.destroy();
    };
  }, [session]);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !collab?.readonly,
    extensions: [
      // Collaboration replaces local undo history with the shared Yjs one
      StarterKit.configure(session ? { undoRedo: false } : {}),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image,
      Placeholder.configure({ placeholder: "Start typing or open a file" }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        tightLists: true,
        transformPastedText: true,
      }),
      ...(session && collab
        ? [
            Collaboration.configure({ document: session.ydoc }),
            CollaborationCaret.configure({
              provider: session.provider,
              user: collab.user,
            }),
          ]
        : []),
    ],
    // In collab mode the Yjs doc is the source of truth from the first sync
    content: session ? undefined : value,
    onUpdate: ({ editor }) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const raw = (
          editor.storage as unknown as {
            markdown: { getMarkdown(): string };
          }
        ).markdown.getMarkdown();
        // Rich edits always emit pretty-aligned table pipes
        const md = formatMarkdownTables(raw);
        lastEmitted.current = md;
        onChange(md);
      }, 250);
    },
  });

  useEffect(() => {
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
      if (w.__markieEditor === editor) w.__markieEditor = null;
      if (w.__markieCollab === session) w.__markieCollab = null;
    };
  }, [editor, session, onEditorReady]);

  // First peer to join an empty room seeds it from the local file
  const seededRef = useRef(false);
  useEffect(() => {
    if (!session || !editor) return;
    const trySeed = (isSynced: boolean) => {
      if (!isSynced || seededRef.current) return;
      seededRef.current = true;
      const fragment = session.ydoc.getXmlFragment("default");
      if (fragment.length === 0 && valueRef.current.trim()) {
        editor.commands.setContent(valueRef.current);
      }
    };
    if (session.provider.synced) trySeed(true);
    session.provider.on("sync", trySeed);
    return () => session.provider.off("sync", trySeed);
  }, [session, editor]);

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
  useEffect(() => {
    if (!editor || session) return;
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value);
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
      {editor && inTable && !collab?.readonly && <TableBar editor={editor} />}
      <div ref={setScrollEl} className="h-full overflow-y-auto px-10 py-8 relative">
        <article
          className="markdown-body mx-auto"
          style={{
            maxWidth: "var(--doc-width, 768px)",
            fontSize: "var(--doc-font-size, 16px)",
          }}
        >
          <EditorContent editor={editor} />
        </article>
        {editor && session && collab && (
          <CommentLayer
            editor={editor}
            ydoc={session.ydoc}
            docId={collab.docId}
            readonly={collab.readonly}
            container={scrollEl}
          />
        )}
      </div>
    </div>
  );
}
