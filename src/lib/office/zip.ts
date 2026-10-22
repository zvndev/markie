/**
 * Original bounded ZIP implementation from PKWARE APPNOTE 6.3.10, §§4.3–4.4.
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * No document/ZIP engine source was consulted. ZIP64, encryption and split
 * archives are deliberately unsupported. Inflation uses the browser platform.
 */
export interface ZipLimits {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: Readonly<ZipLimits> = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntries: 2048,
  maxCompressionRatio: 1000,
});

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export class ZipError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export function resolveZipLimits(options: Partial<ZipLimits> = {}): ZipLimits {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ZipError("invalid-limit", `${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

// Unlike an XML byte-order mark, U+FEFF inside a ZIP filename is part of its
// identity. Do not let TextDecoder silently strip and alias it to another name.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function validateZipPath(name: string): void {
  // Reject aliases as well as traversal. We never extract to disk, but a
  // package must not have two names that another consumer treats as one part.
  if (!name || name.startsWith("/") || /[\\\x00-\x20\x7f:%?#]/.test(name)
    || name.split("/").some((piece, i, pieces) =>
      piece === "." || piece === ".." || (!piece && i !== pieces.length - 1))) {
    throw new ZipError("unsafe-path", `Unsafe ZIP part name: ${name.slice(0, 160)}`);
  }
}

export function zipCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(data: Uint8Array, expected: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError("platform-unavailable", "This browser cannot decompress DOCX files.");
  }
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    throw new ZipError("platform-unavailable", "This browser does not support raw DEFLATE.");
  }
  const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(stream).getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > expected) {
        await reader.cancel();
        throw new ZipError("expansion-limit", "ZIP entry expanded beyond its declared size.");
      }
      pieces.push(result.value);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("invalid-deflate", "ZIP entry contains invalid DEFLATE data.");
  } finally {
    reader.releaseLock();
  }
  if (size !== expected) throw new ZipError("size-mismatch", "ZIP entry size does not match its header.");
  const output = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    output.set(piece, offset);
    offset += piece.length;
  }
  return output;
}

export async function readZip(input: Uint8Array, options: Partial<ZipLimits> = {}): Promise<ZipEntry[]> {
  const limits = resolveZipLimits(options);
  if (input.length > limits.maxArchiveBytes) throw new ZipError("archive-limit", "DOCX exceeds the archive size limit.");
  // Copy before the first await: caller-owned buffers cannot mutate preflight.
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer);
  const requireBytes = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > bytes.length) {
      throw new ZipError("truncated-zip", "Truncated ZIP structure.");
    }
  };
  const checkExtra = (offset: number, length: number) => {
    const end = offset + length;
    while (offset < end) {
      if (offset + 4 > end) throw new ZipError("invalid-extra", "Truncated ZIP extra field.");
      const id = view.getUint16(offset, true);
      const size = view.getUint16(offset + 2, true);
      if (offset + 4 + size > end) throw new ZipError("invalid-extra", "ZIP extra field exceeds its header.");
      if ([0x0001, 0x0017, 0x9901, 0x7075].includes(id)) {
        throw new ZipError("unsupported-zip", "ZIP64, encryption and alternate-name extra fields are unsupported.");
      }
      offset += 4 + size;
    }
  };
  if (bytes.length < 22) throw new ZipError("invalid-zip", "Not a supported ZIP package.");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new ZipError("invalid-zip", "ZIP end record is missing or trailing data is present.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== count || count === 0xffff
    || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
    throw new ZipError("unsupported-zip", "Split and ZIP64 archives are not supported.");
  }
  if (count > limits.maxEntries) throw new ZipError("entry-limit", "DOCX contains too many ZIP entries.");
  if (directoryStart + directorySize !== end) throw new ZipError("invalid-directory", "ZIP directory bounds are invalid.");
  const names = new Set<string>();
  const records: { name: string; method: number; size: number; crc: number; start: number; end: number; dataStart: number; compressed: number }[] = [];
  let cursor = directoryStart;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    requireBytes(cursor, 46);
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new ZipError("invalid-directory", "Invalid ZIP directory entry.");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameSize = view.getUint16(cursor + 28, true);
    const extraSize = view.getUint16(cursor + 30, true);
    const commentSize = view.getUint16(cursor + 32, true);
    const start = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    requireBytes(cursor, next - cursor);
    if (next > end || view.getUint16(cursor + 34, true) !== 0
      || view.getUint16(cursor + 6, true) > 20 || (flags & ~0x080e)
      || (method !== 0 && method !== 8) || start === 0xffffffff
      || compressed === 0xffffffff || size === 0xffffffff) {
      throw new ZipError("unsupported-zip", "Encrypted, ZIP64 or unsupported ZIP entries are not accepted.");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    checkExtra(cursor + 46 + nameSize, extraSize);
    if (!(flags & 0x0800) && rawName.some((b) => b > 127)) {
      throw new ZipError("unsupported-name", "Non-UTF-8 ZIP names are unsupported.");
    }
    let name: string;
    try { name = utf8.decode(rawName); } catch { throw new ZipError("invalid-name", "Invalid UTF-8 ZIP name."); }
    validateZipPath(name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new ZipError("duplicate-part", "ZIP contains duplicate or ambiguous part names.");
    names.add(key);
    expanded += size;
    if (size > limits.maxEntryBytes || expanded > limits.maxExpandedBytes
      || size > Math.max(1, compressed) * limits.maxCompressionRatio) {
      throw new ZipError("expansion-limit", "DOCX exceeds the ZIP expansion limit.");
    }
    if (method === 0 && compressed !== size) throw new ZipError("size-mismatch", "Stored ZIP entry has inconsistent sizes.");
    const unixMode = view.getUint32(cursor + 38, true) >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw new ZipError("unsafe-path", "ZIP symlinks are not accepted.");
    requireBytes(start, 30);
    const localNameSize = view.getUint16(start + 26, true);
    const localExtraSize = view.getUint16(start + 28, true);
    const dataStart = start + 30 + localNameSize + localExtraSize;
    requireBytes(start, dataStart - start + compressed);
    checkExtra(start + 30 + localNameSize, localExtraSize);
    if (view.getUint32(start, true) !== 0x04034b50
      || view.getUint16(start + 6, true) !== flags || view.getUint16(start + 8, true) !== method
      || view.getUint16(start + 4, true) !== view.getUint16(cursor + 6, true)
      || localNameSize !== nameSize
      || !rawName.every((byte, i) => bytes[start + 30 + i] === byte)) {
      throw new ZipError("header-mismatch", "ZIP local and central headers disagree.");
    }
    let entryEnd = dataStart + compressed;
    if (flags & 8) {
      if ((view.getUint32(start + 14, true) && view.getUint32(start + 14, true) !== crc)
        || (view.getUint32(start + 18, true) && view.getUint32(start + 18, true) !== compressed)
        || (view.getUint32(start + 22, true) && view.getUint32(start + 22, true) !== size)) {
        throw new ZipError("header-mismatch", "ZIP streamed local header disagrees with its directory.");
      }
      requireBytes(entryEnd, 12);
      const descriptor = view.getUint32(entryEnd, true) === 0x08074b50 ? entryEnd + 4 : entryEnd;
      requireBytes(descriptor, 12);
      if (view.getUint32(descriptor, true) !== crc || view.getUint32(descriptor + 4, true) !== compressed
        || view.getUint32(descriptor + 8, true) !== size) {
        throw new ZipError("header-mismatch", "ZIP data descriptor disagrees with the directory.");
      }
      entryEnd = descriptor + 12;
    } else if (view.getUint32(start + 14, true) !== crc || view.getUint32(start + 18, true) !== compressed
      || view.getUint32(start + 22, true) !== size) {
      throw new ZipError("header-mismatch", "ZIP entry sizes or CRC disagree.");
    }
    if (entryEnd > directoryStart) throw new ZipError("overlapping-entry", "ZIP entry overlaps its directory.");
    if (name.endsWith("/") && size !== 0) throw new ZipError("invalid-directory", "ZIP directory entry contains data.");
    records.push({ name, method, size, crc, start, end: entryEnd, dataStart, compressed });
    cursor = next;
  }
  if (cursor !== end) throw new ZipError("invalid-directory", "ZIP directory contains unsupported records.");
  const ordered = [...records].sort((a, b) => a.start - b.start);
  let localEnd = 0;
  for (const record of ordered) {
    if (record.start !== localEnd) throw new ZipError("overlapping-entry", "ZIP has overlapping, hidden or prefixed records.");
    localEnd = record.end;
  }
  if (localEnd !== directoryStart) throw new ZipError("invalid-directory", "ZIP contains unaccounted local data.");
  const entries: ZipEntry[] = [];
  for (const record of records) {
    const compressed = bytes.subarray(record.dataStart, record.dataStart + record.compressed);
    const data = record.method === 0 ? new Uint8Array(compressed) : await inflate(compressed, record.size);
    if (zipCrc32(data) !== record.crc) throw new ZipError("crc-mismatch", `ZIP integrity check failed for ${record.name}.`);
    entries.push({ name: record.name, data });
  }
  return entries;
}

/** Writes conventional stored entries; unrelated part *contents* are unchanged. */
export function writeZip(entries: readonly ZipEntry[], options: Partial<ZipLimits> = {}): Uint8Array {
  const limits = resolveZipLimits(options);
  if (entries.length > Math.min(65534, limits.maxEntries)) throw new ZipError("entry-limit", "Too many ZIP entries.");
  const names = new Set<string>();
  let expanded = 0;
  const records = entries.map(({ name, data }) => {
    validateZipPath(name);
    if (names.has(name.toLowerCase())) throw new ZipError("duplicate-part", "Duplicate ZIP part.");
    names.add(name.toLowerCase());
    const encoded = encoder.encode(name);
    expanded += data.length;
    if (encoded.length > 65535 || data.length > limits.maxEntryBytes || expanded > limits.maxExpandedBytes) {
      throw new ZipError("expansion-limit", "ZIP output exceeds its limits.");
    }
    return { name: encoded, data, crc: zipCrc32(data) };
  });
  const total = records.reduce((size, r) => size + 76 + 2 * r.name.length + r.data.length, 22);
  if (total > limits.maxArchiveBytes) throw new ZipError("archive-limit", "ZIP output exceeds the archive size limit.");
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let cursor = 0;
  const offsets: number[] = [];
  for (const record of records) {
    offsets.push(cursor);
    view.setUint32(cursor, 0x04034b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0x0800, true);
    view.setUint16(cursor + 12, 0x21, true); // 1980-01-01; deterministic generated archive.
    view.setUint32(cursor + 14, record.crc, true);
    view.setUint32(cursor + 18, record.data.length, true);
    view.setUint32(cursor + 22, record.data.length, true);
    view.setUint16(cursor + 26, record.name.length, true);
    output.set(record.name, cursor + 30);
    output.set(record.data, cursor + 30 + record.name.length);
    cursor += 30 + record.name.length + record.data.length;
  }
  const directory = cursor;
  records.forEach((record, i) => {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, 0x0800, true);
    view.setUint16(cursor + 14, 0x21, true);
    view.setUint32(cursor + 16, record.crc, true);
    view.setUint32(cursor + 20, record.data.length, true);
    view.setUint32(cursor + 24, record.data.length, true);
    view.setUint16(cursor + 28, record.name.length, true);
    view.setUint32(cursor + 42, offsets[i], true);
    output.set(record.name, cursor + 46);
    cursor += 46 + record.name.length;
  });
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, records.length, true);
  view.setUint16(cursor + 10, records.length, true);
  view.setUint32(cursor + 12, cursor - directory, true);
  view.setUint32(cursor + 16, directory, true);
  return output;
}
