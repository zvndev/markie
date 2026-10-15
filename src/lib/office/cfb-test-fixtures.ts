/** Synthetic bytes generated from [MS-CFB] 2.2–2.7; no real/private documents. */
export const CFB_FREE = 0xffffffff;
export const CFB_END = 0xfffffffe;
export interface FixtureStream { name: string; data: Uint8Array }
export function makeCfb(streams: FixtureStream[], options: { version?: 3 | 4; difat?: boolean } = {}) {
  const version = options.version ?? 3, sectorSize = version === 3 ? 512 : 4096;
  const directoryCount = Math.ceil((streams.length + 1) * 128 / sectorSize);
  const miniStreams = streams.filter((s) => s.data.length > 0 && s.data.length < 4096);
  const miniCount = miniStreams.reduce((sum, s) => sum + Math.ceil(s.data.length / 64), 0);
  const miniFatCount = Math.ceil(miniCount * 4 / sectorSize);
  const miniRootCount = Math.ceil(miniCount * 64 / sectorSize);
  const normalCount = streams.filter((s) => s.data.length >= 4096).reduce((sum, s) => sum + Math.ceil(s.data.length / sectorSize), 0);
  const difatCount = options.difat ? 1 : 0;
  let fatCount = options.difat ? 110 : 1;
  while (fatCount * sectorSize / 4 < fatCount + difatCount + directoryCount + miniFatCount + miniRootCount + normalCount) fatCount++;
  if (fatCount > 109 && !options.difat) throw new Error("Fixture requires DIFAT option.");
  const sectorCount = fatCount + difatCount + directoryCount + miniFatCount + miniRootCount + normalCount;
  const bytes = new Uint8Array((sectorCount + 1) * sectorSize);
  const view = new DataView(bytes.buffer);
  const w16 = (at: number, n: number) => view.setUint16(at, n, true);
  const w32 = (at: number, n: number) => view.setUint32(at, n, true);
  const sectorOffset = (id: number) => (id + 1) * sectorSize;
  const ids = (at: number, count: number) => Array.from({ length: count }, (_, i) => at + i);
  const fatIds = ids(0, fatCount), difatIds = ids(fatCount, difatCount);
  const directoryIds = ids(fatCount + difatCount, directoryCount);
  const miniFatIds = ids(fatCount + difatCount + directoryCount, miniFatCount);
  const miniRootIds = ids(fatCount + difatCount + directoryCount + miniFatCount, miniRootCount);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  w16(24, 0x3e); w16(26, version); w16(28, 0xfffe); w16(30, version === 3 ? 9 : 12); w16(32, 6);
  w32(40, version === 3 ? 0 : directoryCount); w32(44, fatCount); w32(48, directoryIds[0]); w32(56, 4096);
  w32(60, miniFatIds[0] ?? CFB_END); w32(64, miniFatCount); w32(68, difatIds[0] ?? CFB_END); w32(72, difatCount);
  for (let i = 0; i < 109; i++) w32(76 + i * 4, fatIds[i] ?? CFB_FREE);
  for (const id of fatIds) for (let i = 0; i < sectorSize; i += 4) w32(sectorOffset(id) + i, CFB_FREE);
  const setFat = (id: number, value: number) => w32(sectorOffset(fatIds[Math.floor(id / (sectorSize / 4))]) + (id % (sectorSize / 4)) * 4, value);
  const link = (chain: number[]) => chain.forEach((id, i) => setFat(id, chain[i + 1] ?? CFB_END));
  fatIds.forEach((id) => setFat(id, 0xfffffffd)); difatIds.forEach((id) => setFat(id, 0xfffffffc));
  if (difatCount) {
    const at = sectorOffset(difatIds[0]);
    for (let i = 0; i < sectorSize / 4 - 1; i++) w32(at + i * 4, fatIds[109 + i] ?? CFB_FREE);
    w32(at + sectorSize - 4, CFB_END);
  }
  link(directoryIds); link(miniFatIds); link(miniRootIds);
  for (const id of miniFatIds) for (let i = 0; i < sectorSize; i += 4) w32(sectorOffset(id) + i, CFB_FREE);
  const setMiniFat = (id: number, value: number) => w32(sectorOffset(miniFatIds[Math.floor(id / (sectorSize / 4))]) + (id % (sectorSize / 4)) * 4, value);
  const entryOffsets = Array.from({ length: directoryCount * sectorSize / 128 }, (_, i) => sectorOffset(directoryIds[Math.floor(i * 128 / sectorSize)]) + i * 128 % sectorSize);
  for (const at of entryOffsets) { w32(at + 68, CFB_FREE); w32(at + 72, CFB_FREE); w32(at + 76, CFB_FREE); }
  const writeEntry = (id: number, name: string, type: number, start: number, size: number) => {
    const at = entryOffsets[id];
    for (let i = 0; i < name.length; i++) w16(at + i * 2, name.charCodeAt(i));
    w16(at + 64, (name.length + 1) * 2); bytes[at + 66] = type; bytes[at + 67] = 1;
    w32(at + 116, start); w32(at + 120, size);
  };
  writeEntry(0, "Root Entry", 5, miniRootIds[0] ?? CFB_END, miniCount * 64);
  const streamSectors: number[][] = [], streamMiniSectors: number[][] = [];
  let normalAt = fatCount + difatCount + directoryCount + miniFatCount + miniRootCount, miniAt = 0;
  streams.forEach((stream, index) => {
    let start = CFB_END;
    if (stream.data.length >= 4096) {
      const chain = ids(normalAt, Math.ceil(stream.data.length / sectorSize)); normalAt += chain.length;
      link(chain); start = chain[0]; streamSectors[index] = chain;
      chain.forEach((id, i) => bytes.set(stream.data.subarray(i * sectorSize, (i + 1) * sectorSize), sectorOffset(id)));
    } else if (stream.data.length) {
      const chain = ids(miniAt, Math.ceil(stream.data.length / 64)); miniAt += chain.length;
      start = chain[0]; streamMiniSectors[index] = chain;
      chain.forEach((id, i) => {
        setMiniFat(id, chain[i + 1] ?? CFB_END);
        bytes.set(stream.data.subarray(i * 64, (i + 1) * 64), sectorOffset(miniRootIds[Math.floor(id * 64 / sectorSize)]) + id * 64 % sectorSize);
      });
    }
    writeEntry(index + 1, stream.name, 2, start, stream.data.length);
  });
  // Balanced red-black sibling tree: deepest incomplete level red, preceding levels black.
  const ordered = streams.map((s, i) => ({ name: s.name.toUpperCase(), id: i + 1 })).sort((a, b) => a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  const redLevel = Math.floor(Math.log2(streams.length + 1));
  const tree = (lo: number, hi: number, depth: number): number => {
    if (lo > hi) return CFB_FREE;
    const mid = Math.floor((lo + hi) / 2), id = ordered[mid].id, at = entryOffsets[id];
    bytes[at + 67] = depth === redLevel ? 0 : 1;
    w32(at + 68, tree(lo, mid - 1, depth + 1)); w32(at + 72, tree(mid + 1, hi, depth + 1));
    return id;
  };
  w32(entryOffsets[0] + 76, tree(0, streams.length - 1, 0));
  return { bytes, view, sectorSize, sectorOffset, fatIds, difatIds, directoryIds, miniFatIds, miniRootIds, entryOffsets, streamSectors, streamMiniSectors, setFat, setMiniFat };
}
