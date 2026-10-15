import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CloudFile } from "@/lib/document-cloud";
import { DocumentWorkspace, type IncomingDocumentRequest } from "./documents/document-workspace";
import { applyColorMode, getColorMode, watchSystemColorMode } from "@/lib/color-mode";
import { applyTheme, findTheme, loadThemeStore } from "@/lib/theme";
import { getElectronAPI, isTooLarge } from "@/lib/electron";
import { createNativeDocumentFileAdapter } from "@/lib/native-document-files";
import { classifyDocumentFormat, decodeTextDocument } from "@/lib/document-formats";

const CloudDialog = lazy(() => import("./document-cloud-dialog").then((module) => ({ default: module.DocumentCloudDialog })));

export function DocumentWorkspaceHost({ onExit }: { onExit?: () => void }) {
  const [pending, setPending] = useState<CloudFile | null>(null);
  const [desktop] = useState(getElectronAPI);
  const [native] = useState(() => desktop?.documentFiles ? createNativeDocumentFileAdapter(desktop.documentFiles, desktop) : null);
  const [incoming, setIncoming] = useState<IncomingDocumentRequest[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const resolve = useRef<((message: string | null) => void) | null>(null);
  const prepareClose = useRef<(() => Promise<boolean>) | null>(null);
  const cloudCloseGuard = useRef<(() => boolean) | null>(null);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const closeGeneration = useRef(0);
  const registerPrepareClose = useCallback((prepare: (() => Promise<boolean>) | null) => { prepareClose.current = prepare; }, []);
  const registerCloudGuard = useCallback((guard: (() => boolean) | null) => { cloudCloseGuard.current = guard; }, []);
  useEffect(() => {
    applyColorMode(getColorMode());
    const store = loadThemeStore();
    applyTheme(findTheme(store, store.activeId).tokens);
    return watchSystemColorMode();
  }, []);
  useEffect(() => () => { resolve.current?.(null); }, []);
  useEffect(() => {
    if (!native || !desktop) return;
    let mounted = true;
    let readQueue = Promise.resolve();
    const enqueue = (payload: IncomingDocumentRequest["payload"]) => {
      if (mounted) setIncoming((items) => [...items, { requestId: crypto.randomUUID(), payload }]);
      else if (payload.handle) void native.releaseDocument(payload.handle);
    };
    const drain = () => {
      readQueue = readQueue.catch(() => {}).then(async () => {
        for (let index = 0; mounted && index < 32; index++) {
          try {
            const payload = await native.readInitialDocument();
            if (!payload) break;
            enqueue(payload);
          } catch (failure) { if (mounted) setHostError(failure instanceof Error ? failure.message : "The native document could not be opened."); }
        }
      });
    };
    const unsubscribeNative = desktop.onDocumentFileOpened?.(drain);
    const unsubscribeText = desktop.onFileOpened?.((value) => {
      if (isTooLarge(value)) { setHostError(`${value.name} exceeds the desktop text-file limit.`); return; }
      const bytes = new TextEncoder().encode(value.content), format = classifyDocumentFormat(value.name);
      enqueue({ name: value.name, bytes, format, text: format.representation === "text" ? decodeTextDocument(bytes) : null });
    });
    drain();
    return () => { mounted = false; unsubscribeNative?.(); unsubscribeText?.(); void native.dispose(); };
  }, [desktop, native]);
  useEffect(() => {
    if (!desktop) return;
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
  }, [desktop]);
  useEffect(() => {
    if (!desktop) return;
    const editorCommand = (command: "undo" | "redo" | "find") => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body || active.closest("[inert]")) return;
      if (command !== "find" && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) && !active.hasAttribute("data-document-text-editor")) {
        document.execCommand(command); return;
      }
      const key = command === "find" ? "f" : "z";
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, metaKey: desktop.platform === "darwin", ctrlKey: desktop.platform !== "darwin", shiftKey: command === "redo" });
      active.dispatchEvent(event);
      if (command !== "find" && !event.defaultPrevented && active.hasAttribute("data-document-text-editor")) document.execCommand(command);
      if (command === "find" && !event.defaultPrevented) {
        const word = active.closest(".docs-word-host");
        const home = [...(word?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])].find((tab) => tab.textContent === "Home");
        home?.click();
        requestAnimationFrame(() => word?.querySelector<HTMLInputElement>('[aria-label="Find Word text"]')?.focus());
      }
    };
    const unsubscribe = [desktop.onMenuUndo?.(() => editorCommand("undo")), desktop.onMenuRedo?.(() => editorCommand("redo")), desktop.onMenuFind?.(() => editorCommand("find")), desktop.onMenuFindReplace?.(() => editorCommand("find"))];
    return () => { for (const off of unsubscribe) off?.(); };
  }, [desktop]);
  const requestShare = useCallback((file: CloudFile) => new Promise<string | null>((done) => {
    resolve.current?.(null);
    resolve.current = done;
    setPending({ ...file, bytes: new Uint8Array(file.bytes) });
  }), []);
  const close = (message: string | null) => {
    setPending(null);
    resolve.current?.(message);
    resolve.current = null;
  };
  return <div inert={closing} className={desktop?.platform === "darwin" ? "docs-desktop-host docs-desktop-mac" : "docs-desktop-host"}>
    {desktop?.platform === "darwin" ? <div className="docs-native-titlebar" data-window-drag-surface="true" aria-hidden="true">Markie</div> : null}
    {hostError ? <div role="alert" className="fixed top-2 left-1/2 -translate-x-1/2 z-[60] rounded-md border border-border bg-surface text-foreground p-3 text-sm">{hostError}<button type="button" className="ml-3" aria-label="Dismiss native file error" onClick={() => setHostError(null)}>×</button></div> : null}
    <div inert={!!pending}><DocumentWorkspace onExit={onExit} shareDocument={requestShare} externalModalOpen={!!pending}
      pickDocument={native?.pickDocument} saveDocument={native?.saveDocument} subscribeCommands={native?.subscribeCommands}
      releaseDocument={native?.releaseDocument} incomingDocument={incoming[0]}
      onIncomingDocumentHandled={(requestId) => setIncoming((items) => items.filter((item) => item.requestId !== requestId))}
      onPrepareClose={registerPrepareClose} /></div>
    {pending ? <Suspense fallback={<p role="status">Opening sharing…</p>}><CloudDialog file={pending} onClose={close} onCloseGuard={registerCloudGuard} /></Suspense> : null}
  </div>;
}
