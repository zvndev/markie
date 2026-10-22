import { describe, expect, it } from "vitest";
import { readCompoundFile, type CfbLimits } from "./cfb";
import { writeCompoundFile, type CfbWriteResult, type CfbWriteStream } from "./cfb-write";

function bytes(result: CfbWriteResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
function roundTrip(streams: readonly CfbWriteStream[]) {
  const output = bytes(writeCompoundFile(streams));
  const parsed = readCompoundFile(output);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.file.majorVersion).toBe(3);
  expect(new Set(parsed.file.rootStreamNames)).toEqual(new Set(streams.map((s) => s.name)));
  for (const stream of streams) {
    const read = parsed.file.readRootStream(stream.name.toLowerCase());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error.message);
    // Check every byte without Vitest materializing millions of indexed properties.
    expect(read.data.length).toBe(stream.data.length);
    expect(read.data.every((value, i) => value === stream.data[i])).toBe(true);
  }
  return output;
}
const payload = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 17) % 256);

describe("original bounded v3 compound file writer", () => {
  it("writes the minimal empty container with absent miniFAT/DIFAT chains", () => {
    const output = roundTrip([]), view = new DataView(output.buffer);
    expect(output.length).toBe(1536);
    expect([...output.subarray(0, 8)]).toEqual([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(view.getUint32(40, true)).toBe(0);
    expect(view.getUint32(44, true)).toBe(1);
    for (const at of [60, 68]) expect(view.getUint32(at, true)).toBe(0xfffffffe);
    for (const at of [64, 72]) expect(view.getUint32(at, true)).toBe(0);
    expect(output.subarray(8, 24).every((v) => v === 0)).toBe(true);
  });
  it.each([0, 1, 63, 64, 65, 511, 512, 513, 4095, 4096, 4097, 5003])("preserves all %i payload bytes across allocation boundaries", (length) => {
    const output = roundTrip([{ name: "WordDocument", data: payload(length) }]);
    const view = new DataView(output.buffer), directory = (view.getUint32(48, true) + 1) * 512;
    expect(view.getUint32(directory + 128 + 120, true)).toBe(length);
    expect(view.getUint32(64, true) > 0).toBe(length > 0 && length < 4096);
    if (!length) expect(view.getUint32(directory + 128 + 116, true)).toBe(0xfffffffe);
  });
  it("mixes empty, mini and normal streams across directory and miniFAT sectors", () => {
    roundTrip(Array.from({ length: 17 }, (_, i) => ({ name: `Stream${i}`, data: payload(i === 0 ? 0 : i % 2 ? 3001 : 5003) })));
  });
  it("writes exact Buffer subviews without surrounding bytes or retained aliases", () => {
    const source = Buffer.from([251, 1, 2, 3, 252]);
    const output = bytes(writeCompoundFile([{ name: "Data", data: source.subarray(1, 4) }]));
    const original = output.slice(); source.fill(0);
    expect(output).toEqual(original);
    const parsed = readCompoundFile(output);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.file.readRootStream("Data")).toEqual({ ok: true, data: Uint8Array.of(1, 2, 3) });
  });
  it("canonicalizes stream order without mutating callers and preserves property stream prefixes", () => {
    const first = { name: "z", data: payload(2) }, second = { name: "\u0005SummaryInformation", data: payload(5000) };
    const inputs = Object.freeze([Object.freeze(first), Object.freeze(second)]);
    const before = first.data.slice();
    expect(bytes(writeCompoundFile(inputs))).toEqual(bytes(writeCompoundFile([second, first])));
    expect(inputs[0]).toBe(first); expect(first.data).toEqual(before);
    roundTrip(inputs);
    roundTrip([{ name: "X".repeat(31), data: payload(1) }]);
  });
  it.each(["", "X".repeat(32), "a/b", "a\\b", "a:b", "a!b", "a\0b"])("rejects illegal name %j", (name) => {
    expect(writeCompoundFile([{ name, data: payload(0) }])).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
  it("rejects case-insensitive duplicates rather than overwriting streams", () => {
    expect(writeCompoundFile([{ name: "Data", data: payload(1) }, { name: "dATA", data: payload(2) }])).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
  it.each(["é", "ß", "😀", "\u0080"])("explicitly rejects unsupported Unicode name %j", (name) => {
    expect(writeCompoundFile([{ name, data: payload(0) }])).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  it("rejects malformed runtime inputs without exposing implementation exceptions", () => {
    for (const input of [null, {}, [null], [{ name: "Data", data: [1] }], [{ data: payload(0) }]]) {
      expect(writeCompoundFile(input as unknown as CfbWriteStream[])).toMatchObject({ ok: false, error: { code: "malformed" } });
    }
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limit %s before writing", (maxInputBytes) => {
    expect(writeCompoundFile([], { maxInputBytes })).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
  });
  it("enforces padded directory, output, sector, stream, chain and cumulative limits", () => {
    const streams = [{ name: "Data", data: payload(4096) }];
    const cases: Partial<CfbLimits>[] = [
      { maxInputBytes: 100 }, { maxSectors: 1 }, { maxDirectoryEntries: 3 },
      { maxStreamBytes: 4095 }, { maxChainSectors: 7 }, { maxTotalStreamBytes: 4095 },
    ];
    for (const limits of cases) expect(writeCompoundFile(streams, limits)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    // Root mini stream is 64 bytes, and payload 1 byte, both read by the reader.
    expect(writeCompoundFile([{ name: "Tiny", data: payload(1) }], { maxTotalStreamBytes: 64 })).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(writeCompoundFile([{ name: "Tiny", data: payload(1) }], { maxStreamBytes: 63 })).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    const output = bytes(writeCompoundFile(streams));
    expect(writeCompoundFile(streams, { maxInputBytes: output.length }).ok).toBe(true);
    expect(writeCompoundFile(streams, { maxInputBytes: output.length - 1 }).ok).toBe(false);
    expect(writeCompoundFile([], { maxChainSectors: 0 }).ok).toBe(false);
  });
  it.each([8, 16])("writes %i MiB with correctly chained external DIFAT sectors", (size) => {
    const output = roundTrip([{ name: "Data", data: payload(size * 1024 * 1024) }]);
    const view = new DataView(output.buffer), fatCount = view.getUint32(44, true), difatCount = view.getUint32(72, true);
    expect(fatCount).toBeGreaterThan(109);
    expect(difatCount).toBe(size === 8 ? 1 : 2);
    let id = view.getUint32(68, true);
    for (let i = 0; i < difatCount; i++) {
      const at = (id + 1) * 512;
      expect(view.getUint32(at, true)).toBe(109 + i * 127);
      id = view.getUint32(at + 508, true);
    }
    expect(id).toBe(0xfffffffe);
  });
  it("zeroes stream-sector padding and unused FAT/miniFAT entries", () => {
    const output = roundTrip([{ name: "Small", data: payload(65) }, { name: "Large", data: payload(4097) }]);
    const view = new DataView(output.buffer), directory = (view.getUint32(48, true) + 1) * 512;
    for (let i = 1; i <= 2; i++) {
      const at = directory + i * 128, size = view.getUint32(at + 120, true), start = view.getUint32(at + 116, true);
      const base = size < 4096 ? (view.getUint32(directory + 116, true) + 1) * 512 + start * 64 : (start + 1) * 512;
      const paddedSize = Math.ceil(size / (size < 4096 ? 64 : 512)) * (size < 4096 ? 64 : 512);
      expect(output.subarray(base + size, base + paddedSize).every((v) => v === 0)).toBe(true);
      expect(view.getUint32(at + 124, true)).toBe(0);
    }
    const miniFat = (view.getUint32(60, true) + 1) * 512;
    expect(view.getUint32(miniFat + 8, true)).toBe(0xffffffff);
    const sectorCount = output.length / 512 - 1;
    expect(view.getUint32(512 + sectorCount * 4, true)).toBe(0xffffffff);
  });
  it("builds correctly ordered balanced red-black sibling trees for incomplete levels", () => {
    for (let count = 1; count <= 65; count++) {
      const output = bytes(writeCompoundFile(Array.from({ length: count }, (_, i) => ({ name: `S${i}`, data: payload(0) }))));
      const view = new DataView(output.buffer), directory = (view.getUint32(48, true) + 1) * 512;
      const names: string[] = [], seen = new Set<number>();
      function visit(id: number, redParent: boolean): number {
        if (id === 0xffffffff) return 1;
        expect(seen.has(id)).toBe(false); seen.add(id);
        const at = directory + id * 128, red = view.getUint8(at + 67) === 0;
        expect(red && redParent).toBe(false);
        const left = visit(view.getUint32(at + 68, true), red);
        let name = "";
        for (let i = 0; i < view.getUint16(at + 64, true) - 2; i += 2) name += String.fromCharCode(view.getUint16(at + i, true));
        names.push(name);
        const right = visit(view.getUint32(at + 72, true), red);
        expect(left).toBe(right);
        return left + (red ? 0 : 1);
      }
      const root = view.getUint32(directory + 76, true);
      expect(view.getUint8(directory + root * 128 + 67)).toBe(1);
      visit(root, false); expect(seen.size).toBe(count);
      expect(names).toEqual([...names].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)));
    }
  });
});
