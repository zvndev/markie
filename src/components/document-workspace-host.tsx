import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CloudFile } from "@/lib/document-cloud";
import type { DocumentShellState } from "@/lib/document-shell";
import { DocumentWorkspace, type IncomingDocumentRequest } from "./documents/document-workspace";
import { applyColorMode, getColorMode, watchSystemColorMode } from "@/lib/color-mode";
import { applyTheme, findTheme, loadThemeStore } from "@/lib/theme";
import { getElectronAPI, isTooLarge } from "@/lib/electron";
import { createNativeDocumentFileAdapter } from "@/lib/native-document-files";
import { classifyDocumentFormat, decodeTextDocument } from "@/lib/document-formats";

const CloudDialog = lazy(() => import("./document-cloud-dialog").then((module) => ({ default: module.DocumentCloudDialog })));

export interface DocumentWorkspaceHostProps {
  embedded?: boolean;
  active?: boolean;
  onActivate?: () => void;
  onShellChange?: (state: DocumentShellState | null) => void;
}
interface CloudOpenIntent {
  id: string;
  source: Pick<DocumentShellState, "selectedId" | "name" | "hasSession">;
  prepared: boolean;
}
interface NativeSettlement {
  drained: boolean;
  activated: boolean;
  phase: "waiting" | "preparing" | "prepared";
  source: Pick<DocumentShellState, "selectedId" | "name" | "hasSession"> | null;
  finish(ok: boolean): void;
}
export function DocumentWorkspaceHost({ embedded = false, active = true, onActivate, onShellChange }: DocumentWorkspaceHostProps) {
  const [pending, setPending] = useState<{ file?: CloudFile; cloudDocumentId?: string } | null>(null);
  const [desktop] = useState(getElectronAPI);
  const [native] = useState(() => desktop?.documentFiles ? createNativeDocumentFileAdapter(desktop.documentFiles, desktop) : null);
  const [incoming, setIncoming] = useState<IncomingDocumentRequest[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const resolve = useRef<((message: string | null) => void) | null>(null);
  const prepareClose = useRef<(() => Promise<boolean>) | null>(null);
  const editorShell = useRef<DocumentShellState | null>(null);
  const cloudCloseGuard = useRef<(() => boolean) | null>(null);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const activate = useRef(onActivate); activate.current = onActivate;
  const closeGeneration = useRef(0);
  const cloudOpening = useRef(false);
  const cloudOpenIntent = useRef<CloudOpenIntent | null>(null);
  const [shellReadiness, setShellReadiness] = useState(0);
  const drainNative = useRef<(() => Promise<void>) | null>(null);
  const incomingIds = useRef(new Set<string>());
  const nativeSettlement = useRef<NativeSettlement | null>(null);
  const nativeReadFailures = useRef(0);
  const reportedReadFailures = useRef(0);
  const settleIncomingDocuments = useCallback((): Promise<boolean> => {
    const drain = drainNative.current, root = host.current;
    if (!drain || pendingRef.current || cloudOpening.current || nativeSettlement.current || !root) return Promise.resolve(false);
    return new Promise((resolve) => {
      const intent: NativeSettlement = { drained: false, activated: !root.hasAttribute("inert"), phase: "waiting", source: null, finish: (ok) => {
        if (nativeSettlement.current !== intent) return;
        nativeSettlement.current = null; clearTimeout(timeout); resolve(ok);
      } };
      const timeout = setTimeout(() => intent.finish(false), 30_000);
      nativeSettlement.current = intent;
      void drain().then(() => {
        if (nativeSettlement.current !== intent) return;
        intent.drained = true; setShellReadiness((revision) => revision + 1);
      }).catch(() => intent.finish(false));
    });
  }, []);
  const incomingHandled = useCallback((requestId: string, imported = true) => {
    if (!imported) nativeReadFailures.current++;
    incomingIds.current.delete(requestId);
    setIncoming((items) => items.filter((item) => item.requestId !== requestId));
  }, []);
  const registerPrepareClose = useCallback((prepare: (() => Promise<boolean>) | null) => { prepareClose.current = prepare; }, []);
  const registerCloudGuard = useCallback((guard: (() => boolean) | null) => { cloudCloseGuard.current = guard; }, []);
  const guardCloud = useCallback(async (prepare: () => Promise<boolean>) => {
    if (pendingRef.current && cloudCloseGuard.current?.() !== true) return false;
    try { return await prepare(); }
    catch { setHostError("Recovery did not finish. The document was kept open."); return false; }
  }, []);
  const openCloudDocument = useCallback((id: string) => {
    const state = editorShell.current;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || pendingRef.current || cloudOpening.current || !state?.ready || state.private || state.busy || host.current?.closest("[inert]")) return;
    cloudOpening.current = true;
    const intent: CloudOpenIntent = { id, source: { selectedId: state.selectedId, name: state.name, hasSession: state.hasSession }, prepared: false };
    cloudOpenIntent.current = intent;
    void (async () => {
      try {
        if (!await state.prepareLeave() || cloudOpenIntent.current !== intent || !host.current) return;
        intent.prepared = true;
        setShellReadiness((revision) => revision + 1);
      } catch { if (cloudOpenIntent.current === intent && host.current) setHostError("Recovery did not finish. The local document was kept open."); }
      finally {
        if (cloudOpenIntent.current === intent && !intent.prepared) { cloudOpenIntent.current = null; cloudOpening.current = false; }
      }
    })();
  }, []);
  useEffect(() => {
    const intent = cloudOpenIntent.current;
    if (!intent) return;
    const state = editorShell.current, root = host.current;
    const cancel = () => { cloudOpenIntent.current = null; cloudOpening.current = false; };
    if (!active || !root || root.closest("[inert]") || !state?.ready || pendingRef.current || state.private
      || state.selectedId !== intent.source.selectedId || state.name !== intent.source.name || state.hasSession !== intent.source.hasSession
      || document.querySelector('[role="dialog"][aria-modal="true"]') || state.commands?.modalOpen) { cancel(); return; }
    // prepareLeave clears busy asynchronously. Its promise can resolve before
    // the shell publishes that React commit; keep the intent until it does.
    if (!intent.prepared || state.busy) return;
    const request = { cloudDocumentId: intent.id };
    pendingRef.current = request;
    cancel();
    setPending(request);
  }, [active, shellReadiness]);
  // Evaluate after each committed Host render, including shell publications,
  // native acknowledgments and parent modal/activation changes.
  useEffect(() => {
    const intent = nativeSettlement.current;
    if (!intent) return;
    const state = editorShell.current, root = host.current;
    if (!root || !state || closing || pendingRef.current || cloudOpening.current || state.private || state.commands?.modalOpen
      || document.querySelector('[aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')) { intent.finish(false); return; }
    if (reportedReadFailures.current !== nativeReadFailures.current) {
      reportedReadFailures.current = nativeReadFailures.current; intent.finish(false); return;
    }
    if (intent.source && (state.selectedId !== intent.source.selectedId || state.name !== intent.source.name || state.hasSession !== intent.source.hasSession)) { intent.finish(false); return; }
    if (!active) { if (intent.activated) intent.finish(false); return; }
    intent.activated = true;
    // Initial activation also removes Home's inactive parent wrapper.
    if (root.closest("[inert]")) { intent.finish(false); return; }
    if (!intent.drained) return;
    if (incomingIds.current.size) { if (intent.source) intent.finish(false); return; }
    if (!state.ready || state.busy) return;
    if (intent.phase === "prepared") { intent.finish(true); return; }
    if (intent.phase === "preparing") return;
    intent.source = { selectedId: state.selectedId, name: state.name, hasSession: state.hasSession };
    intent.phase = "preparing";
    void (async () => {
      try {
        const allowed = await state.prepareLeave();
        if (nativeSettlement.current !== intent) return;
        if (!allowed) { intent.finish(false); return; }
        intent.phase = "prepared"; setShellReadiness((revision) => revision + 1);
      } catch { intent.finish(false); }
    })();
  });
  const receiveShell = useCallback((state: DocumentShellState | null) => {
    editorShell.current = state;
    if (cloudOpenIntent.current || nativeSettlement.current) setShellReadiness((revision) => revision + 1);
    onShellChange?.(state ? { ...state, openCloudDocument, settleIncomingDocuments, prepareClose: () => guardCloud(state.prepareClose), prepareLeave: () => guardCloud(state.prepareLeave) } : null);
  }, [guardCloud, onShellChange, openCloudDocument, settleIncomingDocuments]);
  useEffect(() => {
    if (embedded) return;
    applyColorMode(getColorMode());
    const store = loadThemeStore();
    applyTheme(findTheme(store, store.activeId).tokens);
    return watchSystemColorMode();
  }, [embedded]);
  useEffect(() => () => { resolve.current?.(null); cloudOpenIntent.current = null; cloudOpening.current = false; nativeSettlement.current?.finish(false); }, []);
  useEffect(() => {
    if (!native || !desktop) return;
    let mounted = true;
    let readQueue = Promise.resolve();
    const trackedIds = incomingIds.current;
    const enqueue = (payload: IncomingDocumentRequest["payload"]) => {
      if (mounted) {
        const requestId = crypto.randomUUID(); incomingIds.current.add(requestId);
        activate.current?.(); setIncoming((items) => [...items, { requestId, payload }]);
      }
      else if (payload.handle) void native.releaseDocument(payload.handle);
    };
    const drain = () => {
      readQueue = readQueue.catch(() => {}).then(async () => {
        for (let index = 0; mounted && index < 32; index++) {
          try {
            const payload = await native.readInitialDocument();
            if (!payload) break;
            enqueue(payload);
          } catch (failure) { nativeReadFailures.current++; if (mounted) { activate.current?.(); setHostError(failure instanceof Error ? failure.message : "The native document could not be opened."); } }
        }
      });
      return readQueue;
    };
    drainNative.current = drain;
    const unsubscribeNative = desktop.onDocumentFileOpened?.(drain);
    const unsubscribeText = !embedded ? desktop.onFileOpened?.((value) => {
      if (isTooLarge(value)) { setHostError(`${value.name} exceeds the desktop text-file limit.`); return; }
      const bytes = new TextEncoder().encode(value.content), format = classifyDocumentFormat(value.name);
      enqueue({ name: value.name, bytes, format, text: format.representation === "text" ? decodeTextDocument(bytes) : null });
    }) : undefined;
    drain();
    return () => {
      mounted = false; drainNative.current = null;
      nativeSettlement.current?.finish(false);
      trackedIds.clear(); unsubscribeNative?.(); unsubscribeText?.(); void native.dispose();
    };
  }, [desktop, native, embedded]);
  useEffect(() => {
    if (!desktop || embedded) return;
    const requests = closeGeneration;
    const unsubscribe = desktop.onAppWillClose?.((requestId) => {
      const generation = ++requests.current;
      setClosing(true);
      void (async () => {
        let allowed = false;
        try {
          const cloudAllowed = !pendingRef.current || cloudCloseGuard.current?.() === true;
          allowed = cloudAllowed && !!prepareClose.current && await prepareClose.current();
        } catch { setHostError("Recovery did not finish. The document window was kept open."); }
        if (generation !== requests.current) return;
        if (allowed) desktop.appCloseReady?.(requestId);
        else desktop.appCloseCancel?.(requestId);
        setClosing(false);
      })();
    });
    return () => { requests.current++; unsubscribe?.(); };
  }, [desktop, embedded]);
  useEffect(() => {
    if (!desktop || !active) return;
    const editorCommand = (command: "undo" | "redo" | "find") => {
      if (pendingRef.current) return;
      const root = host.current, focused = document.activeElement;
      if (!root || root.closest("[inert]") || focused instanceof HTMLElement && focused.closest("[inert]")) return;
      if (command !== "find" && focused instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName) && !focused.hasAttribute("data-document-text-editor")) {
        document.execCommand(command); return;
      }
      if (root.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = editorShell.current?.commands;
      if (target?.enabledCommands.includes(command)) target.execute(command);
    };
    const unsubscribe = [desktop.onMenuUndo?.(() => editorCommand("undo")), desktop.onMenuRedo?.(() => editorCommand("redo")), desktop.onMenuFind?.(() => editorCommand("find")), desktop.onMenuFindReplace?.(() => editorCommand("find"))];
    return () => { for (const off of unsubscribe) off?.(); };
  }, [desktop, active]);
  const requestShare = useCallback((file: CloudFile) => new Promise<string | null>((done) => {
    resolve.current?.(null);
    resolve.current = done;
    const request = { file: { ...file, bytes: new Uint8Array(file.bytes) } };
    pendingRef.current = request;
    setPending(request);
  }), []);
  const close = (message: string | null) => {
    setPending(null);
    pendingRef.current = null;
    resolve.current?.(message);
    resolve.current = null;
  };
  return <div ref={host} inert={closing || !active} className={embedded ? "docs-embedded-host" : desktop?.platform === "darwin" ? "docs-desktop-host docs-desktop-mac" : "docs-desktop-host"}>
    {!embedded && desktop?.platform === "darwin" ? <div className="docs-native-titlebar" data-window-drag-surface="true" aria-hidden="true">Markie</div> : null}
    {hostError ? <div role="alert" className="fixed top-2 left-1/2 -translate-x-1/2 z-[60] rounded-md border border-border bg-surface text-foreground p-3 text-sm">{hostError}<button type="button" className="ml-3" aria-label="Dismiss native file error" onClick={() => setHostError(null)}>×</button></div> : null}
    <div className={embedded ? "docs-embedded-content" : undefined} inert={!!pending}><DocumentWorkspace embedded={embedded} active={active} onShellChange={receiveShell} shareDocument={requestShare} externalModalOpen={!!pending}
      pickDocument={native?.pickDocument} saveDocument={native?.saveDocument} subscribeCommands={embedded ? undefined : native?.subscribeCommands}
      releaseDocument={native?.releaseDocument} incomingDocument={incoming[0]}
      onIncomingDocumentHandled={incomingHandled}
      onPrepareClose={registerPrepareClose} /></div>
    {pending ? <Suspense fallback={<p role="status">Opening sharing…</p>}><CloudDialog {...pending} onClose={close} onCloseGuard={registerCloudGuard} /></Suspense> : null}
  </div>;
}
