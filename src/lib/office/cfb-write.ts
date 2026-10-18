/**
 * Original bounded v3 root-stream writer from public Microsoft [MS-CFB] only.
 * Sections 2.2–2.7 and 2.9: header, FAT/miniFAT/DIFAT, directory and size limits.
 * https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b
 * This writes a container, not Word document structures. No document engine used.
 */
import { DEFAULT_CFB_LIMITS, type CfbFailure, type CfbLimits } from "./cfb";

export interface CfbWriteStream { readonly name: string; readonly data: Uint8Array }
export type CfbWriteResult = { ok: true; data: Uint8Array } | CfbFailure;
const FREE = 0xffffffff, END = 0xfffffffe, FAT = 0xfffffffd, DIFAT = 0xfffffffc;
const SECTOR = 512, MINI = 64, CUTOFF = 4096;
class WriteError extends Error {
  constructor(readonly code: CfbFailure["error"]["code"], message: string) { super(message); }
}
function fail(code: CfbFailure["error"]["code"], message: string): never { throw new WriteError(code, message); }
const fold = (name: string) => name.replace(/[a-z]/g, (c) => c.toUpperCase());

/**
 * Creates a new, deterministic container; does not mutate or retain input buffers.
 * Root streams only, with 1–31 ASCII code units (including OLE property-name prefixes).
 * Unicode naming is deliberately unsupported until its simple-uppercase mapping and
 * reader lookup are implemented together. Limits include metadata and padded entries.
 * maxTotalStreamBytes covers all payloads plus the root mini stream once, so every
 * output stream can be read once under the same reader limits.
 */
export function writeCompoundFile(streams: readonly CfbWriteStream[], overrides: Partial<CfbLimits> = {}): CfbWriteResult {
  try {
    const limits = { ...DEFAULT_CFB_LIMITS, ...overrides };
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0) fail("limit-exceeded", "CFB limits must be nonnegative safe integers.");
    }
    if (!Array.isArray(streams)) fail("malformed", "CFB streams must be an array.");
    const directoryCount = Math.ceil((streams.length + 1) / 4);
    if (directoryCount * 4 > limits.maxDirectoryEntries) fail("limit-exceeded", "Directory exceeds the entry budget.");
    let miniCount = 0, normalCount = 0, totalBytes = 0;
    const names = new Set<string>();
    const ordered = streams.map((stream) => {
      if (!stream || typeof stream.name !== "string" || !(stream.data instanceof Uint8Array)) fail("malformed", "Invalid CFB stream input.");
      const { name, data } = stream;
      if (!name || name.length > 31 || /[\0/\\:!]/.test(name)) fail("malformed", "Invalid CFB stream name.");
      if (!/^[\x01-\x7f]+$/.test(name)) fail("unsupported", "Only ASCII root stream names can be written.");
      const key = fold(name);
      if (names.has(key)) fail("malformed", "Duplicate root stream name.");
      names.add(key);
      if (data.length > limits.maxStreamBytes || data.length >= 0x80000000) fail("limit-exceeded", "Stream exceeds the byte budget.");
      if (data.length > limits.maxTotalStreamBytes - totalBytes) fail("limit-exceeded", "Streams exceed the cumulative byte budget.");
      totalBytes += data.length;
      const small = data.length < CUTOFF;
      const count = Math.ceil(data.length / (small ? MINI : SECTOR));
      if (count > limits.maxChainSectors) fail("limit-exceeded", "Stream exceeds the chain budget.");
      if (small) miniCount += count; else normalCount += count;
      return { name, key, data, count, start: END };
    }).sort((a, b) => a.key.length - b.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const miniBytes = miniCount * MINI;
    const miniRootCount = Math.ceil(miniBytes / SECTOR), miniFatCount = Math.ceil(miniCount / 128);
    if (miniBytes > limits.maxStreamBytes || miniBytes >= 0x80000000 || totalBytes + miniBytes > limits.maxTotalStreamBytes) fail("limit-exceeded", "Streams exceed the cumulative byte budget.");
    const baseCount = directoryCount + miniFatCount + miniRootCount + normalCount;
    // FAT must cover itself and DIFAT too. Monotone fixed point terminates in a
    // handful of iterations; no allocation depends on unchecked caller sizes.
    let fatCount = 1, difatCount = 0;
    for (;;) {
      const nextFat = Math.ceil((baseCount + fatCount + difatCount) / 128);
      const nextDifat = Math.ceil(Math.max(0, nextFat - 109) / 127);
      if (nextFat === fatCount && nextDifat === difatCount) break;
      fatCount = nextFat; difatCount = nextDifat;
    }
    const sectorCount = baseCount + fatCount + difatCount;
    const outputBytes = (sectorCount + 1) * SECTOR;
    if (outputBytes > limits.maxInputBytes || outputBytes > 0x80000000 || sectorCount > limits.maxSectors) fail("limit-exceeded", "Compound file exceeds the output budget.");
    for (const count of [directoryCount, miniFatCount, miniRootCount, fatCount, difatCount]) {
      if (count > limits.maxChainSectors) fail("limit-exceeded", "Metadata exceeds the chain budget.");
    }
    const bytes = new Uint8Array(outputBytes), view = new DataView(bytes.buffer);
    const w16 = (at: number, value: number) => view.setUint16(at, value, true);
    const w32 = (at: number, value: number) => view.setUint32(at, value, true);
    const offset = (id: number) => (id + 1) * SECTOR;
    const directoryAt = fatCount + difatCount, miniFatAt = directoryAt + directoryCount;
    const miniRootAt = miniFatAt + miniFatCount;
    let normalAt = miniRootAt + miniRootCount, miniAt = 0;
    const setFat = (id: number, value: number) => w32(offset(Math.floor(id / 128)) + (id % 128) * 4, value);
    const link = (start: number, count: number) => {
      for (let i = 0; i < count; i++) setFat(start + i, i + 1 === count ? END : start + i + 1);
    };
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    w16(24, 0x3e); w16(26, 3); w16(28, 0xfffe); w16(30, 9); w16(32, 6);
    w32(44, fatCount); w32(48, directoryAt); w32(56, CUTOFF);
    w32(60, miniFatCount ? miniFatAt : END); w32(64, miniFatCount);
    w32(68, difatCount ? fatCount : END); w32(72, difatCount);
    for (let i = 0; i < 109; i++) w32(76 + i * 4, i < fatCount ? i : FREE);
    for (let i = 0; i < fatCount * 128; i++) w32(SECTOR + i * 4, FREE);
    for (let i = 0; i < fatCount; i++) setFat(i, FAT);
    for (let i = 0; i < difatCount; i++) {
      const id = fatCount + i; setFat(id, DIFAT);
      for (let j = 0; j < 127; j++) {
        const fatId = 109 + i * 127 + j;
        w32(offset(id) + j * 4, fatId < fatCount ? fatId : FREE);
      }
      w32(offset(id) + 508, i + 1 === difatCount ? END : id + 1);
    }
    link(directoryAt, directoryCount); link(miniFatAt, miniFatCount); link(miniRootAt, miniRootCount);
    for (let i = 0; i < miniFatCount * 128; i++) w32(offset(miniFatAt) + i * 4, FREE);
    for (const stream of ordered) {
      if (stream.data.length >= CUTOFF) {
        stream.start = normalAt; link(normalAt, stream.count);
        bytes.set(stream.data, offset(normalAt)); normalAt += stream.count;
      } else if (stream.count) {
        stream.start = miniAt;
        for (let i = 0; i < stream.count; i++) w32(offset(miniFatAt) + (miniAt + i) * 4, i + 1 === stream.count ? END : miniAt + i + 1);
        bytes.set(stream.data, offset(miniRootAt) + miniAt * MINI); miniAt += stream.count;
      }
    }
    const entryOffset = (id: number) => offset(directoryAt) + id * 128;
    // All unallocated directory entries have zero fields except absent pointers.
    for (let i = 0; i < directoryCount * 4; i++) {
      const at = entryOffset(i); w32(at + 68, FREE); w32(at + 72, FREE); w32(at + 76, FREE);
    }
    const entry = (id: number, name: string, type: number, start: number, size: number) => {
      const at = entryOffset(id);
      for (let i = 0; i < name.length; i++) w16(at + i * 2, name.charCodeAt(i));
      w16(at + 64, (name.length + 1) * 2); bytes[at + 66] = type; bytes[at + 67] = 1;
      w32(at + 116, start); w32(at + 120, size);
    };
    entry(0, "Root Entry", 5, miniRootCount ? miniRootAt : END, miniBytes);
    ordered.forEach((stream, i) => entry(i + 1, stream.name, 2, stream.start, stream.data.length));
    // Median split balances siblings. Only the incomplete bottom level is red,
    // keeping equal black heights and preventing adjacent red nodes [2.6.4].
    const redDepth = Math.floor(Math.log2(ordered.length + 1));
    const tree = (lo: number, hi: number, depth: number): number => {
      if (lo > hi) return FREE;
      const mid = Math.floor((lo + hi) / 2), id = mid + 1, at = entryOffset(id);
      bytes[at + 67] = depth === redDepth ? 0 : 1;
      w32(at + 68, tree(lo, mid - 1, depth + 1)); w32(at + 72, tree(mid + 1, hi, depth + 1));
      return id;
    };
    w32(entryOffset(0) + 76, tree(0, ordered.length - 1, 0));
    return { ok: true, data: bytes };
  } catch (error) {
    if (error instanceof WriteError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "malformed", message: "Compound file could not be written." } };
  }
}
