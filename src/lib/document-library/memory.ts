import { fail } from "./model";
import type { LibraryChange, LibrarySnapshot, LibraryStorageAdapter } from "./storage";
import type { LibraryLimits } from "./types";

/** Explicit ephemeral adapter for tests; never selected after a browser-storage failure. */
export function createMemoryLibraryStorage(seed: LibrarySnapshot = { documents: [], recovery: [] }): LibraryStorageAdapter {
  let state = structuredClone(seed), closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    persistence: "memory",
    execute<T>(mode: "readonly" | "readwrite", _limits: LibraryLimits, operation: (snapshot: LibrarySnapshot) => LibraryChange<T>): Promise<T> {
      const run = queue.then(() => {
        if (closed) fail("closed", "The document library is closed.");
        const change = operation(structuredClone(state));
        if (mode === "readwrite") {
          // Prepare the entire next snapshot before committing, including clone failures.
          const documents = new Map(state.documents.map((row) => [(row as { id: string }).id, row]));
          const recovery = new Map(state.recovery.map((row) => {
            const r = row as { documentId: string; revision: number };
            return [JSON.stringify([r.documentId, r.revision]), row];
          }));
          for (const id of change.deleteDocuments ?? []) documents.delete(id);
          for (const row of change.putDocuments ?? []) documents.set(row.id, structuredClone(row));
          for (const key of change.deleteRecovery ?? []) recovery.delete(JSON.stringify(key));
          for (const row of change.putRecovery ?? []) recovery.set(JSON.stringify([row.documentId, row.revision]), structuredClone(row));
          state = { documents: [...documents.values()], recovery: [...recovery.values()] };
        }
        return change.value;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    close() { closed = true; },
  };
}
