export type AdditionalDocumentFormat = "rtf" | "html" | "odt";
export type DocumentImportErrorCode = "malformed" | "unsupported" | "encrypted" | "limit-exceeded" | "platform-unavailable";
export interface DocumentImportLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxTextCodeUnits: number;
  maxDepth: number;
  maxNodes: number;
  maxArchiveEntries: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxControlWords: number;
}
export const DEFAULT_DOCUMENT_IMPORT_LIMITS: Readonly<DocumentImportLimits> = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 32 * 1024 * 1024,
  maxTextCodeUnits: 8 * 1024 * 1024, maxDepth: 128, maxNodes: 100000,
  maxArchiveEntries: 2048, maxExpandedBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 1000, maxControlWords: 1000000,
});
export class DocumentImportError extends Error {
  constructor(readonly code: DocumentImportErrorCode, message: string) { super(message); this.name = "DocumentImportError"; }
}
export interface ImportedDocumentText { text: string; warnings: string[] }
export interface AdditionalDocumentInput { name: string; bytes: Uint8Array; format: AdditionalDocumentFormat }
export type AdditionalDocumentConversion = {
  ok: true; kind: "converted-text-copy"; sourceFormat: AdditionalDocumentFormat;
  name: string; text: string; bytes: Uint8Array; warnings: string[]; canWriteOriginal: false;
} | { ok: false; error: { code: DocumentImportErrorCode; message: string } };

export function resolveDocumentImportLimits(overrides: Partial<DocumentImportLimits> = {}): DocumentImportLimits {
  const limits = { ...DEFAULT_DOCUMENT_IMPORT_LIMITS, ...overrides };
  if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 1)) throw new DocumentImportError("limit-exceeded", "Document import limits must be positive safe integers.");
  return limits;
}
export function decodeImportText(bytes: Uint8Array, utf8Only = false): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      if (utf8Only || bytes.length % 2) throw new Error();
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      if (utf8Only || bytes.length % 2) throw new Error();
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw new DocumentImportError("unsupported", utf8Only ? "This package requires valid UTF-8 XML." : "HTML text must use UTF-8 or BOM-labelled UTF-16; other encodings are not converted."); }
}
export function textAccumulator(limits: DocumentImportLimits) {
  const chunks: string[] = []; let length = 0;
  return {
    append(text: string) {
      if (text.length > limits.maxTextCodeUnits - length) throw new DocumentImportError("limit-exceeded", "Converted text exceeds the character budget.");
      length += text.length; chunks.push(text);
    },
    result: () => chunks.join(""),
  };
}
