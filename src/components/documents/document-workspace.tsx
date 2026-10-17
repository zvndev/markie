import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { LibraryRecord } from "@/lib/document-library";
import type { DocumentShellState } from "@/lib/document-shell";
import type { DocumentCommandTarget } from "@/lib/document-commands";
import { documentNeedsRecoverySave, type EditableDocumentFormat } from "@/lib/document-session";
import type { WebDocumentPayload } from "@/lib/web-files";
import { DocumentLibrary } from "./document-library";
import { TextDocumentEditor } from "./text-document-editor";
import { WordDocumentEditor } from "./word-document-editor";
import { useDocumentWorkspace, type DocumentWorkspaceServices } from "./use-document-workspace";
import { AppearanceMenu } from "./appearance-menu";
import { ConfirmDocumentRemoval } from "./confirm-document-removal";
import { ConfirmDocumentConversion } from "./confirm-document-conversion";
import { DOCUMENT_OUTPUT_LIMITS, useDocumentOutput } from "./use-document-output";
import "./document-workspace.css";

const VaultPanel = lazy(() => import("./vault-panel").then((module) => ({ default: module.VaultPanel })));
export interface IncomingDocumentRequest { requestId: string; payload: WebDocumentPayload }
export interface DocumentWorkspaceProps extends DocumentWorkspaceServices {
  externalModalOpen?: boolean;
  embedded?: boolean;
  active?: boolean;
  onShellChange?: (state: DocumentShellState | null) => void;
  incomingDocument?: IncomingDocumentRequest | null;
  /** Consumed requests explicitly distinguish imported files from safe errors/conversion prompts. */
  onIncomingDocumentHandled?: (requestId: string, imported: boolean) => void;
  onPrepareClose?: (prepare: (() => Promise<boolean>) | null) => void;
}
const NEW_FORMATS: { format: EditableDocumentFormat; label: string; detail: string }[] = [
  { format: "docx", label: "Word document", detail: ".docx" }, { format: "text", label: "Plain text", detail: ".txt" },
  { format: "markdown", label: "Markdown", detail: ".md" }, { format: "csv", label: "CSV table", detail: ".csv" },
  { format: "json", label: "JSON", detail: ".json" }, { format: "yaml", label: "YAML", detail: ".yaml" }, { format: "xml", label: "XML", detail: ".xml" },
];
export function DocumentWorkspace({ embedded = false, active = true, onShellChange, externalModalOpen = false, incomingDocument, onIncomingDocumentHandled, onPrepareClose, ...services }: DocumentWorkspaceProps) {
  const [vault, setVault] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showLibrary, setShowLibrary] = useState(() => typeof window === "undefined" || window.innerWidth > 650);
  const [pendingDelete, setPendingDelete] = useState<LibraryRecord | null>(null);
  const [pendingIncoming, setPendingIncoming] = useState<IncomingDocumentRequest[]>([]);
  const [closeFailure, setCloseFailure] = useState<string | null>(null);
  const [editorCommands, setEditorCommands] = useState<DocumentCommandTarget | null>(null);
  const outputHost = useRef<HTMLDivElement>(null), outputInFlight = useRef<(() => boolean) | null>(null);
  const registerEditorCommands = useCallback((target: DocumentCommandTarget | null) => setEditorCommands(target), []);
  const vaultGuard = useRef<(() => boolean) | null>(null);
  const newMenuRoot = useRef<HTMLDivElement>(null), newMenuTrigger = useRef<HTMLButtonElement>(null);
  const setVaultGuard = useCallback((guard: (() => boolean) | null) => { vaultGuard.current = guard; }, []);
  const canLeaveVault = () => !vault || vaultGuard.current?.() === true;
  const workspace = useDocumentWorkspace(services, active && !vault && !externalModalOpen && !pendingDelete && !editorCommands?.modalOpen && !outputInFlight.current?.());
  const { prepareClose: prepareOrdinaryClose, importPayload: importRequestedPayload, hasPendingConversion, showRecovery } = workspace;
  const showDocumentHistory = useCallback(() => { void showRecovery(); }, [showRecovery]);
  const navigation = useRef({ vault, externalModalOpen, pendingDelete, toolModal: !!editorCommands?.modalOpen }); navigation.current = { vault, externalModalOpen, pendingDelete, toolModal: !!editorCommands?.modalOpen };
  const prepareClose = useCallback(async () => {
    setCloseFailure(null);
    if (outputInFlight.current?.()) { setCloseFailure("Finish or cancel document output before closing."); return false; }
    if (navigation.current.toolModal) { setCloseFailure("Finish or close the document tool before closing."); return false; }
    if (navigation.current.pendingDelete) {
      setCloseFailure("Finish or cancel document removal before leaving."); return false;
    }
    if (navigation.current.vault && (!vaultGuard.current || vaultGuard.current() === false)) {
      setCloseFailure("Close cancelled. Protected documents are still open."); return false;
    }
    const allowed = await prepareOrdinaryClose();
    if (!allowed) setCloseFailure("Window kept open. Finish pending work or resolve the recovery error before closing.");
    return allowed;
  }, [prepareOrdinaryClose]);
  const prepareLeave = useCallback(async () => {
    if (!await prepareClose()) return false;
    // The document pane stays mounted behind Markdown. Private state must not:
    // unmounting the vault runs its key, plaintext and download-URL cleanup.
    navigation.current.vault = false;
    setVault(false);
    return true;
  }, [prepareClose]);
  useEffect(() => { onPrepareClose?.(prepareClose); return () => onPrepareClose?.(null); }, [onPrepareClose, prepareClose]);
  const incomingHandled = useRef(onIncomingDocumentHandled); incomingHandled.current = onIncomingDocumentHandled;
  const incomingSeen = useRef(new Set<string>()), incomingQueue = useRef<Promise<void>>(Promise.resolve());
  const consumeIncoming = useCallback(async (item: IncomingDocumentRequest, explicit = false) => {
    const protectedScope = navigation.current;
    if (outputInFlight.current?.() || protectedScope.externalModalOpen || protectedScope.pendingDelete || protectedScope.toolModal || hasPendingConversion()
      || (protectedScope.vault && (!explicit || vaultGuard.current?.() !== true))) {
      setPendingIncoming((items) => items.some((pending) => pending.requestId === item.requestId) ? items : [...items, item]); return;
    }
    setVault(false); setShowLibrary(false); setPendingIncoming((items) => items.filter((pending) => pending.requestId !== item.requestId));
    const imported = await importRequestedPayload(item.payload);
    incomingHandled.current?.(item.requestId, imported);
  }, [importRequestedPayload, hasPendingConversion]);
  useEffect(() => {
    if (!incomingDocument || incomingSeen.current.has(incomingDocument.requestId)) return;
    incomingSeen.current.add(incomingDocument.requestId);
    incomingQueue.current = incomingQueue.current.catch(() => {}).then(() => consumeIncoming(incomingDocument));
  }, [incomingDocument, consumeIncoming]);
  useEffect(() => {
    if (!newMenu || !active) return;
    const outside = (event: PointerEvent) => { if (!newMenuRoot.current?.contains(event.target as Node)) setNewMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setNewMenu(false); newMenuTrigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [newMenu, active]);
  const { session } = workspace;
  const sessionName = session?.name ?? null, selectedId = session?.id, hasSession = !!session;
  const officeRenderer = !!session?.office, hasHistory = !!session?.record;
  const dirty = session ? documentNeedsRecoverySave(session) : false;
  const fileDirty = !vault && !!session && session.externalGeneration !== session.generation;
  const status = workspace.saving ? "Saving recovery…" : dirty ? "Not recovered yet" : session?.externalGeneration === session?.generation && session ? "Saved to file" : "Recovered locally";
  const blocked = !!workspace.busy || externalModalOpen || !!pendingDelete || !!workspace.conversion || !!editorCommands?.modalOpen;
  const output = useDocumentOutput({ session, captureSession: workspace.captureSession, isBlocked: () => vault || blocked || workspace.isBusy() || !active || !outputHost.current || !!outputHost.current.closest("[inert]") || !!outputHost.current.querySelector('[data-word-composing="true"], [role="dialog"], [aria-modal="true"]') });
  outputInFlight.current = output.isBusy;
  const actionsBlocked = blocked || output.busy;
  const create = (format: EditableDocumentFormat) => { if (blocked || output.isBusy() || !canLeaveVault()) return; setNewMenu(false); setVault(false); setShowLibrary(false); void workspace.create(format); };
  const open = (record: LibraryRecord) => { if (blocked || output.isBusy() || !canLeaveVault()) return; setVault(false); setShowLibrary(false); void workspace.open(record); };
  const importFile = () => { if (blocked || output.isBusy() || !canLeaveVault()) return; setVault(false); void workspace.importFile(); };
  const showVault = () => { if (!blocked && !output.isBusy() && !vault) void workspace.recoverNow().then(() => { if (!output.isBusy()) setVault(true); }); };
  const actions = useRef({ create, open, importFile, showVault, workspace, blocked: actionsBlocked, output });
  actions.current = { create, open, importFile, showVault, workspace, blocked: actionsBlocked, output };
  const shellChanged = useRef(onShellChange); shellChanged.current = onShellChange;
  useEffect(() => {
    shellChanged.current?.({
      name: vault ? "Protected documents" : sessionName, dirty: fileDirty, hasSession,
      private: vault, ready: workspace.ready, busy: actionsBlocked,
      records: workspace.records, selectedId, renderer: vault ? "none" : officeRenderer ? "word" : hasSession ? "text" : "none",
      commands: {
        modalOpen: !!editorCommands?.modalOpen,
        enabledCommands: !vault && !actionsBlocked && active && hasSession ? [...new Set(["document-details", ...(hasHistory ? ["document-history"] : []), ...(output.eligible ? ["document-print", "document-export-pdf"] : []), ...(editorCommands?.enabledCommands ?? [])])] : [],
        execute: (command) => {
          if (navigation.current.vault || actions.current.blocked || !active) return;
          if (command === "document-print" || command === "document-export-pdf") void actions.current.output.execute(command);
          else if (command === "document-details") setShowDetails((shown) => !shown);
          else if (command === "document-history") void actions.current.workspace.showRecovery();
          else editorCommands?.execute(command);
        },
      },
      create: (format) => actions.current.create(format), open: (record) => actions.current.open(record),
      importFile: () => actions.current.importFile(), save: (asCopy) => { if (!navigation.current.vault && !actions.current.blocked) void actions.current.workspace.saveFile(asCopy); },
      share: () => { if (!navigation.current.vault && !actions.current.blocked) void actions.current.workspace.share(); }, showVault: () => actions.current.showVault(),
      prepareClose, prepareLeave,
    });
  }, [vault, fileDirty, selectedId, sessionName, hasSession, officeRenderer, hasHistory, workspace.ready, actionsBlocked, output.eligible, workspace.records, prepareClose, prepareLeave, onShellChange, editorCommands, active]);
  useEffect(() => () => shellChanged.current?.(null), []);
  const Content = embedded ? "section" : "main";
  return <div ref={outputHost} className={`docs-workspace ${embedded ? "docs-workspace-embedded" : showLibrary ? "show-library" : ""}`} inert={externalModalOpen || !active} onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}>
    {!embedded ? <DocumentLibrary records={workspace.records} selectedId={session?.id} loading={!workspace.ready} onOpen={open} onImport={importFile} onVault={showVault} onClose={() => setShowLibrary(false)} /> : null}
    {!embedded && showLibrary ? <button type="button" className="docs-library-scrim" aria-label="Dismiss document library" onClick={() => setShowLibrary(false)} /> : null}
    <Content className="docs-main" aria-label={vault ? "Protected documents" : "Document workspace"}>
      {!embedded ? <header className="docs-header" inert={output.busy}>
        <button type="button" className="docs-mobile-library-toggle" aria-label="Toggle document library" aria-expanded={showLibrary} onClick={() => setShowLibrary(!showLibrary)}>☰</button>
        <div className="docs-header-breadcrumb"><span>{vault ? "Locked vault" : "Your documents"}</span><strong>{vault ? "Private writing" : session?.name ?? "A place for all your writing"}</strong></div>
        <div className="docs-header-actions"><AppearanceMenu /><div ref={newMenuRoot} className="docs-new-wrap"><button ref={newMenuTrigger} type="button" className="docs-primary" onClick={() => setNewMenu(!newMenu)} aria-expanded={newMenu}>＋ New</button>{newMenu ? <div className="docs-new-menu" role="group" aria-label="New document type">{NEW_FORMATS.map((item) => <button type="button" key={item.format} onClick={() => create(item.format)}><span>{item.label}</span><small>{item.detail}</small></button>)}</div> : null}</div>
          {!vault && session ? <><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.saveFile()}>Save file</button><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.saveFile(true)}>Export copy</button><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.share()}>Share</button><button type="button" aria-label="Document details" aria-pressed={showDetails} onClick={() => setShowDetails(!showDetails)}>ⓘ</button></> : null}
        </div>
      </header> : null}
      {closeFailure ? <div className="docs-error" role="alert"><span>{closeFailure}</span><button type="button" aria-label="Dismiss close notice" onClick={() => setCloseFailure(null)}>×</button></div> : null}
      {pendingIncoming.length ? <div className="docs-notice docs-incoming"><span>{pendingIncoming[0].payload.name} is waiting to open{pendingIncoming.length > 1 ? ` (${pendingIncoming.length} files)` : ""}.</span><button type="button" onClick={() => { const item = pendingIncoming[0]; incomingQueue.current = incomingQueue.current.catch(() => {}).then(() => consumeIncoming(item, true)); }}>Open requested file</button><button type="button" onClick={() => { const item = pendingIncoming[0]; workspace.discardPayload(item.payload); setPendingIncoming((items) => items.slice(1)); incomingHandled.current?.(item.requestId, false); }}>Ignore</button></div> : null}
      {vault ? <Suspense fallback={<p className="docs-loading">Opening protected storage…</p>}><VaultPanel onClose={() => setVault(false)} onCloseGuard={setVaultGuard} /></Suspense> : <>
        {workspace.error ? <div className="docs-error" role="alert"><span>{workspace.error}</span><button type="button" aria-label="Dismiss error" onClick={workspace.dismissError}>×</button></div> : null}
        {workspace.notice ? <div className="docs-notice" role="status">{workspace.notice}</div> : null}
        {output.error ? <div className="docs-error" role="alert">{output.error}</div> : null}
        {output.notice ? <div className="docs-notice" role="status">{output.notice}</div> : null}
        {output.busy ? <div className="docs-progress" role="status">Preparing document output…</div> : null}
        {workspace.busy ? <div className="docs-progress" role="status">{workspace.busy}…</div> : null}
        {session ? <>
          {session.office ? <div className="docs-notice">{session.office.format !== "docx" ? `${session.office.format.toUpperCase()} supports basic rich-text editing and same-format saves. Complex content, cloud sharing and print/PDF are not available in this subset.` : output.eligible ? DOCUMENT_OUTPUT_LIMITS : "Print and PDF are unavailable for unsupported document features or pending revisions. Resolve revisions before printing; you can still export the original Word file."}</div> : null}
          {session.warnings.length ? <div className="docs-warning">{session.warnings.join(" ")}</div> : null}
          {showDetails ? <section className="docs-details" aria-label="Document organization" key={session.id} inert={output.busy}>
            <label>Name<input key={`${session.id}-name`} defaultValue={session.name} onBlur={(event) => { const next = workspace.changeDetails({ name: event.target.value }); event.currentTarget.value = next?.name ?? session.name; }} /></label>
            <label>Tags, comma separated<input key={`${session.id}-tags`} defaultValue={session.tags.join(", ")} onBlur={(event) => workspace.changeDetails({ tags: event.target.value.split(",") })} /></label>
            <label>Collection<input key={`${session.id}-collection`} defaultValue={session.collection ?? ""} onBlur={(event) => workspace.changeDetails({ collection: event.target.value })} placeholder="Uncollected" /></label>
            <button type="button" disabled={!session.record || !!workspace.busy} onClick={() => void workspace.showRecovery()}>Recovery history</button><button type="button" onClick={() => void workspace.copy()}>Copy text</button><button type="button" disabled={!session.record || !!workspace.busy} onClick={() => setPendingDelete(session.record)}>Remove from library</button>
          </section> : null}
          {workspace.recovery ? <section className="docs-recovery" aria-label="Recovery history" inert={output.busy}><div><strong>Recovery history</strong><button type="button" onClick={workspace.closeRecovery}>Close</button></div><p>Restoring makes a new local revision. Your external file stays unchanged.</p>{workspace.recovery.length ? workspace.recovery.map((entry) => <button type="button" key={entry.revision} disabled={!!workspace.busy} onClick={() => void workspace.restore(entry.revision)}>Restore revision {entry.revision} <span>{new Date(entry.savedAt).toLocaleString()}</span></button>) : <p>No earlier recovery revisions yet.</p>}</section> : null}
          <div className="docs-editor-area">{session.office ? <WordDocumentEditor key={session.epoch} document={session.office} readOnly={!!workspace.busy || output.busy || externalModalOpen || !active} isReadOnly={output.isBusy} onChange={workspace.changeOffice} onCommandsReady={registerEditorCommands} onHistory={hasHistory ? showDocumentHistory : undefined} /> : <TextDocumentEditor key={session.epoch} session={session} readOnly={!!workspace.busy || output.busy || externalModalOpen || !active} onChange={workspace.changeText} onRestoreText={workspace.restoreText} onFlushReady={workspace.setFlush} onCommandsReady={registerEditorCommands} />}</div>
          <footer className="docs-status"><span role="status">{status}</span><span>{session.text.trim() ? session.text.trim().split(/\s+/).length : 0} words · {session.format.toUpperCase()}{session.text.length > 1024 * 1024 ? " · First 1M characters searchable" : ""}</span><button type="button" disabled={!!workspace.busy} onClick={() => void workspace.recoverNow()}>Recover now</button></footer>
        </> : embedded ? <section className="docs-empty-editor" aria-label="Document editor"><p>Open a document or create one from Markie’s toolbar.</p></section> : <section className="docs-welcome"><span className="docs-welcome-glyph" aria-hidden="true">M</span><p className="docs-eyebrow">YOUR WORDS, IN ONE PLACE</p><h1>Make room for your next idea.</h1><p>Documents, notes and working copy.<br />Local first. Ready when you are.</p><div><button type="button" className="docs-primary" onClick={() => create("docx")}>New Word document</button><button type="button" onClick={importFile}>Import a file</button></div><small>DOCX · RTF · ODT · Markdown · Text · CSV · JSON · YAML · XML<br />Legacy DOC and HTML import as text-only copies.</small></section>}
      </>}
    </Content>
    {pendingDelete ? <ConfirmDocumentRemoval name={pendingDelete.name} onCancel={() => setPendingDelete(null)} onRemove={() => { const record = pendingDelete; setPendingDelete(null); void workspace.remove(record); }} /> : null}
    {workspace.conversion ? <ConfirmDocumentConversion name={workspace.conversion.name} format={workspace.conversion.format.kind} onCancel={workspace.cancelConversion} onConvert={() => void workspace.confirmConversion()} /> : null}
  </div>;
}
