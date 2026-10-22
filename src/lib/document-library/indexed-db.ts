import { fail, LibraryFailure } from "./model";
import type { LibraryChange, LibrarySnapshot, LibraryStorageAdapter } from "./storage";
import type { LibraryLimits } from "./types";

export const DOCUMENT_LIBRARY_DATABASE = "markie-document-library";
const DOCUMENTS = "documents", RECOVERY = "recovery", VERSION = 1;
export interface IndexedDbLibraryOptions {
  databaseName?: string;
  /** Injection is explicit; null tests unavailable storage without touching global state. */
  indexedDB?: IDBFactory | null;
  openTimeoutMs?: number;
}

/**
 * Browser IndexedDB only, from W3C Indexed Database API 3.0 §§2.7, 4, 5.4–5.5.
 * https://www.w3.org/TR/IndexedDB-3/
 * No promise resolves from a request success: transaction complete is the commit boundary.
 */
export async function openIndexedDbLibraryStorage(options: IndexedDbLibraryOptions = {}): Promise<LibraryStorageAdapter> {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  if (!factory) fail("storage-unavailable", "IndexedDB is unavailable. Documents cannot be durably saved in this browser.");
  const name = options.databaseName ?? DOCUMENT_LIBRARY_DATABASE;
  const timeoutMs = options.openTimeoutMs ?? 10000;
  if (!name || name.length > 128 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail("invalid-input", "Invalid document-library storage options.");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, VERSION);
    let settled = false;
    const finish = (error?: unknown, database?: IDBDatabase) => {
      if (settled) { database?.close(); return; }
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(database!);
    };
    const timer = setTimeout(() => finish(new LibraryFailure("storage-unavailable", "Opening document storage timed out. No fallback storage was used.")), timeoutMs);
    request.onblocked = () => finish(new LibraryFailure("storage-blocked", "Another tab is blocking document storage. Close older tabs and retry."));
    request.onerror = () => finish(request.error ?? new LibraryFailure("storage-unavailable", "Document storage could not be opened."));
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      try {
        const database = request.result;
        database.createObjectStore(DOCUMENTS, { keyPath: "id" });
        database.createObjectStore(RECOVERY, { keyPath: ["documentId", "revision"] });
      } catch (error) { request.transaction?.abort(); finish(error); }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (database.version !== VERSION || database.objectStoreNames.length !== 2 || !database.objectStoreNames.contains(DOCUMENTS) || !database.objectStoreNames.contains(RECOVERY)) {
        database.close(); finish(new LibraryFailure("corrupt-storage", "Unexpected document-library database schema.")); return;
      }
      try {
        const tx = database.transaction([DOCUMENTS, RECOVERY], "readonly");
        if (tx.objectStore(DOCUMENTS).keyPath !== "id" || JSON.stringify(tx.objectStore(RECOVERY).keyPath) !== JSON.stringify(["documentId", "revision"])) {
          database.close(); finish(new LibraryFailure("corrupt-storage", "Unexpected document-library object-store keys.")); return;
        }
      } catch (error) { database.close(); finish(error); return; }
      finish(undefined, database);
    };
  });
  let closed = false;
  db.onversionchange = () => { closed = true; db.close(); };
  db.onclose = () => { closed = true; };
  return {
    persistence: "indexeddb",
    execute<T>(mode: "readonly" | "readwrite", limits: LibraryLimits, operation: (snapshot: LibrarySnapshot) => LibraryChange<T>): Promise<T> {
      if (closed) return Promise.reject(new LibraryFailure("closed", "Document storage was closed or upgraded by another tab. Reopen the library."));
      return new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try { tx = db.transaction([DOCUMENTS, RECOVERY], mode); } catch (error) { reject(error); return; }
        let value: T, planned = false, failure: unknown;
        tx.oncomplete = () => planned ? resolve(value) : reject(failure ?? new LibraryFailure("storage-unavailable", "Document transaction completed without its operation."));
        tx.onabort = () => reject(failure ?? tx.error ?? new LibraryFailure("storage-unavailable", "Document transaction was aborted. Changes were not saved."));
        const abort = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(error); } };
        try {
          const documents = tx.objectStore(DOCUMENTS), recovery = tx.objectStore(RECOVERY);
          // Bounded row counts: one extra row detects oversize/corrupt stores without an unbounded getAll.
          const documentRequest = documents.getAll(undefined, limits.maxRecords + 1);
          const recoveryRequest = recovery.getAll(undefined, limits.maxRecoveryRecords + 1);
          let docs: unknown[] | undefined, revisions: unknown[] | undefined;
          const apply = () => {
            if (!docs || !revisions) return;
            try {
              const change = operation({ documents: docs, recovery: revisions });
              if (mode === "readwrite") {
                for (const id of change.deleteDocuments ?? []) documents.delete(id);
                for (const row of change.putDocuments ?? []) documents.put(row);
                for (const key of change.deleteRecovery ?? []) recovery.delete(key);
                for (const row of change.putRecovery ?? []) recovery.put(row);
              }
              value = change.value; planned = true;
            } catch (error) { abort(error); }
          };
          documentRequest.onsuccess = () => { docs = documentRequest.result; apply(); };
          recoveryRequest.onsuccess = () => { revisions = recoveryRequest.result; apply(); };
          // Native error default action aborts the transaction; do not prevent it.
          documentRequest.onerror = () => { failure = documentRequest.error; };
          recoveryRequest.onerror = () => { failure = recoveryRequest.error; };
        } catch (error) { abort(error); }
      });
    },
    close() { closed = true; db.close(); },
  };
}
