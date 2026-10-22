// The source editor for a shared plain-text file: same CodeMirror pane,
// same Yjs room service Markdown uses, with the document held as a Y.Text
// of the file's literal characters (src/lib/text-collab.ts). The parent must
// remount this component (key) when the collab config changes, exactly as
// with RichView. Presence is names-only here; remote carets in CodeMirror
// would need a cursor binding this does not claim to have.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc as YDoc } from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { useCollabRuntime, type CollabRuntime } from "@/lib/collab-loader";
import {
  COLLAB_SCHEMA_VERSION,
  SEED_SETTLE_MS,
  type CollabConfig,
  type PeerUser,
} from "@/lib/collab";
import { TextCollabBinding, TEXT_COLLAB_KEY } from "@/lib/text-collab";
import type { SourceHandle } from "@/lib/source-handle";
import { SourceEditor } from "@/components/source-editor";

interface TextCollabEditorProps {
  value: string;
  onChange: (value: string) => void;
  collab: CollabConfig;
  readOnly?: boolean;
  onReady?: (handle: SourceHandle | null) => void;
  onPeersChange?: (peers: PeerUser[]) => void;
  onCollabStatus?: (status: "connecting" | "connected" | "disconnected" | "unavailable") => void;
}

interface TextSession {
  ydoc: YDoc;
  provider: WebsocketProvider;
  binding: TextCollabBinding;
}

function TextCollabEditorInner({
  value,
  onChange,
  collab,
  readOnly = false,
  onReady,
  onPeersChange,
  onCollabStatus,
  runtime,
}: TextCollabEditorProps & { runtime: CollabRuntime | null }) {
  const [revoked, setRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = readOnly || collab.readonly || revoked;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  // Created disconnected so a discarded initializer never opens a socket;
  // the effect below owns connect/destroy (same lifecycle as RichView).
  const [session] = useState<TextSession | null>(() => {
    if (!runtime) return null;
    let ydoc: YDoc | null = null;
    let provider: WebsocketProvider | null = null;
    try {
      ydoc = new runtime.Y.Doc();
      provider = new runtime.WebsocketProvider(collab.wsBase, collab.docId, ydoc, {
        connect: false,
        params: { token: collab.token },
      });
      provider.awareness.setLocalStateField("user", collab.user);
      const binding = new TextCollabBinding(ydoc, ydoc.getText(TEXT_COLLAB_KEY), (text) => {
        onChangeRef.current(text);
      });
      return { ydoc, provider, binding };
    } catch (err) {
      console.error("Markie: couldn't start the text live session", err);
      try { provider?.destroy(); ydoc?.destroy(); } catch { /* already torn down */ }
      return null;
    }
  });

  useEffect(() => {
    if (!session) return;
    session.provider.connect();
    return () => {
      session.binding.dispose();
      session.provider.destroy();
      session.ydoc.destroy();
    };
  }, [session]);

  // The server closes with 4403 when access went away mid-session: stop for
  // good, lock the pane, and say why (mirrors RichView).
  useEffect(() => {
    if (!session) return;
    const provider = session.provider;
    const onClose = (event: CloseEvent | null) => {
      if (event?.code !== 4403) return;
      provider.disconnect();
      setRevoked(true);
      setError("Your access to this document was removed. It's read-only now. Copy anything you still need.");
      onCollabStatus?.("disconnected");
    };
    provider.on("connection-close", onClose);
    return () => provider.off("connection-close", onClose);
  }, [session, onCollabStatus]);

  // Presence + connection state for the toolbar, as in RichView.
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

  // First editor into an empty room seeds it from the local file, after the
  // first sync plus the same settle delay RichView uses. The server elects
  // a single seeder and drops everyone else's first update; the schema
  // stamp travels in the same transaction as the text.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!session) return;
    const { provider, ydoc, binding } = session;
    let settle: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const roomHasText = () => ydoc.getText(TEXT_COLLAB_KEY).length > 0;
    const seedNow = () => {
      settle = null;
      if (cancelled || seededRef.current || lockedRef.current) return;
      if (roomHasText()) { seededRef.current = true; return; }
      if (!valueRef.current) return;
      seededRef.current = true;
      ydoc.transact(() => {
        binding.seedIfEmpty(valueRef.current);
        ydoc.getMap("meta").set("schemaVersion", COLLAB_SCHEMA_VERSION);
        ydoc.getMap("meta").set("contentKind", "text");
      });
    };
    const trySeed = (isSynced: boolean) => {
      if (!isSynced || cancelled || seededRef.current || settle || lockedRef.current) return;
      if (roomHasText()) { seededRef.current = true; return; }
      settle = setTimeout(seedNow, SEED_SETTLE_MS);
    };
    if (provider.synced) trySeed(true);
    provider.on("sync", trySeed);
    return () => {
      cancelled = true;
      if (settle) clearTimeout(settle);
      provider.off("sync", trySeed);
    };
  }, [session]);

  const handleChange = useCallback((next: string) => {
    if (!session || lockedRef.current) return;
    const merged = session.binding.applyLocal(next);
    onChangeRef.current(merged);
  }, [session]);

  if (!session) {
    return <SourceEditor value={value} plainText onChange={onChange} onReady={onReady} readOnly={readOnly} />;
  }
  return (
    <div className="h-full flex flex-col" data-markie-text-live>
      {error && (
        <div role="status" className="markie-banner shrink-0 flex items-center px-3 py-1.5 text-[11px] text-muted">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        <SourceEditor value={value} plainText onChange={handleChange} onReady={onReady} readOnly={locked} />
      </div>
    </div>
  );
}

export function TextCollabEditor(props: TextCollabEditorProps) {
  const { runtime, failed } = useCollabRuntime(true);
  const { onCollabStatus } = props;
  useEffect(() => {
    if (failed) onCollabStatus?.("unavailable");
  }, [failed, onCollabStatus]);
  if (!runtime && !failed) {
    return (
      <div data-markie-live-loading className="flex-1 flex items-center justify-center text-[12px] text-muted">
        Joining the live session…
      </div>
    );
  }
  if (failed) {
    return (
      <div className="h-full flex flex-col">
        <div data-markie-live-failed role="status" className="markie-banner shrink-0 flex items-center px-3 py-1.5 text-[11px] text-muted">
          The live session could not load. You are editing your copy alone.
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <SourceEditor value={props.value} plainText onChange={props.onChange} onReady={props.onReady} readOnly={props.readOnly} />
        </div>
      </div>
    );
  }
  return <TextCollabEditorInner {...props} runtime={runtime} />;
}
