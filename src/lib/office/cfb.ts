/**
 * Original, read-only implementation of Microsoft [MS-CFB], sections 2.2–2.7.
 * Provenance: public specification only; no document-engine implementation used.
 * https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/53989ce4-7b05-4f8d-829b-d08d6148375b
 */
export type CfbErrorCode = "malformed" | "unsupported" | "encrypted" | "limit-exceeded";
export type CfbFailure = { ok: false; error: { code: CfbErrorCode; message: string } };
export type CfbStreamResult = { ok: true; data: Uint8Array } | CfbFailure;
export interface CfbLimits {
  maxInputBytes: number;
  maxSectors: number;
  maxChainSectors: number;
  maxDirectoryEntries: number;
  maxStreamBytes: number;
  /** Cumulative returned stream bytes, including repeated reads and the mini stream. */
  maxTotalStreamBytes: number;
}
export const DEFAULT_CFB_LIMITS: Readonly<CfbLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxSectors: 131072,
  maxChainSectors: 65536,
  maxDirectoryEntries: 16384,
  maxStreamBytes: 32 * 1024 * 1024,
  maxTotalStreamBytes: 64 * 1024 * 1024,
});
export interface CompoundFile {
  readonly majorVersion: 3 | 4;
  readonly rootStreamNames: readonly string[];
  /** ASCII case-insensitive root lookup only; nested storages are not searched. */
  readRootStream(name: string): CfbStreamResult;
}
export type CfbResult = { ok: true; file: CompoundFile } | CfbFailure;

const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

class CfbParseError extends Error {
  constructor(readonly code: CfbErrorCode, message: string) { super(message); }
}
function fail(code: CfbErrorCode, message: string): never { throw new CfbParseError(code, message); }
function resultError(error: unknown): CfbFailure {
  if (error instanceof CfbParseError) return { ok: false, error: { code: error.code, message: error.message } };
  // Do not expose input bytes or implementation exceptions to callers.
  return { ok: false, error: { code: "malformed", message: "Compound file could not be read." } };
}
interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
const asciiName = (name: string) => /^[\x01-\x7f]+$/.test(name);
const foldAscii = (name: string) => name.replace(/[a-z]/g, (c) => c.toUpperCase());

/** Structural metadata is checked eagerly; user stream chains are checked on read. */
export function readCompoundFile(input: Uint8Array, overrides: Partial<CfbLimits> = {}): CfbResult {
  try {
    const limits = { ...DEFAULT_CFB_LIMITS, ...overrides };
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 0) fail("limit-exceeded", "CFB limits must be nonnegative safe integers.");
    }
    if (input.byteLength > limits.maxInputBytes) fail("limit-exceeded", "Compound file exceeds the input budget.");
    if (input.byteLength < 512 || !SIGNATURE.every((v, i) => input[i] === v)) fail("malformed", "Invalid compound file signature or truncated header.");
    // Own a snapshot: later caller mutations must not change already-validated metadata.
    const bytes = new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at: number) => view.getUint16(at, true);
    const u32 = (at: number) => view.getUint32(at, true);
    const majorVersion = u16(26);
    if (majorVersion !== 3 && majorVersion !== 4) fail("unsupported", "Only CFB versions 3 and 4 are supported.");
    // [MS-CFB] 2.2: fixed little endian, 512/4096-byte sectors, 64-byte mini sectors.
    if (u16(28) !== 0xfffe || u16(30) !== (majorVersion === 3 ? 9 : 12) || u16(32) !== 6 || u32(56) !== 4096) {
      fail("malformed", "Invalid compound file sector parameters.");
    }
    const sectorSize = majorVersion === 3 ? 512 : 4096;
    if (bytes.length < sectorSize * 3 || bytes.length % sectorSize !== 0) fail("malformed", "Truncated or unaligned compound file.");
    if (bytes.subarray(8, 24).some((v) => v !== 0) || bytes.subarray(34, 40).some((v) => v !== 0) ||
        (majorVersion === 4 && bytes.subarray(512, 4096).some((v) => v !== 0))) fail("malformed", "Invalid reserved header bytes.");
    const sectorCount = bytes.length / sectorSize - 1;
    if (sectorCount > limits.maxSectors) fail("limit-exceeded", "Compound file exceeds the sector budget.");
    const validSector = (id: number) => Number.isInteger(id) && id >= 0 && id < sectorCount;
    const sector = (id: number) => {
      if (!validSector(id)) fail("malformed", "Sector points outside the compound file.");
      return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
    };
    const sectorView = (id: number) => {
      const data = sector(id);
      return new DataView(data.buffer, data.byteOffset, data.length);
    };
    const directoryCount = u32(40), fatCount = u32(44), miniFatCount = u32(64), difatCount = u32(72);
    if (majorVersion === 3 && directoryCount !== 0) fail("malformed", "Version 3 directory sector count must be zero.");
    for (const count of [fatCount, miniFatCount, difatCount, directoryCount]) {
      if (count > sectorCount) fail("malformed", "Metadata sector count exceeds the file.");
      if (count > limits.maxChainSectors) fail("limit-exceeded", "Metadata exceeds the chain budget.");
    }
    if (fatCount === 0) fail("malformed", "Missing FAT.");
    const owners = new Map<number, string>();
    const reserve = (id: number, owner: string) => {
      if (!validSector(id)) fail("malformed", "Invalid allocated sector.");
      const previous = owners.get(id);
      if (previous !== undefined && previous !== owner) fail("malformed", "Compound file sector chains overlap.");
      owners.set(id, owner);
    };
    // [MS-CFB] 2.5: 109 header entries, then sectorSize/4 - 1 entries per DIFAT sector.
    const fatIds: number[] = [];
    const seenFatIds = new Set<number>();
    const addFat = (id: number) => {
      if (id === FREE) return;
      if (fatIds.length >= fatCount || seenFatIds.has(id)) fail("malformed", "Invalid or duplicate DIFAT entry.");
      reserve(id, "FAT");
      seenFatIds.add(id);
      fatIds.push(id);
    };
    for (let i = 0; i < 109; i++) addFat(u32(76 + 4 * i));
    let difat = u32(68);
    const difatIds = new Set<number>();
    for (let i = 0; i < difatCount; i++) {
      if (difatIds.has(difat)) fail("malformed", "DIFAT cycle.");
      reserve(difat, "DIFAT");
      difatIds.add(difat);
      const d = sectorView(difat);
      for (let j = 0; j < sectorSize / 4 - 1; j++) addFat(d.getUint32(j * 4, true));
      difat = d.getUint32(sectorSize - 4, true);
    }
    if (difat !== END || fatIds.length !== fatCount) fail("malformed", "DIFAT count or termination mismatch.");
    const fat = new Uint32Array(fatCount * sectorSize / 4);
    fatIds.forEach((id, i) => {
      const d = sectorView(id);
      for (let j = 0; j < sectorSize / 4; j++) fat[i * sectorSize / 4 + j] = d.getUint32(j * 4, true);
    });
    if (fat.length < sectorCount) fail("malformed", "FAT does not cover the file.");
    for (const id of fatIds) if (fat[id] !== FAT_SECTOR) fail("malformed", "FAT sector is not marked FATSECT.");
    for (const id of difatIds) if (fat[id] !== DIFAT_SECTOR) fail("malformed", "DIFAT sector is not marked DIFSECT.");
    for (let i = sectorCount; i < fat.length; i++) if (fat[i] !== FREE) fail("malformed", "FAT allocates beyond end of file.");
    const chain = (start: number, table: Uint32Array, available: number, owner: string, mini = false): number[] => {
      const ids: number[] = [], seen = new Set<number>();
      let id = start;
      while (id !== END) {
        if (id >= available || id >= table.length) fail("malformed", "Sector chain points outside its storage.");
        if (seen.has(id)) fail("malformed", "Sector chain cycle.");
        if (ids.length >= limits.maxChainSectors) fail("limit-exceeded", "Sector chain exceeds the traversal budget.");
        if (!mini) reserve(id, owner);
        seen.add(id); ids.push(id); id = table[id];
      }
      return ids;
    };
    const directoryIds = chain(u32(48), fat, sectorCount, "directory");
    if (directoryIds.length === 0 || (majorVersion === 4 && directoryIds.length !== directoryCount)) fail("malformed", "Directory sector count mismatch.");
    const entryCount = directoryIds.length * sectorSize / 128;
    if (entryCount > limits.maxDirectoryEntries) fail("limit-exceeded", "Directory exceeds the entry budget.");
    const entries: Entry[] = [];
    // [MS-CFB] 2.6.1: 128-byte entries, name + length/type at 64/66, pointers at 68/72/76.
    for (const id of directoryIds) {
      const d = sectorView(id);
      for (let at = 0; at < sectorSize; at += 128) {
        const type = d.getUint8(at + 66);
        if (![0, 1, 2, 5].includes(type)) fail("malformed", "Invalid directory object type.");
        let name = "";
        if (type !== 0) {
          const length = d.getUint16(at + 64, true);
          if (length < 2 || length > 64 || length % 2 || d.getUint16(at + length - 2, true) !== 0 || d.getUint8(at + 67) > 1) fail("malformed", "Invalid directory entry name or color.");
          for (let p = 0; p < length - 2; p += 2) name += String.fromCharCode(d.getUint16(at + p, true));
          if (!name || /[\0/\\:!]/.test(name)) fail("malformed", "Invalid storage or stream name.");
        }
        const low = d.getUint32(at + 120, true), high = d.getUint32(at + 124, true);
        // [MS-CFB] 2.6.3: ignore historically uninitialized high DWORD in v3.
        const size = low + (majorVersion === 4 ? high * 0x100000000 : 0);
        if (!Number.isSafeInteger(size)) fail("limit-exceeded", "Stream size exceeds safe integer precision.");
        entries.push({ name, type, left: d.getUint32(at + 68, true), right: d.getUint32(at + 72, true), child: d.getUint32(at + 76, true), start: d.getUint32(at + 116, true), size });
      }
    }
    const root = entries[0];
    if (root.type !== 5 || root.name !== "Root Entry" || root.left !== FREE || root.right !== FREE) fail("malformed", "Missing or invalid root directory entry.");
    const rootStreams = new Map<string, { entry: Entry; id: number }>();
    const siblingNames = new Map<number, Set<string>>();
    const seenEntries = new Set<number>([0]);
    const pending = [{ id: root.child, parent: 0 }];
    while (pending.length) {
      const { id, parent } = pending.pop()!;
      if (id === FREE) continue;
      if (id >= entries.length || seenEntries.has(id)) fail("malformed", "Invalid or cyclic directory tree.");
      seenEntries.add(id);
      const entry = entries[id];
      if (entry.type !== 1 && entry.type !== 2) fail("malformed", "Directory references a non-object entry.");
      // [MS-CFB] 2.6.4 uniqueness applies to every sibling object, not only streams.
      // Root lookup intentionally supports ASCII only; no Unicode folding is claimed.
      const key = asciiName(entry.name) ? foldAscii(entry.name) : entry.name;
      const names = siblingNames.get(parent) ?? new Set<string>();
      if (names.has(key)) fail("malformed", "Duplicate sibling directory name.");
      names.add(key); siblingNames.set(parent, names);
      pending.push({ id: entry.left, parent }, { id: entry.right, parent });
      if (entry.type === 1) pending.push({ id: entry.child, parent: id });
      else if (entry.child !== FREE) fail("malformed", "Stream directory entry has children.");
      if (parent === 0 && entry.type === 2) {
        rootStreams.set(key, { entry, id });
      }
    }
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].type !== 0 && !seenEntries.has(i)) fail("malformed", "Unreachable directory object.");
    }
    const miniFatIds = chain(u32(60), fat, sectorCount, "miniFAT");
    if (miniFatIds.length !== miniFatCount) fail("malformed", "MiniFAT count mismatch.");
    const miniFat = new Uint32Array(miniFatCount * sectorSize / 4);
    miniFatIds.forEach((id, i) => {
      const d = sectorView(id);
      for (let j = 0; j < sectorSize / 4; j++) miniFat[i * sectorSize / 4 + j] = d.getUint32(j * 4, true);
    });
    let totalStreamBytes = 0;
    const allocate = (size: number) => {
      if (size > limits.maxStreamBytes || size > limits.maxTotalStreamBytes - totalStreamBytes) fail("limit-exceeded", "Stream exceeds the byte budget.");
      totalStreamBytes += size;
      return new Uint8Array(size);
    };
    const readNormal = (entry: Entry, owner: string) => {
      if (entry.size > limits.maxStreamBytes) fail("limit-exceeded", "Stream exceeds the byte budget.");
      const ids = chain(entry.start, fat, sectorCount, owner);
      if (ids.length * sectorSize < entry.size) fail("malformed", "Truncated stream sector chain.");
      const data = allocate(entry.size);
      ids.forEach((id, i) => { if (i * sectorSize < data.length) data.set(sector(id).subarray(0, Math.min(sectorSize, data.length - i * sectorSize)), i * sectorSize); });
      return data;
    };
    let miniStream: Uint8Array | undefined;
    const miniOwners = new Map<number, number>();
    const file: CompoundFile = Object.freeze({
      majorVersion,
      rootStreamNames: Object.freeze(Array.from(rootStreams.values(), ({ entry }) => entry.name)),
      readRootStream(name: string): CfbStreamResult {
        try {
          if (!asciiName(name)) fail("unsupported", "Only ASCII root stream names can be looked up by this reader.");
          const found = rootStreams.get(foldAscii(name));
          if (!found) fail("unsupported", "Requested root stream was not found.");
          const { entry, id } = found;
          if (entry.size >= 4096) return { ok: true, data: readNormal(entry, `stream:${id}`) };
          if (entry.size === 0) {
            if (entry.start !== END) fail("malformed", "Empty stream has an allocated starting sector.");
            return { ok: true, data: allocate(0) };
          }
          // [MS-CFB] 2.4: mini-sector byte offsets are id * 64 within the root mini stream.
          miniStream ??= readNormal(root, "mini stream");
          const ids = chain(entry.start, miniFat, Math.floor(miniStream.length / 64), "", true);
          if (ids.length * 64 < entry.size) fail("malformed", "Truncated mini stream chain.");
          for (const miniId of ids) {
            const owner = miniOwners.get(miniId);
            if (owner !== undefined && owner !== id) fail("malformed", "Mini stream chains overlap.");
            miniOwners.set(miniId, id);
          }
          const data = allocate(entry.size);
          ids.forEach((miniId, i) => { if (i * 64 < data.length) data.set(miniStream!.subarray(miniId * 64, miniId * 64 + Math.min(64, data.length - i * 64)), i * 64); });
          return { ok: true, data };
        } catch (error) { return resultError(error); }
      },
    });
    return { ok: true, file };
  } catch (error) { return resultError(error); }
}
