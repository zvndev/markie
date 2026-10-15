import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { LibraryRecord } from "@/lib/document-library";
import { documentNeedsRecoverySave, type EditableDocumentFormat } from "@/lib/document-session";
import type { WebDocumentPayload } from "@/lib/web-files";
import { DocumentLibrary } from "./document-library";
import { TextDocumentEditor } from "./text-document-editor";
import { WordDocumentEditor } from "./word-document-editor";
import { useDocumentWorkspace, type DocumentWorkspaceServices } from "./use-document-workspace";
import { AppearanceMenu } from "./appearance-menu";
import { ConfirmDocumentRemoval } from "./confirm-document-removal";
import { ConfirmDocumentConversion } from "./confirm-document-conversion";
import "./document-workspace.css";

const VaultPanel = lazy(() => import("./vault-panel").then((module) => ({ default: module.VaultPanel })));
export interface IncomingDocumentRequest { requestId: string; payload: WebDocumentPayload }
export interface DocumentWorkspaceProps extends DocumentWorkspaceServices {
  onExit?: () => void; externalModalOpen?: boolean;
  incomingDocument?: IncomingDocumentRequest | null;
  /** Consumed includes a displayed safe-import error, not a guarantee of success. */
  onIncomingDocumentHandled?: (requestId: string) => void;
  onPrepareClose?: (prepare: (() => Promise<boolean>) | null) => void;
}
const NEW_FORMATS: { format: EditableDocumentFormat; label: string; detail: string }[] = [
  { format: "docx", label: "Word document", detail: ".docx" }, { format: "text", label: "Plain text", detail: ".txt" },
  { format: "markdown", label: "Markdown", detail: ".md" }, { format: "csv", label: "CSV table", detail: ".csv" },
  { format: "json", label: "JSON", detail: ".json" }, { format: "yaml", label: "YAML", detail: ".yaml" }, { format: "xml", label: "XML", detail: ".xml" },
];
export function DocumentWorkspace({ onExit, externalModalOpen = false, incomingDocument, onIncomingDocumentHandled, onPrepareClose, ...services }: DocumentWorkspaceProps) {
  const [vault, setVault] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showLibrary, setShowLibrary] = useState(() => typeof window === "undefined" || window.innerWidth > 650);
  const [pendingDelete, setPendingDelete] = useState<LibraryRecord | null>(null);
  const [pendingIncoming, setPendingIncoming] = useState<IncomingDocumentRequest[]>([]);
  const [closeFailure, setCloseFailure] = useState<string | null>(null);
  const vaultGuard = useRef<(() => boolean) | null>(null);
  const newMenuRoot = useRef<HTMLDivElement>(null), newMenuTrigger = useRef<HTMLButtonElement>(null);
  const setVaultGuard = useCallback((guard: (() => boolean) | null) => { vaultGuard.current = guard; }, []);
  const canLeaveVault = () => !vault || vaultGuard.current?.() !== false;
  const workspace = useDocumentWorkspace(services, !vault && !externalModalOpen && !pendingDelete);
  const { prepareClose: prepareOrdinaryClose, importPayload: importRequestedPayload, hasPendingConversion } = workspace;
  const navigation = useRef({ vault, externalModalOpen, pendingDelete }); navigation.current = { vault, externalModalOpen, pendingDelete };
  const prepareClose = useCallback(async () => {
    setCloseFailure(null);
    if (navigation.current.vault && (!vaultGuard.current || vaultGuard.current() === false)) {
      setCloseFailure("Close cancelled. Protected documents are still open."); return false;
    }
    const allowed = await prepareOrdinaryClose();
    if (!allowed) setCloseFailure("Window kept open. Finish pending work or resolve the recovery error before closing.");
    return allowed;
  }, [prepareOrdinaryClose]);
  useEffect(() => { onPrepareClose?.(prepareClose); return () => onPrepareClose?.(null); }, [onPrepareClose, prepareClose]);
  const incomingHandled = useRef(onIncomingDocumentHandled); incomingHandled.current = onIncomingDocumentHandled;
  const incomingSeen = useRef(new Set<string>()), incomingQueue = useRef<Promise<void>>(Promise.resolve());
  const consumeIncoming = useCallback(async (item: IncomingDocumentRequest, explicit = false) => {
    const protectedScope = navigation.current;
    if (protectedScope.externalModalOpen || protectedScope.pendingDelete || hasPendingConversion()
      || (protectedScope.vault && (!explicit || vaultGuard.current?.() === false))) {
      setPendingIncoming((items) => items.some((pending) => pending.requestId === item.requestId) ? items : [...items, item]); return;
    }
    setVault(false); setShowLibrary(false); setPendingIncoming((items) => items.filter((pending) => pending.requestId !== item.requestId));
    await importRequestedPayload(item.payload);
    incomingHandled.current?.(item.requestId);
  }, [importRequestedPayload, hasPendingConversion]);
  useEffect(() => {
    if (!incomingDocument || incomingSeen.current.has(incomingDocument.requestId)) return;
    incomingSeen.current.add(incomingDocument.requestId);
    incomingQueue.current = incomingQueue.current.catch(() => {}).then(() => consumeIncoming(incomingDocument));
  }, [incomingDocument, consumeIncoming]);
  useEffect(() => {
    if (!newMenu) return;
    const outside = (event: PointerEvent) => { if (!newMenuRoot.current?.contains(event.target as Node)) setNewMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setNewMenu(false); newMenuTrigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [newMenu]);
  const { session } = workspace;
  const dirty = session ? documentNeedsRecoverySave(session) : false;
  const status = workspace.saving ? "Saving recovery…" : dirty ? "Not recovered yet" : session?.externalGeneration === session?.generation && session ? "Saved to file" : "Recovered locally";
  const create = (format: EditableDocumentFormat) => { if (!canLeaveVault()) return; setNewMenu(false); setVault(false); setShowLibrary(false); void workspace.create(format); };
  return <div className={`docs-workspace ${showLibrary ? "show-library" : ""}`} inert={externalModalOpen} onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}>
    <DocumentLibrary records={workspace.records} selectedId={session?.id} loading={!workspace.ready} onOpen={(record) => { if (!canLeaveVault()) return; setVault(false); setShowLibrary(false); void workspace.open(record); }} onImport={() => { if (!canLeaveVault()) return; setVault(false); void workspace.importFile(); }} onVault={() => { if (!vault) void workspace.recoverNow().then(() => setVault(true)); }} onClose={() => setShowLibrary(false)} />
    {showLibrary ? <button type="button" className="docs-library-scrim" aria-label="Dismiss document library" onClick={() => setShowLibrary(false)} /> : null}
    <main className="docs-main" aria-label={vault ? "Protected documents" : "Document workspace"}>
      <header className="docs-header">
        <button type="button" className="docs-mobile-library-toggle" aria-label="Toggle document library" aria-expanded={showLibrary} onClick={() => setShowLibrary(!showLibrary)}>☰</button>
        <div className="docs-header-breadcrumb"><span>{vault ? "Locked vault" : "Your documents"}</span><strong>{vault ? "Private writing" : session?.name ?? "A place for all your writing"}</strong></div>
        <div className="docs-header-actions"><AppearanceMenu /><div ref={newMenuRoot} className="docs-new-wrap"><button ref={newMenuTrigger} type="button" className="docs-primary" onClick={() => setNewMenu(!newMenu)} aria-expanded={newMenu}>＋ New</button>{newMenu ? <div className="docs-new-menu" role="group" aria-label="New document type">{NEW_FORMATS.map((item) => <button type="button" key={item.format} onClick={() => create(item.format)}><span>{item.label}</span><small>{item.detail}</small></button>)}</div> : null}</div>
          {!vault && session ? <><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.saveFile()}>Save file</button><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.saveFile(true)}>Export copy</button><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.share()}>Share</button><button type="button" aria-label="Document details" aria-pressed={showDetails} onClick={() => setShowDetails(!showDetails)}>ⓘ</button></> : null}
          {onExit ? <button type="button" disabled={dirty && session?.externalGeneration !== session?.generation} onClick={() => { if (canLeaveVault()) onExit(); }}>Classic workspace</button> : null}
        </div>
      </header>
      {closeFailure ? <div className="docs-error" role="alert"><span>{closeFailure}</span><button type="button" aria-label="Dismiss close notice" onClick={() => setCloseFailure(null)}>×</button></div> : null}
      {pendingIncoming.length ? <div className="docs-notice docs-incoming"><span>{pendingIncoming[0].payload.name} is waiting to open{pendingIncoming.length > 1 ? ` (${pendingIncoming.length} files)` : ""}.</span><button type="button" onClick={() => { const item = pendingIncoming[0]; incomingQueue.current = incomingQueue.current.catch(() => {}).then(() => consumeIncoming(item, true)); }}>Open requested file</button><button type="button" onClick={() => { const item = pendingIncoming[0]; workspace.discardPayload(item.payload); setPendingIncoming((items) => items.slice(1)); incomingHandled.current?.(item.requestId); }}>Ignore</button></div> : null}
      {vault ? <Suspense fallback={<p className="docs-loading">Opening protected storage…</p>}><VaultPanel onClose={() => setVault(false)} onCloseGuard={setVaultGuard} /></Suspense> : <>
        {workspace.error ? <div className="docs-error" role="alert"><span>{workspace.error}</span><button type="button" aria-label="Dismiss error" onClick={workspace.dismissError}>×</button></div> : null}
        {workspace.notice ? <div className="docs-notice" role="status">{workspace.notice}</div> : null}
        {workspace.busy ? <div className="docs-progress" role="status">{workspace.busy}…</div> : null}
        {session ? <>
          {session.warnings.length ? <div className="docs-warning">{session.warnings.join(" ")}</div> : null}
          {showDetails ? <section className="docs-details" aria-label="Document organization" key={session.id}>
            <label>Name<input key={`${session.id}-name`} defaultValue={session.name} onBlur={(event) => { const next = workspace.changeDetails({ name: event.target.value }); event.currentTarget.value = next?.name ?? session.name; }} /></label>
            <label>Tags, comma separated<input key={`${session.id}-tags`} defaultValue={session.tags.join(", ")} onBlur={(event) => workspace.changeDetails({ tags: event.target.value.split(",") })} /></label>
            <label>Collection<input key={`${session.id}-collection`} defaultValue={session.collection ?? ""} onBlur={(event) => workspace.changeDetails({ collection: event.target.value })} placeholder="Uncollected" /></label>
            <button type="button" disabled={!session.record || !!workspace.busy} onClick={() => void workspace.showRecovery()}>Recovery history</button><button type="button" onClick={() => void workspace.copy()}>Copy text</button><button type="button" disabled={!session.record || !!workspace.busy} onClick={() => setPendingDelete(session.record)}>Remove from library</button>
          </section> : null}
          {workspace.recovery ? <section className="docs-recovery" aria-label="Recovery history"><div><strong>Recovery history</strong><button type="button" onClick={workspace.closeRecovery}>Close</button></div><p>Restoring makes a new local revision. Your external file stays unchanged.</p>{workspace.recovery.length ? workspace.recovery.map((entry) => <button type="button" key={entry.revision} disabled={!!workspace.busy} onClick={() => void workspace.restore(entry.revision)}>Restore revision {entry.revision} <span>{new Date(entry.savedAt).toLocaleString()}</span></button>) : <p>No earlier recovery revisions yet.</p>}</section> : null}
          <div className="docs-editor-area">{session.office ? <WordDocumentEditor key={session.epoch} document={session.office} readOnly={!!workspace.busy || externalModalOpen} onChange={workspace.changeOffice} /> : <TextDocumentEditor key={session.epoch} session={session} readOnly={!!workspace.busy || externalModalOpen} onChange={workspace.changeText} onRestoreText={workspace.restoreText} onFlushReady={workspace.setFlush} />}</div>
          <footer className="docs-status"><span role="status">{status}</span><span>{session.text.trim() ? session.text.trim().split(/\s+/).length : 0} words · {session.format.toUpperCase()}{session.text.length > 1024 * 1024 ? " · First 1M characters searchable" : ""}</span><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.recoverNow()}>Recover now</button></footer>
        </> : <section className="docs-welcome"><span className="docs-welcome-glyph" aria-hidden="true">M</span><p className="docs-eyebrow">YOUR WORDS, IN ONE PLACE</p><h1>Make room for your next idea.</h1><p>Documents, notes and working copy.<br />Local first. Ready when you are.</p><div><button type="button" className="docs-primary" onClick={() => create("docx")}>New Word document</button><button type="button" onClick={() => void workspace.importFile()}>Import a file</button></div><small>DOCX · Markdown · Text · CSV · JSON · YAML · XML<br />DOC, RTF, HTML and ODT can import as text-only copies.</small></section>}
      </>}
    </main>
    {pendingDelete ? <ConfirmDocumentRemoval name={pendingDelete.name} onCancel={() => setPendingDelete(null)} onRemove={() => { const record = pendingDelete; setPendingDelete(null); void workspace.remove(record); }} /> : null}
    {workspace.conversion ? <ConfirmDocumentConversion name={workspace.conversion.name} format={workspace.conversion.format.kind} onCancel={workspace.cancelConversion} onConvert={() => void workspace.confirmConversion()} /> : null}
  </div>;
}
