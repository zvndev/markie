import type { LibraryLimits, LibraryRecord, RecoveryRecord } from "./types";

export interface LibrarySnapshot { documents: unknown[]; recovery: unknown[] }
export interface LibraryChange<T> {
  value: T;
  putDocuments?: LibraryRecord[];
  deleteDocuments?: string[];
  putRecovery?: RecoveryRecord[];
  deleteRecovery?: [string, number][];
}
/** Callback is synchronous, so IndexedDB cannot auto-commit between CAS and writes. */
export interface LibraryStorageAdapter {
  readonly persistence: "indexeddb" | "memory";
  execute<T>(mode: "readonly" | "readwrite", limits: LibraryLimits, operation: (snapshot: LibrarySnapshot) => LibraryChange<T>): Promise<T>;
  close(): void;
}
