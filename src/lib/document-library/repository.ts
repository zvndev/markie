import { asFailure, cloneRecord, cloneRecovery, fail, recordBytes, recoveryBytes, resolveLimits, snapshotInput, validateId, validateRecord, validateRecovery, validateRevision } from "./model";
import { queryLibraryRecords } from "./query";
import type { LibraryChange, LibrarySnapshot, LibraryStorageAdapter } from "./storage";
import type { DocumentLibrary, LibraryOptions, LibraryPutInput, LibraryQuery, LibraryRecord, LibraryResult, RecoveryRecord } from "./types";

export function createDocumentLibrary(storage: LibraryStorageAdapter, options: LibraryOptions = {}): DocumentLibrary {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const protect = async <T>(operation: () => T | Promise<T>): Promise<LibraryResult<T>> => {
    try { return { ok: true, value: await operation() }; } catch (error) { return asFailure(error); }
  };
  const readState = (snapshot: LibrarySnapshot) => {
    if (snapshot.documents.length > limits.maxRecords || snapshot.recovery.length > limits.maxRecoveryRecords) fail("limit-exceeded", "Stored document count exceeds library limits.");
    const documents = snapshot.documents.map((row) => validateRecord(row, limits));
    const recovery = snapshot.recovery.map((row) => validateRecovery(row, limits));
    const byId = new Map(documents.map((row) => [row.id, row]));
    if (byId.size !== documents.length) fail("corrupt-storage", "Duplicate stored document identifiers.");
    const revisionKeys = new Set<string>(), revisionCounts = new Map<string, number>();
    for (const revision of recovery) {
      const document = byId.get(revision.documentId), key = JSON.stringify([revision.documentId, revision.revision]);
      if (!document || revision.revision > document.revision || revision.record.createdAt !== document.createdAt || revisionKeys.has(key)) fail("corrupt-storage", "Recovery history does not match its document.");
      revisionKeys.add(key); revisionCounts.set(revision.documentId, (revisionCounts.get(revision.documentId) ?? 0) + 1);
      if (revisionCounts.get(revision.documentId)! > limits.maxRecoveryPerDocument) fail("limit-exceeded", "Stored recovery history exceeds library limits.");
    }
    const total = documents.reduce((sum, row) => sum + recordBytes(row), 0) + recovery.reduce((sum, row) => sum + recoveryBytes(row), 0);
    if (total > limits.maxTotalBytes) fail("limit-exceeded", "Stored document payload exceeds the library budget.");
    return { documents, recovery, byId };
  };
  const timestamp = (previous?: LibraryRecord) => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid-input", "Invalid document-library clock.");
    return Math.max(value, previous?.updatedAt ?? 0);
  };
  const matchRevision = (record: LibraryRecord | undefined, expected: number | null) => {
    if ((record?.revision ?? null) !== expected) fail("conflict", "The document changed in another view. Reopen it before saving over that revision.", record?.revision ?? null);
  };
  const planPut = (state: ReturnType<typeof readState>, input: LibraryPutInput, expectedRevision: number | null): LibraryChange<LibraryRecord> => {
    const id = input.id ?? createId(); validateId(id);
    const previous = state.byId.get(id); matchRevision(previous, expectedRevision);
    if (!previous && state.documents.length >= limits.maxRecords) fail("limit-exceeded", "The document library has reached its record limit.");
    if ((previous?.revision ?? 0) === Number.MAX_SAFE_INTEGER) fail("limit-exceeded", "The document revision counter is exhausted.");
    const updatedAt = timestamp(previous);
    const next: LibraryRecord = {
      ...input, schemaVersion: 1, id, bytes: new Uint8Array(input.bytes), tags: [...input.tags ?? []], collection: input.collection ?? null,
      createdAt: previous?.createdAt ?? updatedAt, updatedAt, revision: (previous?.revision ?? 0) + 1, exportedRevision: previous?.exportedRevision ?? null,
    };
    const newest: RecoveryRecord = { schemaVersion: 1, documentId: id, revision: next.revision, savedAt: updatedAt, record: cloneRecord(next) };
    const recovery = [...state.recovery, newest];
    const removed = new Set<RecoveryRecord>();
    const oldestFirst = (a: RecoveryRecord, b: RecoveryRecord) => a.savedAt - b.savedAt || a.revision - b.revision || (a.documentId < b.documentId ? -1 : 1);
    const documentHistory = recovery.filter((r) => r.documentId === id).sort(oldestFirst);
    while (documentHistory.length > limits.maxRecoveryPerDocument) removed.add(documentHistory.shift()!);
    const survivors = recovery.filter((r) => !removed.has(r)).sort(oldestFirst);
    let bytes = state.documents.filter((r) => r.id !== id).reduce((sum, r) => sum + recordBytes(r), recordBytes(next)) + survivors.reduce((sum, r) => sum + recoveryBytes(r), 0);
    // Evict only recovery history, never an ordinary document or this newly committed revision.
    while (survivors.length > limits.maxRecoveryRecords || bytes > limits.maxTotalBytes) {
      const index = survivors.findIndex((r) => r !== newest);
      if (index === -1) fail("limit-exceeded", "Document and its recovery snapshot exceed the library payload budget.");
      const [old] = survivors.splice(index, 1); removed.add(old); bytes -= recoveryBytes(old);
    }
    return { value: cloneRecord(next), putDocuments: [next], putRecovery: [newest], deleteRecovery: [...removed].map((r) => [r.documentId, r.revision]) };
  };
  const changeExisting = <T extends LibraryRecord | null>(id: string, expectedRevision: number, operation: (state: ReturnType<typeof readState>, current: LibraryRecord) => LibraryChange<T>) => protect(() => {
    validateId(id); validateRevision(expectedRevision);
    return storage.execute("readwrite", limits, (snapshot) => {
      const state = readState(snapshot), current = state.byId.get(id); matchRevision(current, expectedRevision);
      return operation(state, current!);
    });
  });
  return {
    persistence: storage.persistence,
    get(id) { return protect(() => { validateId(id); return storage.execute("readonly", limits, (snapshot) => ({ value: cloneNullable(readState(snapshot).byId.get(id)) })); }); },
    list(query: LibraryQuery = {}) {
      return protect(() => {
        queryLibraryRecords([], query);
        const safe = { ...query, ...(query.formats ? { formats: [...query.formats] } : {}), ...(query.tags ? { tags: [...query.tags] } : {}) };
        return storage.execute("readonly", limits, (snapshot) => ({ value: queryLibraryRecords(readState(snapshot).documents, safe) }));
      });
    },
    put(input, expectedRevision) {
      return protect(() => {
        if (expectedRevision !== null) { validateRevision(expectedRevision); if (input.id === undefined) fail("invalid-input", "Updating a document requires its identifier."); }
        const safe = snapshotInput(input, limits);
        return storage.execute("readwrite", limits, (snapshot) => planPut(readState(snapshot), safe, expectedRevision));
      });
    },
    remove(id, expectedRevision) {
      return changeExisting(id, expectedRevision, (state) => ({ value: null, deleteDocuments: [id], deleteRecovery: state.recovery.filter((r) => r.documentId === id).map((r) => [r.documentId, r.revision]) }));
    },
    markExported(id, expectedRevision) {
      return changeExisting(id, expectedRevision, (_state, current) => {
        const next = { ...current, exportedRevision: current.revision };
        return { value: cloneRecord(next), putDocuments: [next] };
      });
    },
    listRecovery(id) {
      return protect(() => { validateId(id); return storage.execute("readonly", limits, (snapshot) => ({ value: readState(snapshot).recovery.filter((r) => r.documentId === id).sort((a, b) => b.revision - a.revision).map(cloneRecovery) })); });
    },
    restoreRecovery(id, recoveryRevision, expectedRevision) {
      return protect(() => {
        validateId(id); validateRevision(recoveryRevision); validateRevision(expectedRevision);
        return storage.execute("readwrite", limits, (snapshot) => {
          const state = readState(snapshot); matchRevision(state.byId.get(id), expectedRevision);
          const revision = state.recovery.find((r) => r.documentId === id && r.revision === recoveryRevision);
          if (!revision) fail("not-found", "This recovery revision is no longer available.");
          const r = revision.record;
          return planPut(state, { id, name: r.name, format: r.format, bytes: r.bytes, tags: r.tags, collection: r.collection, ...(r.extractedText !== undefined ? { extractedText: r.extractedText } : {}) }, expectedRevision);
        });
      });
    },
    close() { storage.close(); },
  };
}
function cloneNullable(record: LibraryRecord | undefined): LibraryRecord | null { return record ? cloneRecord(record) : null; }
