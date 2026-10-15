import { asFailure, resolveLimits } from "./model";
import { openIndexedDbLibraryStorage, type IndexedDbLibraryOptions } from "./indexed-db";
import { createMemoryLibraryStorage } from "./memory";
import { createDocumentLibrary } from "./repository";
import type { DocumentLibrary, LibraryOptions, LibraryResult } from "./types";

export type * from "./types";
export type { IndexedDbLibraryOptions } from "./indexed-db";
export { DOCUMENT_LIBRARY_DATABASE } from "./indexed-db";
export { DEFAULT_LIBRARY_LIMITS, LIBRARY_FORMATS } from "./model";
export { queryLibraryRecords } from "./query";

/** Durable browser library, never a silent or automatic memory fallback. */
export async function createIndexedDbDocumentLibrary(options: LibraryOptions & IndexedDbLibraryOptions = {}): Promise<LibraryResult<DocumentLibrary>> {
  try {
    resolveLimits(options.limits);
    const storage = await openIndexedDbLibraryStorage(options);
    try { return { ok: true, value: createDocumentLibrary(storage, options) }; }
    catch (error) { storage.close(); throw error; }
  } catch (error) { return asFailure(error); }
}
/** Explicit ephemeral test repository; persistence advertises "memory" to callers. */
export function createMemoryDocumentLibrary(options: LibraryOptions = {}): DocumentLibrary {
  return createDocumentLibrary(createMemoryLibraryStorage(), options);
}
