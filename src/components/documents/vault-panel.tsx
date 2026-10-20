import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VaultRepository, VaultSaveError, type VaultEntry, type VaultReadResult } from "@/lib/vault/repository";
import { IndexedDbVaultStorage, VaultStorageError, type VaultStorage } from "@/lib/vault/storage";
import { VAULT_LIMITS, VaultError } from "@/lib/vault";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument, type DecodedTextDocument } from "@/lib/document-formats";
import { pickWebDocument, safeWebFileName } from "@/lib/web-files";
import { exportDocx, openDocx, replaceDocxText, type DocxDocument } from "@/lib/office/docx";
import { isEnvFileName } from "@/lib/vault/dotenv";
import { KeyIcon, normalizeTypedNewlines, VaultEnvEditor } from "./vault-env-editor";

export interface VaultPanelProps {
  storage?: VaultStorage;
  /** Unused: the vault is a page left through the navigation rail, guarded by onCloseGuard. Kept so callers compile. */
  onClose?: () => void;
  /** Parent navigation must call this guard before unmounting the private editor. */
  onCloseGuard?: (guard: (() => boolean) | null) => void;
}

type SecureDocument = {
  id: string | null;
  name: string;
  originalName: string;
  mediaType: string;
  bytes: Uint8Array;
  dirty: boolean;
} & ({ kind: "text"; text: string; source: DecodedTextDocument } | { kind: "docx"; document: DocxDocument } | { kind: "opaque" });

const IDLE_LOCK_MS = 5 * 60 * 1000;
const CHECKPOINT_MS = 2000;
const button = "rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-40";
const field = "w-full rounded-md border border-border bg-background px-3 py-2 text-foreground";

function failureCopy(failure: unknown): string {
  if (failure instanceof VaultSaveError) return failureCopy(failure.failure);
  if (failure instanceof VaultError) {
    if (failure.code === "authentication-failed") return "The passphrase is incorrect or the vault was altered. Nothing was opened.";
    if (failure.code === "invalid-passphrase") return "Use a strong passphrase of at least 16 characters, not a short PIN.";
    if (failure.code === "limit-exceeded") return "This file exceeds the vault's 8 MiB file limit.";
    if (failure.code === "locked") return "The vault locked before the operation completed.";
  }
  if (failure instanceof VaultStorageError) {
    if (failure.code === "quota") return "Browser storage is full. Edits remain unsaved; free space and retry. Encrypted recovery lasts only in this tab.";
    if (failure.code === "conflict") return "Another window changed the vault. Your edits are still here; export a copy before locking and reopening.";
    if (failure.code === "unavailable") return "Encrypted browser storage is unavailable. No fallback or plaintext copy was saved.";
  }
  return "The operation could not complete. Your current edits were not cleared. No plaintext fallback was saved.";
}

/** Dotenv names are text here even though the shared document formats do not classify them yet. */
function formatOf(name: string): { representation: "text" | "bytes"; kind: string } {
  return isEnvFileName(name) ? { representation: "text", kind: "env" } : classifyDocumentFormat(name);
}

const ENV_MEDIA_TYPE = "text/plain";

async function editableDocument(id: string | null, value: VaultReadResult): Promise<SecureDocument> {
  const base = { id, name: value.metadata.name, originalName: value.metadata.name, mediaType: value.metadata.mediaType, bytes: value.bytes, dirty: value.recovery };
  const format = formatOf(base.name);
  try {
    if (format.representation === "text") {
      const source = decodeTextDocument(base.bytes);
      return { ...base, kind: "text", source, text: source.text };
    }
    if (format.kind === "docx") return { ...base, kind: "docx", document: await openDocx(base.bytes) };
  } catch { /* The authenticated original stays available as an opaque download-only file. */ }
  return { ...base, kind: "opaque" };
}

async function documentBytes(document: SecureDocument): Promise<Uint8Array> {
  if (document.kind === "text") return encodeTextDocument(document.text, document.source);
  if (document.kind === "docx") return exportDocx(document.document);
  return new Uint8Array(document.bytes);
}

function validFilename(document: SecureDocument): boolean {
  const original = formatOf(document.originalName);
  const next = formatOf(document.name);
  return document.name.length > 0 && safeWebFileName(document.name) === document.name && original.representation === next.representation &&
    (original.representation !== "bytes" || original.kind === next.kind);
}

/** An isolated local vault. Never returns plaintext to the ordinary workspace. */
export function VaultPanel({ storage, onCloseGuard }: VaultPanelProps) {
  const repository = useMemo(() => new VaultRepository(storage ?? new IndexedDbVaultStorage()), [storage]);
  const [hasVault, setHasVault] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(true);
  const [shielded, setShielded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<SecureDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Checking encrypted storage…");
  const mounted = useRef(true);
  const operation = useRef(0);
  const invalidateOperations = useCallback(() => { operation.current++; }, []);
  const openedRef = useRef(opened);
  const shieldRef = useRef(false);
  const urls = useRef(new Set<string>());
  openedRef.current = opened;

  const revokeDownloads = useCallback(() => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  const lockNow = useCallback((message: string) => {
    ++operation.current;
    repository.lock();
    openedRef.current?.bytes.fill(0);
    openedRef.current = null;
    revokeDownloads();
    shieldRef.current = false;
    if (!mounted.current) return;
    setOpened(null);
    setEntries([]);
    setQuery("");
    setPassphrase("");
    setConfirmation("");
    setError(null);
    setLocked(true);
    setShielded(false);
    setBusy(false);
    setNotice(message);
  }, [repository, revokeDownloads]);

  const requestClose = useCallback(() => {
    if ((openedRef.current?.dirty || repository.hasVolatileRecovery) && !window.confirm("Leave the vault and discard unsaved edits or encrypted memory-only recovery? Save encrypted changes first to keep them.")) return false;
    lockNow("Vault locked.");
    return true;
  }, [repository, lockNow]);

  useEffect(() => {
    onCloseGuard?.(requestClose);
    return () => onCloseGuard?.(null);
  }, [onCloseGuard, requestClose]);

  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (openedRef.current?.dirty || repository.hasVolatileRecovery) event.preventDefault();
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [repository]);

  useEffect(() => {
    mounted.current = true;
    repository.inspect().then((exists) => {
      if (mounted.current) { setHasVault(exists); setNotice(exists ? "Your vault is locked." : "Create a separate encrypted local vault."); }
    }, (failure) => { if (mounted.current) setError(failureCopy(failure)); });
    return () => {
      mounted.current = false;
      invalidateOperations();
      repository.lock();
      openedRef.current?.bytes.fill(0);
      openedRef.current = null;
      revokeDownloads();
    };
  }, [repository, revokeDownloads, invalidateOperations]);

  async function run(action: () => Promise<void>) {
    const ticket = ++operation.current;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { if (mounted.current && ticket === operation.current) setError(failureCopy(failure)); }
    finally { if (mounted.current && ticket === operation.current) setBusy(false); }
  }

  function mayDiscard(): boolean {
    return !opened?.dirty || window.confirm("Discard unsaved private edits? Save encrypted changes first to keep them.");
  }

  function replaceOpened(next: SecureDocument | null) {
    openedRef.current?.bytes.fill(0);
    openedRef.current = next;
    setOpened(next);
  }

  function authenticate() {
    if (hasVault === false && passphrase !== confirmation) { setError("The passphrases do not match."); return; }
    const secret = passphrase;
    setPassphrase("");
    setConfirmation("");
    const epoch = operation.current + 1;
    void run(async () => {
      try {
        if (hasVault) await repository.unlock(secret); else await repository.create(secret);
        const listed = await repository.list();
        if (epoch !== operation.current || !mounted.current || shieldRef.current) return;
        setHasVault(true);
        if (window.document.visibilityState === "hidden") { lockNow("Vault locked because this page is hidden."); return; }
        setLocked(false);
        setEntries(listed);
        setNotice(repository.hasVolatileRecovery ? "Encrypted recovery is available only in this tab. Open it and save again before closing." : "Unlocked locally. No account, cloud upload or global indexing.");
      } catch (failure) {
        // A valid header with a tampered record must not leave hidden unlocked keys behind.
        repository.lock();
        throw failure;
      }
    });
  }

  async function refreshEntries(epoch: number) {
    const listed = await repository.list();
    if (epoch === operation.current && mounted.current && !shieldRef.current) setEntries(listed);
  }

  function choose(entry: VaultEntry) {
    if (!mayDiscard()) return;
    const epoch = operation.current + 1;
    void run(async () => {
      const decrypted = await repository.read(entry.id);
      const next = await editableDocument(entry.id, decrypted);
      if (epoch !== operation.current || !mounted.current || shieldRef.current) { next.bytes.fill(0); return; }
      if (opened?.id && opened.id !== entry.id) repository.discardRecovery(opened.id);
      replaceOpened(next);
      setNotice(next.dirty ? "Recovered unsaved encrypted edits. Save encrypted changes to make them durable." : "Decrypted only inside this vault panel.");
    });
  }

  function importFile() {
    if (!mayDiscard()) return;
    // Any file: env files (.env, .env.local) are not document types elsewhere
    // in Markie, on purpose, but the vault is exactly where they belong.
    const picking = pickWebDocument({ maxBytes: VAULT_LIMITS.contentBytes, anyFile: true });
    const epoch = operation.current + 1;
    void run(async () => {
      const file = await picking;
      if (!file) return;
      try {
        if (epoch !== operation.current || shieldRef.current) return;
        const id = await repository.save(null, file.bytes, { name: file.name, mediaType: isEnvFileName(file.name) ? ENV_MEDIA_TYPE : file.format.mimeType });
        const next = await editableDocument(id, await repository.read(id));
        if (epoch !== operation.current || !mounted.current || shieldRef.current) { next.bytes.fill(0); return; }
        replaceOpened(next);
        await refreshEntries(epoch);
        setNotice("Encrypted copy saved. The original file still exists outside the vault.");
      } finally { file.bytes.fill(0); }
    });
  }

  function save() {
    if (!opened || busy || shieldRef.current) return;
    if (!validFilename(opened)) { setError("Choose a filename with the original file type. Changing extensions needs conversion."); return; }
    const snapshot = opened;
    const epoch = operation.current + 1;
    void run(async () => {
      const bytes = await documentBytes(snapshot);
      try {
        const id = await repository.save(snapshot.id, bytes, { name: snapshot.name, mediaType: snapshot.mediaType });
        if (epoch !== operation.current || !mounted.current || shieldRef.current) return;
        replaceOpened({ ...snapshot, id, originalName: snapshot.name, bytes: new Uint8Array(bytes), dirty: false });
        await refreshEntries(epoch);
        setNotice("Encrypted changes committed to this browser's local vault.");
      } catch (failure) {
        if (failure instanceof VaultSaveError && epoch === operation.current && mounted.current && !shieldRef.current) {
          setOpened({ ...snapshot, id: failure.documentId });
        }
        throw failure;
      } finally { bytes.fill(0); }
    });
  }

  const saveLatest = useRef(save);
  saveLatest.current = save;
  useEffect(() => {
    const saveKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        saveLatest.current();
      }
    };
    window.addEventListener("keydown", saveKey);
    return () => window.removeEventListener("keydown", saveKey);
  }, []);

  async function exportDecrypted() {
    if (!opened) return;
    if (!validFilename(opened)) { setError("Choose a filename with the original file type before exporting."); return; }
    if (!window.confirm("Download an unencrypted copy? That copy is outside the vault and is not protected by its passphrase.")) return;
    const snapshot = opened;
    const epoch = operation.current + 1;
    void run(async () => {
      const bytes = await documentBytes(snapshot);
      try {
        if (epoch !== operation.current || shieldRef.current) return;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
        urls.current.add(url);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = safeWebFileName(snapshot.name);
        anchor.hidden = true;
        window.document.body.append(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
        setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
        setNotice("Unencrypted download started. Downloads and clipboard copies are outside the vault; unsaved edits stay unsaved.");
      } finally { bytes.fill(0); }
    });
  }

  useEffect(() => {
    if (locked) return;
    let idle: ReturnType<typeof setTimeout>;
    let checkpoint: ReturnType<typeof setTimeout> | undefined;
    const automaticLock = () => {
      if (shieldRef.current) return;
      shieldRef.current = true;
      const ticket = ++operation.current;
      const snapshot = openedRef.current;
      revokeDownloads();
      setShielded(true);
      setBusy(true);
      setPassphrase("");
      setConfirmation("");
      checkpoint = setTimeout(() => {
        if (ticket === operation.current) lockNow("Locked after the checkpoint time limit. The last saved copy is retained; check encrypted recovery after unlocking.");
      }, CHECKPOINT_MS);
      void (async () => {
        let failed = false;
        try {
          if (snapshot?.dirty) {
            const bytes = await documentBytes(snapshot);
            // An unfinished rename must not prevent a body checkpoint or mislabel the saved bytes.
            try { if (ticket === operation.current) await repository.save(snapshot.id, bytes, { name: validFilename(snapshot) ? snapshot.name : snapshot.originalName, mediaType: snapshot.mediaType }); }
            finally { bytes.fill(0); }
          }
        } catch { failed = true; }
        finally {
          if (checkpoint) clearTimeout(checkpoint);
          if (ticket === operation.current) lockNow(failed
            ? repository.hasVolatileRecovery ? "Locked. Latest edits are encrypted in memory only; unlock and save again before closing this tab." : "Locked. The latest checkpoint failed; the last durable saved copy remains."
            : "Automatically locked. Encrypted changes were checkpointed before releasing the key.");
        }
      })();
    };
    const arm = () => { clearTimeout(idle); idle = setTimeout(automaticLock, IDLE_LOCK_MS); };
    const hidden = () => { if (window.document.visibilityState === "hidden") automaticLock(); };
    arm();
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("keydown", arm);
    window.document.addEventListener("visibilitychange", hidden);
    return () => {
      clearTimeout(idle);
      if (checkpoint) clearTimeout(checkpoint);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
      window.document.removeEventListener("visibilitychange", hidden);
    };
  }, [locked, lockNow, repository, revokeDownloads]);

  function createUntitled(name: string) {
    if (!mayDiscard()) return;
    replaceOpened({ id: null, name, originalName: name, mediaType: isEnvFileName(name) ? ENV_MEDIA_TYPE : "text/plain", bytes: new Uint8Array(), dirty: true,
      kind: "text", text: "", source: { text: "", encoding: "utf-8", bom: false, newline: "none" } });
  }

  const visibleEntries = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const groups = [
    { label: "Environment keys", icon: <KeyIcon />, items: visibleEntries.filter((entry) => isEnvFileName(entry.name)) },
    { label: "Files", icon: <FileIcon />, items: visibleEntries.filter((entry) => !isEnvFileName(entry.name)) },
  ];
  const envOpened = opened?.kind === "text" && isEnvFileName(opened.originalName) ? opened : null;

  return <section aria-label="Encrypted local vault" className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex items-start gap-3 border-b border-border px-5 py-4 sm:px-7">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted"><LockIcon /></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold leading-tight">Vault</h2>
        <p role="status" className="mt-0.5 text-sm text-muted">{shielded ? "Securing last edits and locking…" : notice}</p>
      </div>
      {!locked && !shielded && <button className={button} type="button" onClick={() => { if (mayDiscard()) lockNow("Vault locked. Plaintext has been removed from this panel."); }}>Lock vault</button>}
    </header>
    {error && <p role="alert" className="mx-5 mt-4 rounded-md border border-border p-3 text-sm sm:mx-7">{error}</p>}
    {locked || shielded ? <div className="min-h-0 flex-1 overflow-auto p-5 sm:p-7">
      <div className="mx-auto mt-[6vh] max-w-md space-y-4 rounded-lg border border-border bg-surface p-6">
        <p className="text-xs tracking-widest uppercase text-muted">Private on this device</p>
        {!shielded && hasVault !== null && <form onSubmit={(event) => { event.preventDefault(); authenticate(); }} className="space-y-4">
          <label className="block text-sm">Vault passphrase<input type="password" autoComplete="off" value={passphrase} maxLength={1024} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className={`${field} mt-2`} /></label>
          {!hasVault && <label className="block text-sm">Confirm passphrase<input type="password" autoComplete="off" value={confirmation} maxLength={1024} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className={`${field} mt-2`} /></label>}
          <button type="submit" disabled={busy || !passphrase || (!hasVault && !confirmation)} className={button}>{busy ? "Working locally…" : hasVault ? "Unlock vault" : "Create encrypted vault"}</button>
        </form>}
        <p className="text-sm text-muted">Use a long, randomly generated passphrase of at least 16 characters. A short PIN is not sufficient. There is no password reset or biometric unlock yet.</p>
        <p className="text-sm text-muted">Local browser storage can be cleared or evicted. This is not a cloud backup. Private names and file contents are not searchable while locked.</p>
      </div>
    </div> : <div className="flex min-h-0 flex-1">
      <aside aria-label="Locked items" className="flex w-64 shrink-0 flex-col border-r border-border bg-surface min-h-0">
        <div className="space-y-2 border-b border-border p-3">
          <div className="grid gap-1.5">
            <button className={button} type="button" disabled={busy} onClick={() => createUntitled("Untitled.env")}>New environment keys</button>
            <button className={button} type="button" disabled={busy} onClick={() => createUntitled("Untitled.txt")}>New private note</button>
            <button className={button} type="button" disabled={busy} onClick={importFile}>Import encrypted copy</button>
          </div>
          <input aria-label="Search private filenames" placeholder="Filter by name" className={`${field} py-1.5 text-sm`} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <nav aria-label="Encrypted items" className="min-h-0 flex-1 overflow-auto p-2">
          {visibleEntries.length === 0 && <p className="px-2 py-3 text-sm text-muted">{entries.length ? "No matching files." : "No encrypted files yet."}</p>}
          {groups.map((group) => group.items.length > 0 && <div key={group.label} className="mb-3">
            <h3 className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted">{group.label}</h3>
            <ul className="space-y-0.5">{group.items.map((entry) => <li key={entry.id}><button type="button" disabled={busy} className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${opened?.id === entry.id ? "bg-accent" : "hover:bg-accent"}`} onClick={() => choose(entry)}>
              <span className="mt-0.5 shrink-0 text-muted">{group.icon}</span>
              <span className="min-w-0"><span className="block break-all">{entry.name}</span><span className="block text-xs text-muted">{entry.bytes.toLocaleString()} bytes{entry.recovery ? " · unsaved encrypted recovery" : ""}</span></span>
            </button></li>)}</ul>
          </div>)}
        </nav>
        <p className="border-t border-border p-3 text-[11px] leading-relaxed text-muted">Auto-lock after 5 minutes of inactivity or when hidden. Edits are checkpointed before locking (2-second limit). Save before closing. Private files never enter the normal library, index, sync or multiplayer.</p>
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-5 sm:p-7">{opened ? <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-[14rem] flex-1 text-sm">Private filename<input className={`${field} mt-2`} value={opened.name} disabled={busy} maxLength={1024} onChange={(event) => {
            const name = event.target.value;
            setOpened({ ...opened, name, dirty: true });
            setError(null);
          }} /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy || !opened.dirty} onClick={save}>Save encrypted changes</button>
            <button type="button" className={button} disabled={busy} onClick={() => void exportDecrypted()}>Download unencrypted copy…</button>
            {opened.id && <button type="button" className={button} disabled={busy} onClick={() => {
              if (!window.confirm("Delete this encrypted copy and any unsaved edits? The original imported file is not deleted.")) return;
              const id = opened.id!;
              const epoch = operation.current + 1;
              void run(async () => {
                await repository.remove(id);
                if (epoch !== operation.current || !mounted.current || shieldRef.current) return;
                replaceOpened(null);
                await refreshEntries(epoch);
                setNotice("Encrypted copy deleted from this vault. External copies and backups are not erased.");
              });
            }}>Delete encrypted copy</button>}
          </div>
        </div>
        <p className="text-xs text-muted">Keep the original file type. Automatic checkpoints preserve the previous filename while a rename is incomplete.</p>
        {envOpened ? <VaultEnvEditor key={envOpened.id ?? "unsaved"} text={envOpened.text} newline={envOpened.source.newline} disabled={busy}
          onChange={(text) => setOpened((current) => current?.kind === "text" ? { ...current, text, dirty: true } : current)}
          onNotice={setNotice} onError={setError} />
        : opened.kind === "text" ? <label className="block text-sm">Private text<textarea aria-label="Private text" className={`${field} mt-2 min-h-80 font-mono text-sm`} value={opened.text} disabled={busy} readOnly={opened.source.newline === "mixed"} onChange={(event) => {
          const text = normalizeTypedNewlines(event.target.value, opened.source.newline);
          setOpened({ ...opened, text, dirty: true });
        }} /></label> : opened.kind === "docx" ? <div className="space-y-3">
          <p className="text-sm text-muted">{opened.document.canEdit ? "Original-engine text editing. Page layout is not reproduced here." : "This DOCX is preserved read-only because it contains unsupported features."}</p>
          {opened.document.paragraphs.map((paragraph, paragraphIndex) => paragraph.runs.map((run, runIndex) => <label key={run.id} className="block text-sm">Private paragraph {paragraphIndex + 1}, run {runIndex + 1}<input className={`${field} mt-2`} value={run.text} readOnly={busy || !opened.document.canEdit || !run.canEdit} onChange={(event) => {
            try { setOpened({ ...opened, document: replaceDocxText(opened.document, [{ runId: run.id, text: event.target.value }]), dirty: true }); }
            catch { setError("This document edit is unsupported. The original encrypted copy was not changed."); }
          }} /></label>))}
        </div> : <p className="text-sm text-muted">This file is stored encrypted. Editing/preview is unavailable; an explicitly decrypted download preserves its original bytes.</p>}
        {opened.kind === "text" && !envOpened && opened.source.newline === "mixed" && <p className="text-sm text-muted">Mixed line endings are preserved read-only.</p>}
        <p className="text-xs text-muted">{opened.dirty ? "Unsaved private edits" : "Encrypted saved copy"} · Sharing and multiplayer are off in the vault.</p>
      </div> : <p className="mx-auto max-w-md py-16 text-center text-sm text-muted">Choose an encrypted item, or create environment keys or a private note. Nothing here is sent to the normal library.</p>}</div>
    </div>}
  </section>;
}

function LockIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
}

function FileIcon() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6v18h12V7zM14 3v4h4" /></svg>;
}
