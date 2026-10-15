import { describe, expect, it } from "vitest";
import { readCompoundFile, type CfbResult, type CfbStreamResult } from "./cfb";
import { CFB_END, CFB_FREE, makeCfb } from "./cfb-test-fixtures";

function file(result: CfbResult) { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.file; }
function data(result: CfbStreamResult) { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.data; }
function error(result: CfbResult | CfbStreamResult, code = "malformed") { expect(result).toMatchObject({ ok: false, error: { code } }); }

describe("original bounded compound file reader", () => {
  it.each([3, 4] as const)("reads version %i FAT and miniFAT streams with exact lengths", (version) => {
    const large = Uint8Array.from({ length: 5003 }, (_, i) => i % 251);
    const small = Uint8Array.from({ length: 137 }, (_, i) => 255 - i);
    const fixture = makeCfb([{ name: "WordDocument", data: large }, { name: "1Table", data: small }, { name: "Empty", data: new Uint8Array() }], { version });
    const parsed = file(readCompoundFile(fixture.bytes));
    expect(parsed.majorVersion).toBe(version);
    expect(parsed.rootStreamNames).toHaveLength(3);
    expect(data(parsed.readRootStream("worddocument"))).toEqual(large);
    expect(data(parsed.readRootStream("1TABLE"))).toEqual(small);
    expect(data(parsed.readRootStream("Empty"))).toHaveLength(0);
  });
  it("follows an external DIFAT sector after 109 header FAT entries", () => {
    const fixture = makeCfb([{ name: "Data", data: new Uint8Array(4096).fill(42) }], { difat: true });
    expect(data(file(readCompoundFile(fixture.bytes)).readRootStream("Data"))[4095]).toBe(42);
  });
  it("handles noncontiguous normal sector chains", () => {
    const fixture = makeCfb([{ name: "Data", data: new Uint8Array(4096).fill(1) }]);
    const ids = fixture.streamSectors[0], first = fixture.bytes.slice(fixture.sectorOffset(ids[0]), fixture.sectorOffset(ids[0]) + 512);
    fixture.bytes.copyWithin(fixture.sectorOffset(ids[0]), fixture.sectorOffset(ids[1]), fixture.sectorOffset(ids[1]) + 512);
    fixture.bytes.set(first, fixture.sectorOffset(ids[1]));
    fixture.view.setUint32(fixture.entryOffsets[1] + 116, ids[1], true);
    fixture.setFat(ids[1], ids[0]); fixture.setFat(ids[0], ids[2]);
    expect(data(file(readCompoundFile(fixture.bytes)).readRootStream("Data"))).toEqual(new Uint8Array(4096).fill(1));
  });
  it("takes a snapshot and returns independent stream copies", () => {
    const fixture = makeCfb([{ name: "Data", data: new Uint8Array(4096).fill(23) }]);
    const parsed = file(readCompoundFile(fixture.bytes)); fixture.bytes.fill(0);
    const first = data(parsed.readRootStream("Data")); expect(first[0]).toBe(23); first.fill(0);
    expect(data(parsed.readRootStream("Data"))[0]).toBe(23);
  });
  it("copies Node Buffer inputs instead of retaining Buffer.slice aliases", () => {
    const source = Buffer.from(makeCfb([{ name: "Data", data: new Uint8Array(4096).fill(23) }]).bytes);
    const parsed = file(readCompoundFile(source)); source.fill(0);
    expect(data(parsed.readRootStream("Data"))[0]).toBe(23);
  });
  it("looks only in the root storage and rejects unsupported name matching", () => {
    const fixture = makeCfb([{ name: "Data", data: new Uint8Array() }]);
    const parsed = file(readCompoundFile(fixture.bytes));
    error(parsed.readRootStream("missing"), "unsupported"); error(parsed.readRootStream("é"), "unsupported");
  });
  it("does not expose a nested storage's WordDocument stream at the root", () => {
    const f = makeCfb([{ name: "Storage", data: new Uint8Array() }, { name: "WordDocument", data: new Uint8Array(4096) }]);
    const storage = f.entryOffsets[1], nested = f.entryOffsets[2];
    f.view.setUint32(f.entryOffsets[0] + 76, 1, true); f.bytes[storage + 66] = 1;
    f.view.setUint32(storage + 68, CFB_FREE, true); f.view.setUint32(storage + 72, CFB_FREE, true);
    f.view.setUint32(storage + 76, 2, true); f.view.setUint32(storage + 116, 0, true);
    f.view.setUint32(nested + 68, CFB_FREE, true); f.view.setUint32(nested + 72, CFB_FREE, true);
    const parsed = file(readCompoundFile(f.bytes)); expect(parsed.rootStreamNames).toEqual([]); error(parsed.readRootStream("WordDocument"), "unsupported");
  });
  it("reads directory and miniFAT chains spanning multiple sectors", () => {
    const streams = Array.from({ length: 6 }, (_, i) => ({ name: `Data${i}`, data: new Uint8Array(3000).fill(i + 1) }));
    const f = makeCfb(streams); expect(f.directoryIds.length).toBeGreaterThan(1); expect(f.miniFatIds.length).toBeGreaterThan(1);
    const parsed = file(readCompoundFile(f.bytes));
    streams.forEach((s) => expect(data(parsed.readRootStream(s.name))).toEqual(s.data));
  });
  it("rejects truncated headers, signatures, sectors, and illegal geometry", () => {
    error(readCompoundFile(new Uint8Array(30)));
    const fixture = makeCfb([]); error(readCompoundFile(fixture.bytes.subarray(0, fixture.bytes.length - 1)));
    fixture.view.setUint16(30, 15, true); error(readCompoundFile(fixture.bytes));
  });
  it("rejects unsupported versions", () => { const f = makeCfb([]); f.view.setUint16(26, 2, true); error(readCompoundFile(f.bytes), "unsupported"); });
  it("rejects duplicate FAT IDs and FAT sectors with wrong allocation markers", () => {
    const f = makeCfb([]); f.view.setUint32(80, 0, true); error(readCompoundFile(f.bytes));
    const g = makeCfb([]); g.setFat(0, CFB_END); error(readCompoundFile(g.bytes));
  });
  it("rejects DIFAT cycles, out-of-file IDs, and count mismatches", () => {
    const f = makeCfb([], { difat: true }); f.view.setUint32(72, 2, true); f.view.setUint32(f.sectorOffset(f.difatIds[0]) + 508, f.difatIds[0], true); error(readCompoundFile(f.bytes));
    const g = makeCfb([]); g.view.setUint32(76, 3000, true); error(readCompoundFile(g.bytes));
    const h = makeCfb([], { difat: true }); h.view.setUint32(h.sectorOffset(h.difatIds[0]), CFB_FREE, true); error(readCompoundFile(h.bytes));
  });
  it("rejects cyclic directory chains, cyclic sibling pointers, and unterminated names", () => {
    const f = makeCfb([]); f.setFat(f.directoryIds[0], f.directoryIds[0]); error(readCompoundFile(f.bytes));
    const g = makeCfb([{ name: "Data", data: new Uint8Array() }]); g.view.setUint32(g.entryOffsets[1] + 72, 1, true); error(readCompoundFile(g.bytes));
    const h = makeCfb([{ name: "Data", data: new Uint8Array() }]); h.view.setUint16(h.entryOffsets[1] + 8, 65, true); error(readCompoundFile(h.bytes));
  });
  it("rejects duplicate sibling names shared by a storage and stream", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(4096) }, { name: "data", data: new Uint8Array() }]);
    f.bytes[f.entryOffsets[2] + 66] = 1; f.view.setUint32(f.entryOffsets[2] + 116, 0, true);
    error(readCompoundFile(f.bytes));
  });
  it("rejects duplicate nested sibling names without merging separate parents", () => {
    const f = makeCfb([{ name: "Storage", data: new Uint8Array() }, { name: "Data", data: new Uint8Array() }, { name: "data", data: new Uint8Array() }]);
    const storage = f.entryOffsets[1]; f.bytes[storage + 66] = 1;
    f.view.setUint32(f.entryOffsets[0] + 76, 1, true); f.view.setUint32(storage + 68, CFB_FREE, true); f.view.setUint32(storage + 72, CFB_FREE, true); f.view.setUint32(storage + 76, 2, true); f.view.setUint32(storage + 116, 0, true);
    f.view.setUint32(f.entryOffsets[2] + 68, CFB_FREE, true); f.view.setUint32(f.entryOffsets[2] + 72, 3, true); f.view.setUint32(f.entryOffsets[3] + 68, CFB_FREE, true); f.view.setUint32(f.entryOffsets[3] + 72, CFB_FREE, true);
    error(readCompoundFile(f.bytes));
  });
  it("rejects normal stream cycles, truncation, and metadata overlap on read", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(4096) }]); f.setFat(f.streamSectors[0][0], f.streamSectors[0][0]); error(file(readCompoundFile(f.bytes)).readRootStream("Data"));
    const g = makeCfb([{ name: "Data", data: new Uint8Array(4096) }]); g.setFat(g.streamSectors[0][0], CFB_END); error(file(readCompoundFile(g.bytes)).readRootStream("Data"));
    const h = makeCfb([{ name: "Data", data: new Uint8Array(4096) }]); h.view.setUint32(h.entryOffsets[1] + 116, h.directoryIds[0], true); error(file(readCompoundFile(h.bytes)).readRootStream("Data"));
  });
  it("rejects miniFAT cycles, truncation, and out-of-mini-stream references", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(130) }]); f.setMiniFat(0, 0); error(file(readCompoundFile(f.bytes)).readRootStream("Data"));
    const g = makeCfb([{ name: "Data", data: new Uint8Array(130) }]); g.setMiniFat(0, CFB_END); error(file(readCompoundFile(g.bytes)).readRootStream("Data"));
    const h = makeCfb([{ name: "Data", data: new Uint8Array(130) }]); h.setMiniFat(0, 50); error(file(readCompoundFile(h.bytes)).readRootStream("Data"));
  });
  it("rejects stream cross-links when both streams are accessed", () => {
    const f = makeCfb([{ name: "One", data: new Uint8Array(4096) }, { name: "Two", data: new Uint8Array(4096) }]);
    f.view.setUint32(f.entryOffsets[2] + 116, f.streamSectors[0][0], true);
    const parsed = file(readCompoundFile(f.bytes)); expect(parsed.readRootStream("One").ok).toBe(true); error(parsed.readRootStream("Two"));
  });
  it("rejects mini stream cross-links when both streams are accessed", () => {
    const f = makeCfb([{ name: "One", data: new Uint8Array(130) }, { name: "Two", data: new Uint8Array(130) }]);
    f.view.setUint32(f.entryOffsets[2] + 116, 0, true);
    const parsed = file(readCompoundFile(f.bytes)); expect(parsed.readRootStream("One").ok).toBe(true); error(parsed.readRootStream("Two"));
  });
  it("rejects v4 unsafe 64-bit stream sizes without allocating", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(4096) }], { version: 4 }); f.view.setUint32(f.entryOffsets[1] + 124, 0x200000, true);
    error(readCompoundFile(f.bytes), "limit-exceeded");
  });
  it("ignores the historically uninitialized v3 high stream-size DWORD", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(4096) }]); f.view.setUint32(f.entryOffsets[1] + 124, 0x98765432, true);
    expect(data(file(readCompoundFile(f.bytes)).readRootStream("Data"))).toHaveLength(4096);
  });
  it("enforces input, sector, chain, directory, stream, and cumulative budgets", () => {
    const f = makeCfb([{ name: "Data", data: new Uint8Array(4096) }]);
    for (const limits of [{ maxInputBytes: 100 }, { maxSectors: 1 }, { maxChainSectors: 0 }, { maxDirectoryEntries: 0 }, { maxInputBytes: NaN }]) error(readCompoundFile(f.bytes, limits), "limit-exceeded");
    error(file(readCompoundFile(f.bytes, { maxStreamBytes: 4000 })).readRootStream("Data"), "limit-exceeded");
    const parsed = file(readCompoundFile(f.bytes, { maxTotalStreamBytes: 4096 })); expect(parsed.readRootStream("Data").ok).toBe(true); error(parsed.readRootStream("Data"), "limit-exceeded");
    error(file(readCompoundFile(f.bytes, { maxChainSectors: 4 })).readRootStream("Data"), "limit-exceeded");
  });
});
