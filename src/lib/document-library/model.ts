import type { LibraryErrorCode, LibraryLimits, LibraryPutInput, LibraryRecord, LibraryResult, RecoveryRecord } from "./types";

export const DEFAULT_LIBRARY_LIMITS: Readonly<LibraryLimits> = Object.freeze({
  maxRecords: 1000,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxExtractedTextCodeUnits: 1024 * 1024,
  maxRecoveryPerDocument: 5,
  maxRecoveryRecords: 5000,
});
export const LIBRARY_FORMATS = ["markdown", "darkmown", "text", "csv", "json", "yaml", "xml", "docx", "doc", "rtf", "odt"] as const;
export class LibraryFailure extends Error {
  constructor(readonly code: LibraryErrorCode, message: string, readonly actualRevision?: number | null) { super(message); }
}
export function fail(code: LibraryErrorCode, message: string, actualRevision?: number | null): never { throw new LibraryFailure(code, message, actualRevision); }
export function asFailure<T>(cause: unknown): LibraryResult<T> {
  if (cause instanceof LibraryFailure) return { ok: false, error: { code: cause.code, message: cause.message, ...(cause.actualRevision !== undefined ? { actualRevision: cause.actualRevision } : {}) } };
  const name = cause && typeof cause === "object" && "name" in cause ? cause.name : "";
  return { ok: false, error: { code: name === "QuotaExceededError" ? "storage-quota" : "storage-unavailable", message: name === "QuotaExceededError" ? "Browser storage is full. Export your work before freeing space." : "Document storage is unavailable. Your work has not been durably saved." } };
}
export function resolveLimits(overrides: Partial<LibraryLimits> = {}): LibraryLimits {
  const limits = { ...DEFAULT_LIBRARY_LIMITS, ...overrides };
  if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 1)) fail("invalid-input", "Library limits must be positive safe integers.");
  return limits;
}
export function validateId(value: unknown, code: "invalid-input" | "corrupt-storage" = "invalid-input"): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) fail(code, "Invalid document identifier.");
}
export function validateRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid-input", "Expected revision must be a positive safe integer.");
}
function object(value: unknown, code: "invalid-input" | "corrupt-storage"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "Invalid document record.");
  return value as Record<string, unknown>;
}
function checkFields(value: Record<string, unknown>, allowed: string[], code: "invalid-input" | "corrupt-storage") {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code, "Unexpected document record fields.");
}
const intrinsicTypedArrayName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
function isUnsignedByteArray(value: unknown): value is Uint8Array {
  try {
    // instanceof crosses neither iframe/worker realms nor jsdom's structuredClone boundary.
    // The intrinsic getter also rejects other typed arrays with a forged toStringTag.
    return ArrayBuffer.isView(value) && intrinsicTypedArrayName?.call(value) === "Uint8Array" && Object.prototype.toString.call(value) === "[object Uint8Array]";
  } catch { return false; }
}
function metadata(value: Record<string, unknown>, limits: LibraryLimits, code: "invalid-input" | "corrupt-storage") {
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || /[\0/\\]/.test(value.name)) fail(code, "Document name must be a filename of 1–256 characters.");
  if (!LIBRARY_FORMATS.includes(value.format as typeof LIBRARY_FORMATS[number])) fail(code, "Unsupported library document format.");
  if (!isUnsignedByteArray(value.bytes)) fail(code, "Document bytes must be a Uint8Array.");
  if (value.bytes.byteLength > limits.maxDocumentBytes) fail("limit-exceeded", "Document exceeds the library byte budget.");
  if (!Array.isArray(value.tags) || value.tags.length > 32 || value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 64) || new Set(value.tags).size !== value.tags.length) fail(code, "Invalid or duplicate document tags.");
  if (value.collection !== null && (typeof value.collection !== "string" || !value.collection.trim() || value.collection.length > 128)) fail(code, "Invalid document collection.");
  if (value.extractedText !== undefined && (typeof value.extractedText !== "string" || value.extractedText.length > limits.maxExtractedTextCodeUnits)) fail(code, "Extracted text exceeds the allowed length or is invalid.");
}
export function snapshotInput(input: LibraryPutInput, limits: LibraryLimits): LibraryPutInput & { tags: string[]; collection: string | null } {
  const v = object(input, "invalid-input");
  checkFields(v, ["id", "name", "format", "bytes", "tags", "collection", "extractedText"], "invalid-input");
  if (v.id !== undefined) validateId(v.id);
  const normalized = { ...v, tags: v.tags ?? [], collection: v.collection ?? null };
  metadata(normalized, limits, "invalid-input");
  return { ...(normalized as unknown as LibraryPutInput), bytes: new Uint8Array(input.bytes), tags: [...normalized.tags as string[]], collection: normalized.collection as string | null };
}
export function validateRecord(value: unknown, limits: LibraryLimits): LibraryRecord {
  const v = object(value, "corrupt-storage");
  checkFields(v, ["schemaVersion", "id", "name", "format", "bytes", "createdAt", "updatedAt", "revision", "exportedRevision", "tags", "collection", "extractedText"], "corrupt-storage");
  if (v.schemaVersion !== 1) fail("corrupt-storage", "Unsupported stored document schema.");
  validateId(v.id, "corrupt-storage"); metadata(v, limits, "corrupt-storage");
  if (!Number.isSafeInteger(v.createdAt) || !Number.isSafeInteger(v.updatedAt) || (v.createdAt as number) < 0 || (v.updatedAt as number) < (v.createdAt as number) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 || (v.exportedRevision !== null && (!Number.isSafeInteger(v.exportedRevision) || (v.exportedRevision as number) < 1 || (v.exportedRevision as number) > (v.revision as number)))) fail("corrupt-storage", "Invalid stored document revision or timestamp.");
  return v as unknown as LibraryRecord;
}
export function validateRecovery(value: unknown, limits: LibraryLimits): RecoveryRecord {
  const v = object(value, "corrupt-storage");
  checkFields(v, ["schemaVersion", "documentId", "revision", "savedAt", "record"], "corrupt-storage");
  const record = validateRecord(v.record, limits);
  if (v.schemaVersion !== 1 || v.documentId !== record.id || v.revision !== record.revision || v.savedAt !== record.updatedAt) fail("corrupt-storage", "Invalid recovery revision metadata.");
  return v as unknown as RecoveryRecord;
}
export function cloneRecord(record: LibraryRecord): LibraryRecord { return { ...record, bytes: new Uint8Array(record.bytes), tags: [...record.tags] }; }
export function cloneRecovery(record: RecoveryRecord): RecoveryRecord { return { ...record, record: cloneRecord(record.record) }; }
export function recordBytes(record: LibraryRecord): number {
  return record.bytes.byteLength + 2 * (record.name.length + record.id.length + record.format.length + (record.collection?.length ?? 0) + (record.extractedText?.length ?? 0) + record.tags.reduce((sum, tag) => sum + tag.length, 0)) + 64;
}
export function recoveryBytes(recovery: RecoveryRecord): number { return recordBytes(recovery.record) + 2 * recovery.documentId.length + 32; }
