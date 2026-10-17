/** Ordinary workspace documents only. Vault plaintext must never enter this API. */
export type LibraryFormat = "markdown" | "darkmown" | "text" | "csv" | "json" | "yaml" | "xml" | "docx" | "doc" | "rtf" | "odt";
export interface LibraryRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly format: LibraryFormat;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
  readonly exportedRevision: number | null;
  readonly tags: readonly string[];
  readonly collection: string | null;
  readonly extractedText?: string;
}
export interface LibraryPutInput {
  id?: string;
  name: string;
  format: LibraryFormat;
  bytes: Uint8Array;
  tags?: readonly string[];
  collection?: string | null;
  extractedText?: string;
}
export interface RecoveryRecord {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly revision: number;
  readonly savedAt: number;
  readonly record: LibraryRecord;
}
export type LibraryErrorCode = "invalid-input" | "corrupt-storage" | "conflict" | "not-found" | "limit-exceeded" | "storage-unavailable" | "storage-quota" | "storage-blocked" | "closed";
export type LibraryResult<T> = { ok: true; value: T } | { ok: false; error: { code: LibraryErrorCode; message: string; actualRevision?: number | null } };
export interface LibraryQuery {
  search?: string;
  formats?: readonly LibraryFormat[];
  tags?: readonly string[];
  /** undefined: every collection; null: uncollected; string: exact collection. */
  collection?: string | null;
  sortBy?: "name" | "updatedAt" | "createdAt" | "format";
  sortDirection?: "asc" | "desc";
}
export interface LibraryLimits {
  maxRecords: number;
  maxDocumentBytes: number;
  /** Payload budget including UTF-16 metadata/text and recovery bytes, not physical IDB overhead. */
  maxTotalBytes: number;
  maxExtractedTextCodeUnits: number;
  maxRecoveryPerDocument: number;
  maxRecoveryRecords: number;
}
export interface LibraryOptions {
  limits?: Partial<LibraryLimits>;
  now?: () => number;
  createId?: () => string;
}
export interface DocumentLibrary {
  readonly persistence: "indexeddb" | "memory";
  get(id: string): Promise<LibraryResult<LibraryRecord | null>>;
  list(query?: LibraryQuery): Promise<LibraryResult<LibraryRecord[]>>;
  /** null creates only; a positive revision updates an existing record only. */
  put(input: LibraryPutInput, expectedRevision: number | null): Promise<LibraryResult<LibraryRecord>>;
  remove(id: string, expectedRevision: number): Promise<LibraryResult<null>>;
  /** Records a confirmed file export; never call for an attempted/cancelled download. */
  markExported(id: string, expectedRevision: number): Promise<LibraryResult<LibraryRecord>>;
  listRecovery(id: string): Promise<LibraryResult<RecoveryRecord[]>>;
  restoreRecovery(id: string, recoveryRevision: number, expectedRevision: number): Promise<LibraryResult<LibraryRecord>>;
  close(): void;
}
