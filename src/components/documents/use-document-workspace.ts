import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptDocumentPersistence, createDocumentSession, documentNeedsRecoverySave,
  editDocumentDetails, editDocumentText, editOfficeDocument, openDocumentSession, restoreDocumentText,
  serializeDocumentSession, type DocumentSession, type EditableDocumentFormat,
} from "@/lib/document-session";
import { openDocx, type DocxDocument } from "@/lib/office/docx";
import { extractLegacyDocTextOffThread } from "@/lib/office/legacy-doc-worker-client";
import { classifyDocumentFormat, decodeTextDocument, encodeTextDocument } from "@/lib/document-formats";
import { pickWebDocument, saveWebDocument, type WebDocumentPayload, type WebFileHandle } from "@/lib/web-files";
import type { DocumentLibrary, LibraryRecord, LibraryResult, RecoveryRecord } from "@/lib/document-library";

export interface DocumentWorkspaceServices {
  library?: DocumentLibrary;
  pickDocument?: typeof pickWebDocument;
  saveDocument?: typeof saveWebDocument;
  shareDocument?: (file: { name: string; bytes: Uint8Array; text: string }) => Promise<string | null | void>;
  subscribeCommands?: (listener: (command: DocumentWorkspaceCommand) => void) => () => void;
  releaseDocument?: (handle: WebFileHandle) => Promise<void>;
}
export type DocumentWorkspaceCommand = "open" | "save" | "save-as" | "new";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The operation failed. Your open document was kept.";
function unwrap<T>(result: LibraryResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function importSession(payload: WebDocumentPayload, signal?: AbortSignal): Promise<DocumentSession> {
  const format = payload.format.kind;
  if (format === "doc") {
    const result = await extractLegacyDocTextOffThread(payload.bytes, { signal });
    if (!result.ok) throw new Error(result.error.message);
    const converted = result.text.replace(/\x07/g, "\t").replace(/\x0b/g, "\n").replace(/\x0c/g, "\n\n").replace(/[\x00-\x08\x0e-\x1f]/g, "");
    encodeTextDocument(converted); // Refuse invalid Unicode before replacing the current document.
    const session = editDocumentText(await createDocumentSession("text", payload.name.replace(/\.doc$/i, " (converted).txt")), converted);
    return { ...session, warnings: ["Converted a text-only copy. The original DOC was not modified. Formatting and non-text content are not carried into this copy.", ...(converted !== result.text ? ["Legacy cell and line separators were converted to text whitespace. Unsupported field/control markers were omitted."] : []), ...result.warnings] };
  }
  if (!["markdown", "text", "csv", "json", "yaml", "xml", "docx"].includes(format)) {
    throw new Error("That file format is not editable yet. RTF, HTML and ODT are not opened as Markdown.");
  }
  const office = format === "docx" ? await openDocx(payload.bytes) : null;
  const session = await createDocumentSession(format as EditableDocumentFormat, payload.name);
  return {
    ...session, office, text: office?.text ?? payload.text!.text, textMetadata: office ? null : payload.text,
    handle: payload.handle,
    ...(payload.handle ? { externalBaseline: new Uint8Array(payload.bytes), externalGeneration: 0 } : {}),
  };
}

export function useDocumentWorkspace(services: DocumentWorkspaceServices, keyboardEnabled = true) {
  const { subscribeCommands } = services;
  const [records, setRecords] = useState<LibraryRecord[]>([]);
  const [session, setSessionState] = useState<DocumentSession | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord[] | null>(null);
  const [conversion, setConversionState] = useState<WebDocumentPayload | null>(null);
  const conversionRef = useRef<WebDocumentPayload | null>(null);
  const sessionRef = useRef<DocumentSession | null>(null);
  const repositoryRef = useRef<DocumentLibrary | null>(null);
  const revisions = useRef(new Map<string, LibraryRecord>());
  const persistedGenerations = useRef(new Map<string, number>());
  const epochs = useRef(new Map<string, string>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const request = useRef(0);
  const refreshRequest = useRef(0);
  const operationRequest = useRef(0);
  const flushRef = useRef<(() => string | null) | null>(null);
  const mounted = useRef(true);
  const closing = useRef(false);
  const activeImport = useRef<AbortController | null>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const handleUsers = useRef(new Map<WebFileHandle, number>()), pendingHandleReleases = useRef(new Set<WebFileHandle>());
  const keyboardEnabledRef = useRef(keyboardEnabled);
  keyboardEnabledRef.current = keyboardEnabled;

  const releaseHandle = useCallback((handle: WebFileHandle) => {
    if (sessionRef.current?.handle === handle) return;
    if ((handleUsers.current.get(handle) ?? 0) > 0) { pendingHandleReleases.current.add(handle); return; }
    pendingHandleReleases.current.delete(handle);
    const release = servicesRef.current.releaseDocument;
    // Disposal is best-effort here; the native adapter also disposes every
    // remaining lease on unmount. A failed disposal never changes file bytes.
    if (release) void Promise.resolve().then(() => release(handle)).catch(() => {});
  }, []);
  const setSession = useCallback((next: DocumentSession | null) => {
    const previousHandle = sessionRef.current?.handle;
    if (next) epochs.current.set(next.id, next.epoch);
    sessionRef.current = next;
    if (mounted.current) setSessionState(next);
    if (previousHandle && previousHandle !== next?.handle) releaseHandle(previousHandle);
  }, [releaseHandle]);
  const setConversion = useCallback((next: WebDocumentPayload | null) => { conversionRef.current = next; setConversionState(next); }, []);
  const hasPendingConversion = useCallback(() => conversionRef.current !== null, []);
  const refresh = useCallback(async () => {
    const repository = repositoryRef.current;
    if (!repository) return;
    const token = ++refreshRequest.current;
    const items = unwrap(await repository.list());
    if (mounted.current && token === refreshRequest.current) setRecords(items);
    for (const record of items) if (record.revision >= (revisions.current.get(record.id)?.revision ?? 0)) revisions.current.set(record.id, record);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const requestState = request;
    const importState = activeImport;
    let cancelled = false;
    let owned: DocumentLibrary | undefined;
    (async () => {
      try {
        const repository = services.library ?? unwrap(await (await import("@/lib/document-library")).createIndexedDbDocumentLibrary());
        if (!services.library) owned = repository;
        if (cancelled) { owned?.close(); return; }
        repositoryRef.current = repository;
        await refresh();
      } catch (failure) {
        if (!cancelled) setError(`Local recovery is unavailable. ${messageOf(failure)} You can still create and export a file.`);
      } finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; mounted.current = false; requestState.current++; importState.current?.abort(); repositoryRef.current = null; owned?.close(); };
  }, [services.library, refresh]);

  const changeText = useCallback((text: string) => {
    const current = sessionRef.current;
    if (current) setSession(editDocumentText(current, text));
  }, [setSession]);
  const capture = useCallback(() => {
    const rich = flushRef.current?.();
    if (rich !== undefined && rich !== null) changeText(rich);
    return sessionRef.current;
  }, [changeText]);
  const restoreText = useCallback((text: string) => {
    const current = sessionRef.current;
    if (!current) return;
    try { setSession(restoreDocumentText(current, text)); }
    catch (failure) { setError(messageOf(failure)); }
  }, [setSession]);

  const persist = useCallback(async (snapshot: DocumentSession): Promise<LibraryRecord> => {
    setSaving((count) => count + 1);
    const operation = queue.current.catch(() => {}).then(async () => {
      const repository = repositoryRef.current;
      if (!repository) throw new Error("Local recovery is unavailable. Export this file to keep a copy.");
      const previous = revisions.current.get(snapshot.id) ?? snapshot.record;
      if (epochs.current.get(snapshot.id) !== snapshot.epoch) {
        if (previous) return previous;
        throw new Error("This older document session is no longer active. The current document was kept.");
      }
      if (previous && (persistedGenerations.current.get(snapshot.id) ?? -1) >= snapshot.generation) return previous;
      const bytes = await serializeDocumentSession(snapshot);
      if (epochs.current.get(snapshot.id) !== snapshot.epoch) {
        if (previous) return previous;
        throw new Error("This older document session is no longer active. The current document was kept.");
      }
      const record = unwrap(await repository.put({
        id: snapshot.id, name: snapshot.name, format: snapshot.format, bytes,
        tags: snapshot.tags, collection: snapshot.collection, extractedText: snapshot.text.slice(0, 1024 * 1024),
      }, previous?.revision ?? null));
      revisions.current.set(record.id, record);
      persistedGenerations.current.set(record.id, snapshot.generation);
      const current = sessionRef.current;
      if (current?.id === snapshot.id) setSession(acceptDocumentPersistence(current, snapshot, record));
      await refresh();
      return record;
    });
    queue.current = operation;
    try { return await operation; }
    finally { if (mounted.current) setSaving((count) => count - 1); }
  }, [refresh, setSession]);

  useEffect(() => {
    if (!session || !ready || busy || !repositoryRef.current || !documentNeedsRecoverySave(session)) return;
    const timer = setTimeout(() => {
      const current = capture();
      if (current) persist(current).catch((failure) => { if (mounted.current) setError(`Recovery failed. ${messageOf(failure)}`); });
    }, 600);
    return () => clearTimeout(timer);
  }, [session, ready, busy, capture, persist]);

  const run = useCallback(async (label: string, operation: () => Promise<void>) => {
    const token = ++operationRequest.current;
    setBusy(label); setError(null); setNotice(null);
    try { await operation(); }
    catch (failure) { if (mounted.current && token === operationRequest.current) setError(messageOf(failure)); }
    finally { if (mounted.current && token === operationRequest.current) setBusy(null); }
  }, []);

  const open = useCallback(async (record: LibraryRecord) => {
    activeImport.current?.abort();
    const controller = new AbortController(); activeImport.current = controller;
    const token = ++request.current;
    try { await run("Opening document", async () => {
      const current = capture();
      if (current && documentNeedsRecoverySave(current)) await persist(current);
      const latest = unwrap(await repositoryRef.current!.get(record.id));
      if (!latest) throw new Error("This document is no longer in the library.");
      const next = latest.format === "doc"
        ? await importSession({ name: latest.name, bytes: latest.bytes, format: { kind: "doc", representation: "bytes", editing: "engine", mimeType: "application/msword" }, text: null }, controller.signal)
        : await openDocumentSession(latest);
      if (token !== request.current) return;
      persistedGenerations.current.set(next.id, next.persistedGeneration);
      flushRef.current = null; setSession(next); setRecovery(null); setNotice(null);
      if (latest.format === "doc") await persist(next);
    }); } finally { if (activeImport.current === controller) activeImport.current = null; }
  }, [capture, persist, run, setSession]);

  const create = useCallback(async (format: EditableDocumentFormat) => {
    activeImport.current?.abort();
    const token = ++request.current;
    await run("Creating document", async () => {
      const current = capture();
      if (current && documentNeedsRecoverySave(current)) await persist(current);
      const next = await createDocumentSession(format);
      if (token !== request.current) return;
      persistedGenerations.current.set(next.id, next.persistedGeneration);
      flushRef.current = null; setSession(next); setRecovery(null); setNotice(null);
      if (repositoryRef.current) await persist(next);
    });
  }, [capture, persist, run, setSession]);

  const acceptPayload = useCallback(async (payload: WebDocumentPayload, token: number) => {
    activeImport.current?.abort();
    const controller = new AbortController(); activeImport.current = controller;
    try {
      if (["rtf", "html", "odt"].includes(payload.format.kind)) {
        if (token === request.current) setConversion({ ...payload, handle: undefined, bytes: new Uint8Array(payload.bytes) });
        return;
      }
      const current = capture();
      if (current && documentNeedsRecoverySave(current)) await persist(current);
      if (controller.signal.aborted || token !== request.current) return;
      const next = await importSession(payload, controller.signal);
      if (token !== request.current) return;
      persistedGenerations.current.set(next.id, next.persistedGeneration);
      flushRef.current = null; setSession(next); setRecovery(null); setNotice(null);
      if (repositoryRef.current) await persist(next);
    } finally {
      if (activeImport.current === controller) activeImport.current = null;
      if (payload.handle && sessionRef.current?.handle !== payload.handle) releaseHandle(payload.handle);
    }
  }, [capture, persist, setSession, setConversion, releaseHandle]);

  const importFile = useCallback(async () => {
    activeImport.current?.abort();
    // Open the picker before awaiting recovery to retain transient activation.
    const selection = (servicesRef.current.pickDocument ?? pickWebDocument)();
    const token = ++request.current;
    await run("Importing document", async () => { const payload = await selection; if (payload) await acceptPayload(payload, token); });
  }, [acceptPayload, run]);

  const importPayload = useCallback(async (payload: WebDocumentPayload) => {
    const token = ++request.current;
    const previousEpoch = sessionRef.current?.epoch;
    let imported = false;
    await run("Opening requested document", async () => {
      await acceptPayload(payload, token);
      imported = token === request.current && !conversionRef.current && sessionRef.current?.epoch !== previousEpoch;
    });
    return imported;
  }, [acceptPayload, run]);

  const confirmConversion = useCallback(async () => {
    const payload = conversionRef.current;
    if (!payload || !["rtf", "html", "odt"].includes(payload.format.kind)) return;
    activeImport.current?.abort();
    setConversion(null);
    const token = ++request.current;
    await run("Converting a text copy", async () => {
      const current = capture();
      if (current && documentNeedsRecoverySave(current)) await persist(current);
      const { convertAdditionalDocument } = await import("@/lib/document-import");
      const converted = await convertAdditionalDocument({ name: payload.name, bytes: payload.bytes, format: payload.format.kind as "rtf" | "html" | "odt" });
      if (!converted.ok) throw new Error(converted.error.message);
      const next = await importSession({ name: converted.name, bytes: converted.bytes, format: classifyDocumentFormat(converted.name), text: decodeTextDocument(converted.bytes) });
      if (token !== request.current || !mounted.current) return;
      flushRef.current = null; setSession({ ...next, warnings: ["Imported a new text-only copy. The source document was not changed.", ...converted.warnings] }); setRecovery(null);
      persistedGenerations.current.set(next.id, next.persistedGeneration);
      if (repositoryRef.current) await persist(next);
      setNotice("Imported a new text-only copy. The original file remains unchanged.");
    });
  }, [capture, persist, run, setConversion, setSession]);

  const saveFile = useCallback(async (saveAs = false) => {
    const snapshot = capture();
    if (!snapshot) return;
    const usedHandle = saveAs ? undefined : snapshot.handle;
    if (usedHandle) handleUsers.current.set(usedHandle, (handleUsers.current.get(usedHandle) ?? 0) + 1);
    try { await run("Saving file", async () => {
      const bytes = await serializeDocumentSession(snapshot);
      const handle = saveAs ? undefined : snapshot.handle;
      if (handle && snapshot.externalBaseline) {
        const external = await handle.getFile();
        if (external.size !== snapshot.externalBaseline.length) throw new Error("The original file changed outside Markie. Export a new copy to avoid overwriting those changes.");
        const disk = new Uint8Array(await external.arrayBuffer());
        if (disk.length !== snapshot.externalBaseline.length || disk.some((byte, index) => byte !== snapshot.externalBaseline![index])) {
          throw new Error("The original file changed outside Markie. Export a new copy to avoid overwriting those changes.");
        }
      }
      const receipt = await (servicesRef.current.saveDocument ?? saveWebDocument)({ name: snapshot.name, bytes, handle });
      if (!receipt) return;
      if (receipt.method === "download") { setNotice("Download started. Check your Downloads folder. The original file was not marked saved."); return; }
      const current = sessionRef.current;
      if (current?.id === snapshot.id && current.epoch === snapshot.epoch) setSession({
        ...current, handle: receipt.handle, externalBaseline: new Uint8Array(bytes), externalGeneration: snapshot.generation,
      });
      else releaseHandle(receipt.handle);
      let saved: LibraryRecord | undefined;
      try { saved = await persist(snapshot); }
      catch (failure) { setError(`The file was saved, but local recovery failed. ${messageOf(failure)}`); }
      if (saved && repositoryRef.current && sessionRef.current?.id === snapshot.id
        && sessionRef.current.epoch === snapshot.epoch && sessionRef.current.generation === snapshot.generation) {
        const marked = await repositoryRef.current.markExported(saved.id, saved.revision);
        if (marked.ok) { revisions.current.set(saved.id, marked.value); await refresh(); }
      }
      const active = sessionRef.current;
      setNotice(active?.id !== snapshot.id || active.epoch !== snapshot.epoch
        ? "Saved an earlier document session to file. The current document was not marked saved."
        : active.generation === snapshot.generation ? null : "Saved that file revision. Newer edits still need saving.");
    }); } finally {
      if (usedHandle) {
        const remaining = (handleUsers.current.get(usedHandle) ?? 1) - 1;
        if (remaining > 0) handleUsers.current.set(usedHandle, remaining); else handleUsers.current.delete(usedHandle);
        if (pendingHandleReleases.current.has(usedHandle)) releaseHandle(usedHandle);
      }
    }
  }, [capture, persist, refresh, run, setSession, releaseHandle]);

  const changeOffice = useCallback((office: DocxDocument) => {
    const current = sessionRef.current;
    if (current) setSession(editOfficeDocument(current, office));
  }, [setSession]);
  const changeDetails = useCallback((details: Parameters<typeof editDocumentDetails>[1]) => {
    const current = sessionRef.current;
    if (!current) return null;
    try { const next = editDocumentDetails(current, details); setSession(next); return next; }
    catch (failure) { setError(messageOf(failure)); return current; }
  }, [setSession]);
  const showRecovery = useCallback(async () => {
    await run("Loading recovery history", async () => {
      const current = capture();
      if (!current || !repositoryRef.current) return;
      if (documentNeedsRecoverySave(current)) await persist(current);
      setRecovery(unwrap(await repositoryRef.current.listRecovery(current.id)));
    });
  }, [capture, persist, run]);
  const restore = useCallback(async (revision: number) => {
    await run("Restoring document", async () => {
      const current = capture();
      if (!current || !repositoryRef.current) return;
      if (documentNeedsRecoverySave(current)) await persist(current);
      const latest = revisions.current.get(current.id)!;
      const record = unwrap(await repositoryRef.current.restoreRecovery(current.id, revision, latest.revision));
      revisions.current.set(record.id, record);
      const next = await openDocumentSession(record);
      persistedGenerations.current.set(next.id, next.persistedGeneration);
      flushRef.current = null; setSession(next); setRecovery(null); await refresh(); setNotice("Restored a recovery revision. The external file was not changed.");
    });
  }, [capture, persist, refresh, run, setSession]);
  const remove = useCallback(async (record: LibraryRecord) => {
    await run("Removing document", async () => {
      await queue.current.catch(() => {});
      unwrap(await repositoryRef.current!.remove(record.id, revisions.current.get(record.id)?.revision ?? record.revision));
      revisions.current.delete(record.id);
      persistedGenerations.current.delete(record.id);
      if (sessionRef.current?.id === record.id) { request.current++; flushRef.current = null; setSession(null); }
      await refresh(); setNotice("Removed from this library and its recovery history. External files were not deleted.");
    });
  }, [refresh, run, setSession]);
  const copy = useCallback(async () => {
    await run("Copying document text", async () => {
      const current = capture();
      if (!current) return;
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser. Export the document instead.");
      await navigator.clipboard.writeText(current.text); setNotice("Document text copied.");
    });
  }, [capture, run]);
  const share = useCallback(async () => {
    await run("Sharing document", async () => {
      const current = capture();
      if (!current) return;
      const bytes = await serializeDocumentSession(current);
      if (servicesRef.current.shareDocument) {
        const receipt = await servicesRef.current.shareDocument({ name: current.name, bytes, text: current.text });
        if (receipt !== null) setNotice(receipt ?? "Share action completed.");
        return;
      } else {
        const file = new File([new Uint8Array(bytes)], current.name, { type: current.format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain" });
        if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) throw new Error("File sharing is unavailable here. Export a copy or copy the document text.");
        try { await navigator.share({ files: [file], title: current.name }); }
        catch (failure) { if (failure instanceof DOMException && failure.name === "AbortError") return; throw failure; }
      }
      setNotice("Sent to the system share destination.");
    });
  }, [capture, run]);

  /** Native close is allowed only after the latest ordinary document is durable. */
  const prepareClose = useCallback(async (): Promise<boolean> => {
    if (closing.current) return false;
    if (conversionRef.current || busyRef.current) {
      setError("Finish the current document operation or conversion dialog before closing."); return false;
    }
    closing.current = true; setBusy("Preparing to close");
    try {
      await queue.current.catch(() => {});
      const snapshot = capture();
      if (!snapshot) return true;
      const repository = repositoryRef.current;
      if (!repository || repository.persistence !== "indexeddb") throw new Error("Durable local recovery is unavailable. Keep the window open and export your document.");
      const record = await persist(snapshot);
      const stored = unwrap(await repository.get(record.id));
      if (!stored || stored.revision < record.revision) throw new Error("The latest recovered document could not be confirmed.");
      const latest = capture();
      if (!latest || latest.id !== snapshot.id || latest.epoch !== snapshot.epoch || latest.generation !== snapshot.generation) {
        throw new Error("Newer edits arrived while preparing to close. They are still open; let recovery finish and close again.");
      }
      return true;
    } catch (failure) { if (mounted.current) setError(`The window was kept open. ${messageOf(failure)}`); return false; }
    finally { closing.current = false; if (mounted.current) setBusy(null); }
  }, [capture, persist]);

  const commands = useRef({ create, importFile, saveFile });
  commands.current = { create, importFile, saveFile };
  useEffect(() => subscribeCommands?.((command) => {
    if (!keyboardEnabledRef.current || conversionRef.current || closing.current) return;
    if (command === "open") void commands.current.importFile();
    else if (command === "save") void commands.current.saveFile();
    else if (command === "save-as") void commands.current.saveFile(true);
    else if (command === "new") void commands.current.create("docx");
  }), [subscribeCommands]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!keyboardEnabledRef.current || conversionRef.current || closing.current) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); void commands.current.saveFile(event.shiftKey); }
      else if (key === "o") { event.preventDefault(); void commands.current.importFile(); }
      else if (key === "n") { event.preventDefault(); void commands.current.create("docx"); }
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      capture();
      if (sessionRef.current && documentNeedsRecoverySave(sessionRef.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("beforeunload", onUnload); };
  }, [capture]);

  return {
    records, session, ready, busy, saving: saving > 0, error, notice, recovery, conversion,
    open, create, importFile, importPayload, saveFile, changeText, restoreText, changeOffice, changeDetails, showRecovery, restore, remove, copy, share,
    closeRecovery: () => setRecovery(null), dismissError: () => setError(null),
    confirmConversion, cancelConversion: () => setConversion(null),
    hasPendingConversion,
    prepareClose,
    discardPayload: (payload: WebDocumentPayload) => { if (payload.handle) releaseHandle(payload.handle); },
    setFlush: (flush: (() => string | null) | null) => { flushRef.current = flush; },
    recoverNow: async () => { const current = capture(); if (current) await run("Saving recovery", async () => { await persist(current); setNotice("Recovered in the local library. No external file was changed."); }); },
  };
}
