import { DEFAULT_CFB_LIMITS, readCompoundFile, type CfbErrorCode, type CfbFailure, type CfbLimits } from "./cfb";

/**
 * Original Word 97–2003 main-story text extraction, not a DOC editor or writer.
 * Public [MS-DOC] specification provenance:
 * 2.5.1 Fib: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/9aeaa2e7-4a45-468e-ab13-3f6193eb9394
 * 2.4.1 Retrieving Text: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01
 * No other document-engine implementation was used.
 */
export interface LegacyDocLimits extends CfbLimits {
  maxTextCodeUnits: number;
  maxPieces: number;
  maxClxBytes: number;
  maxPropertyRecords: number;
}
export const DEFAULT_LEGACY_DOC_LIMITS: Readonly<LegacyDocLimits> = Object.freeze({
  ...DEFAULT_CFB_LIMITS,
  maxTextCodeUnits: 8 * 1024 * 1024,
  maxPieces: 100000,
  maxClxBytes: 4 * 1024 * 1024,
  maxPropertyRecords: 10000,
});
export type LegacyDocResult = {
  ok: true;
  kind: "text-extraction";
  canWrite: false;
  /** Main-story characters in CP order, with Word paragraph CR normalized to LF. */
  text: string;
  /** Main-story UTF-16 code units, retaining Word control characters. */
  rawText: string;
  warnings: string[];
} | CfbFailure;

class DocParseError extends Error {
  constructor(readonly code: CfbErrorCode, message: string) { super(message); }
}
function fail(code: CfbErrorCode, message: string): never { throw new DocParseError(code, message); }
function checkedView(bytes: Uint8Array, at: number, length: number, label: string): DataView {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at > bytes.length - length) fail("malformed", `Truncated or out-of-range ${label}.`);
  return new DataView(bytes.buffer, bytes.byteOffset + at, length);
}
const PAIR_COUNTS: Readonly<Record<number, number>> = { 0xc1: 0x5d, 0xd9: 0x6c, 0x101: 0x88, 0x10c: 0xa4 };
const EXTENSION_COUNTS: Readonly<Record<number, number>> = { 0xc1: 0, 0xd9: 2, 0x101: 2, 0x10c: 2 };

// [MS-DOC] 2.9.73 FcCompressed specifies this exact mapping, not an arbitrary ANSI codepage.
// 0x80/0x8D/0x8E/0x8F/0x90/0x9D/0x9E remain their numeric Unicode values.
// https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/aa2e55a2-f4f2-4795-bab5-6d9d7a0ed249
const COMPRESSED_UNICODE: Readonly<Record<number, number>> = {
  0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039,
  0x8c: 0x0152, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d,
  0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122,
  0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9f: 0x0178,
};

export function extractLegacyDocText(input: Uint8Array, overrides: Partial<LegacyDocLimits> = {}): LegacyDocResult {
  try {
    const limits = { ...DEFAULT_LEGACY_DOC_LIMITS, ...overrides };
    if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 0)) fail("limit-exceeded", "DOC limits must be nonnegative safe integers.");
    const container = readCompoundFile(input, limits);
    if (!container.ok) return container;
    const { file } = container;
    if (file.rootStreamNames.some((n) => n === "EncryptedPackage" || n === "EncryptionInfo")) fail("encrypted", "Encrypted Office packages are not supported.");
    const word = file.readRootStream("WordDocument");
    if (!word.ok) return word;
    const bytes = word.data;
    const base = checkedView(bytes, 0, 32, "FIB base");
    // [MS-DOC] 2.5.2 FibBase: signature, encryption bit 8, table-selection bit 9.
    // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/26fb6c06-4e5c-4778-ab4e-edbf26a545bb
    if (base.getUint16(0, true) !== 0xa5ec) fail("unsupported", "The WordDocument stream is not a supported Word binary file.");
    const baseVersion = base.getUint16(2, true), flags = base.getUint16(10, true);
    if (flags & 0x100) fail("encrypted", "Encrypted or XOR-obfuscated DOC files are not supported.");
    if (!(baseVersion in PAIR_COUNTS)) fail("unsupported", "Only Word 97, 2000, 2002, and 2003 binary FIB versions are supported; Word 6/95 is not supported.");
    let cursor = 32;
    const readCounted = (width: number, label: string) => {
      const count = checkedView(bytes, cursor, 2, label).getUint16(0, true);
      cursor += 2;
      const data = checkedView(bytes, cursor, count * width, label);
      cursor += count * width;
      return { count, data };
    };
    // [MS-DOC] 2.5.15: advance by the counted sections, never fixed file offsets.
    const words = readCounted(2, "FibRgW97");
    const longs = readCounted(4, "FibRgLw97");
    const pairs = readCounted(8, "FibRgFcLcb");
    const extension = readCounted(2, "FibRgCswNew");
    if (words.count !== 14 || longs.count !== 22) fail("malformed", "Invalid Word 97+ FIB section counts.");
    const version = extension.count ? extension.data.getUint16(0, true) : baseVersion;
    if (!(version in PAIR_COUNTS)) fail("unsupported", "The extended DOC FIB version is outside the supported Word 97–2003 scope.");
    if (pairs.count !== PAIR_COUNTS[version] || extension.count !== EXTENSION_COUNTS[version]) fail("malformed", "FIB counts do not match the declared DOC version.");
    // [MS-DOC] 2.5.4 FibRgLw97: cbMac at index 0, ccpText at index 3.
    // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/37713d3c-a0c8-40f5-821f-bc9622c7de48
    const cbMac = longs.data.getUint32(0, true), ccpText = longs.data.getInt32(12, true);
    if (cbMac < cursor || cbMac > bytes.length || ccpText < 0) fail("malformed", "Invalid WordDocument byte or character extent.");
    if (ccpText > limits.maxTextCodeUnits) fail("limit-exceeded", "Main-story text exceeds the character budget.");
    const subCounts = [4, 5, 7, 8, 9, 10].map((i) => longs.data.getInt32(i * 4, true));
    if (subCounts.some((v) => v < 0)) fail("malformed", "Negative subdocument character count.");
    const subCount = subCounts.reduce((sum, v) => sum + v, 0);
    const finalCp = ccpText + subCount + (subCount ? 1 : 0);
    if (finalCp > 0x7fffffff) fail("malformed", "Invalid combined character extent.");
    // [MS-DOC] 2.5.6: fcClx/lcbClx are the 34th fc/lcb pair (zero-based 33).
    // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/0c9df81f-98d0-454e-ad84-b612cd05b1a4
    const fcClx = pairs.data.getUint32(33 * 8, true), lcbClx = pairs.data.getUint32(33 * 8 + 4, true);
    if (lcbClx === 0) fail("unsupported", "A CLX piece table is required by this text extractor.");
    if (lcbClx > limits.maxClxBytes) fail("limit-exceeded", "CLX exceeds the byte budget.");
    const table = file.readRootStream(flags & 0x200 ? "1Table" : "0Table");
    if (!table.ok) return table.error.code === "unsupported" ? { ok: false, error: { code: "malformed", message: "The FIB-selected Table stream is missing." } } : table;
    const clx = checkedView(table.data, fcClx, lcbClx, "CLX");
    let at = 0, propertyRecords = 0;
    // [MS-DOC] 2.9.38/209/210: zero or more 0x01 Prc records precede 0x02 Pcdt.
    // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/473fd992-c824-4655-8880-3186bd432f80
    while (at < clx.byteLength && clx.getUint8(at) === 1) {
      if (++propertyRecords > limits.maxPropertyRecords) fail("limit-exceeded", "CLX exceeds the property-record budget.");
      if (at > clx.byteLength - 3) fail("malformed", "Truncated CLX property record.");
      const length = clx.getInt16(at + 1, true);
      if (length < 0 || length > 0x3fa2 || length > clx.byteLength - at - 3) fail("malformed", "Invalid CLX property record length.");
      at += 3 + length;
    }
    if (at > clx.byteLength - 5 || clx.getUint8(at) !== 2) fail("malformed", "CLX does not contain a valid piece table.");
    const plcLength = clx.getUint32(at + 1, true);
    at += 5;
    // [MS-DOC] 2.8.35/2.9.178: n+1 four-byte CPs followed by n eight-byte Pcds.
    // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/1caae71f-35c4-49d7-adf0-af5fc766331c
    if (plcLength < 4 || (plcLength - 4) % 12 || plcLength !== clx.byteLength - at) fail("malformed", "Invalid piece-table byte count.");
    const pieceCount = (plcLength - 4) / 12;
    if (pieceCount > limits.maxPieces) fail("limit-exceeded", "Piece table exceeds the piece budget.");
    const cps: number[] = [];
    for (let i = 0; i <= pieceCount; i++) {
      const cp = clx.getInt32(at + i * 4, true);
      if (cp < 0 || (i === 0 && cp !== 0) || (i > 0 && cp <= cps[i - 1])) fail("malformed", "Piece-table character positions are invalid or not strictly increasing.");
      cps.push(cp);
    }
    if (cps[pieceCount] !== finalCp) fail("malformed", "Piece table does not cover the declared document stories.");
    const pcdStart = at + (pieceCount + 1) * 4;
    const chunks: string[] = [];
    for (let i = 0; i < pieceCount; i++) {
      // [MS-DOC] 2.9.177: FcCompressed begins two bytes into each Pcd.
      const fc = clx.getUint32(pcdStart + i * 8 + 2, true);
      const compressed = (fc & 0x40000000) !== 0;
      const encodedOffset = fc & 0x3fffffff;
      if (compressed && encodedOffset % 2) fail("malformed", "Compressed text has a fractional byte offset.");
      const offset = compressed ? encodedOffset / 2 : encodedOffset;
      const width = compressed ? 1 : 2;
      const fullLength = (cps[i + 1] - cps[i]) * width;
      if (offset < cursor || offset > cbMac - fullLength) fail("malformed", "Piece text falls outside the meaningful WordDocument data.");
      const length = Math.max(0, Math.min(cps[i + 1], ccpText) - cps[i]);
      // Chunk String.fromCharCode to bound argument counts and preserve BOMs/lone surrogates.
      for (let p = 0; p < length; p += 4096) {
        const units: number[] = [];
        for (let j = p; j < Math.min(length, p + 4096); j++) {
          const unit = compressed ? bytes[offset + j] : bytes[offset + j * 2] + bytes[offset + j * 2 + 1] * 256;
          units.push(compressed ? (COMPRESSED_UNICODE[unit] ?? unit) : unit);
        }
        chunks.push(String.fromCharCode(...units));
      }
    }
    const rawText = chunks.join("");
    if (rawText.length !== ccpText) fail("malformed", "Main-story character coverage mismatch.");
    return {
      ok: true, kind: "text-extraction", canWrite: false,
      rawText, text: rawText.replace(/\r/g, "\n"),
      warnings: [
        "Text extraction only: formatting, revisions, fields, drawings, and embedded objects are not interpreted; no DOC writing is available.",
        "Only the main story is returned; headers, footnotes, comments, endnotes, and text boxes are omitted. Raw Word control characters are retained in rawText.",
      ],
    };
  } catch (error) {
    if (error instanceof DocParseError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "malformed", message: "Legacy DOC text could not be read." } };
  }
}
