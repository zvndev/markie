import { describe, expect, it } from "vitest";
import { extractLegacyDocText, type LegacyDocResult } from "./legacy-doc";
import { makeCfb } from "./cfb-test-fixtures";

// Synthetic WordDocument/Table streams, authored from [MS-DOC] 2.5.1, 2.5.4,
// 2.5.6, 2.8.35, 2.9.73, 2.9.177–178. No third-party writer or private docs.
type Piece = { text: string; compressed?: boolean };
function parts(options: { version?: number; baseVersion?: number; whichTable?: boolean; pieces?: Piece[]; mainChars?: number; subChars?: number; property?: boolean } = {}) {
  const version = options.version ?? 0xc1;
  const pairs = ({ 0xc1: 0x5d, 0xd9: 0x6c, 0x101: 0x88, 0x10c: 0xa4 } as Record<number, number>)[version];
  const word = new Uint8Array(4096), view = new DataView(word.buffer);
  const w16 = (at: number, value: number) => view.setUint16(at, value, true);
  const w32 = (at: number, value: number) => view.setUint32(at, value, true);
  const pieces = options.pieces ?? [{ text: "Hello\r", compressed: true }];
  w16(0, 0xa5ec); w16(2, options.baseVersion ?? version); w16(10, 0x1000 | (options.whichTable ? 0x200 : 0)); w16(12, 0xbf);
  w16(32, 14); w16(62, 22); w16(152, pairs);
  const extensionAt = 154 + pairs * 8;
  w16(extensionAt, version === 0xc1 ? 0 : 2);
  if (version !== 0xc1) w16(extensionAt + 2, version);
  let textAt = Math.ceil((extensionAt + (version === 0xc1 ? 2 : 6) + 64) / 2) * 2;
  const textOffsets: number[] = [];
  for (const piece of pieces) {
    textOffsets.push(textAt);
    for (let i = 0; i < piece.text.length; i++) {
      if (piece.compressed) word[textAt++] = piece.text.charCodeAt(i);
      else { w16(textAt, piece.text.charCodeAt(i)); textAt += 2; }
    }
  }
  const totalChars = pieces.reduce((sum, p) => sum + p.text.length, 0);
  w32(64, textAt); w32(76, options.mainChars ?? totalChars); w32(80, options.subChars ?? 0);
  const prefix = options.property ? [1, 2, 0, 0, 0] : [];
  const plcLength = 4 + pieces.length * 12;
  const table = new Uint8Array(prefix.length + 5 + plcLength), tableView = new DataView(table.buffer);
  table.set(prefix); table[prefix.length] = 2; tableView.setUint32(prefix.length + 1, plcLength, true);
  const cpAt = prefix.length + 5, pcdAt = cpAt + (pieces.length + 1) * 4;
  let cp = 0;
  pieces.forEach((piece, i) => {
    tableView.setUint32(cpAt + i * 4, cp, true); cp += piece.text.length;
    tableView.setUint32(pcdAt + i * 8 + 2, piece.compressed ? (textOffsets[i] * 2) + 0x40000000 : textOffsets[i], true);
  });
  tableView.setUint32(cpAt + pieces.length * 4, cp, true);
  w32(154 + 33 * 8, 0); w32(154 + 33 * 8 + 4, table.length);
  return { word, view, table, tableView, textOffsets, cpAt, pcdAt, extensionAt, tableName: options.whichTable ? "1Table" : "0Table" };
}
function wrap(p: ReturnType<typeof parts>, options: { version?: 3 | 4; difat?: boolean } = {}) {
  return makeCfb([{ name: "WordDocument", data: p.word }, { name: p.tableName, data: p.table }], options).bytes;
}
function success(result: LegacyDocResult) { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result; }
function error(result: LegacyDocResult, code = "malformed") { expect(result).toMatchObject({ ok: false, error: { code } }); }

describe("original legacy DOC main-story text extraction", () => {
  it.each([0xc1, 0xd9, 0x101, 0x10c])("reads the supported FIB version %i", (version) => {
    const result = success(extractLegacyDocText(wrap(parts({ version }))));
    expect(result).toMatchObject({ kind: "text-extraction", canWrite: false, rawText: "Hello\r", text: "Hello\n" });
    expect(result.warnings.join(" ")).toContain("Text extraction only");
  });
  it("uses nFibNew when present, including a base nFib of 0xC1", () => {
    expect(success(extractLegacyDocText(wrap(parts({ version: 0x10c, baseVersion: 0xc1 })))).text).toBe("Hello\n");
  });
  it("selects 1Table using the FIB flag and reads v4 CFB", () => {
    expect(success(extractLegacyDocText(wrap(parts({ whichTable: true }), { version: 4 }))).text).toBe("Hello\n");
  });
  it("extracts mixed compressed and UTF-16 pieces in CP rather than physical order", () => {
    const p = parts({ pieces: [{ text: "one ", compressed: true }, { text: "世界 😀\r" }] });
    const first = p.word.slice(p.textOffsets[0], p.textOffsets[0] + 4);
    const newOffset = 3000; p.word.set(first, newOffset); p.tableView.setUint32(p.pcdAt + 2, newOffset * 2 + 0x40000000, true); p.view.setUint32(64, newOffset + 4, true);
    expect(success(extractLegacyDocText(wrap(p))).rawText).toBe("one 世界 😀\r");
  });
  it("applies the spec's compressed mapping, not Windows-1252 substitutions", () => {
    const p = parts({ pieces: [{ text: "\x80\x82\x8e\x91\x9f\r", compressed: true }] });
    expect(success(extractLegacyDocText(wrap(p))).rawText).toBe("\u0080\u201a\u008e\u2018\u0178\r");
  });
  it("retains BOMs, lone surrogates, and non-paragraph control characters", () => {
    const p = parts({ pieces: [{ text: "\ufeff\ud800\x13FIELD\x14value\x15\v\r" }] });
    const r = success(extractLegacyDocText(wrap(p)));
    expect(r.rawText).toBe("\ufeff\ud800\x13FIELD\x14value\x15\v\r"); expect(r.text).toBe(r.rawText.replace(/\r/g, "\n"));
  });
  it("skips bounded CLX property records without claiming formatting support", () => {
    expect(success(extractLegacyDocText(wrap(parts({ property: true })))).text).toBe("Hello\n");
  });
  it("stops at ccpText, even when the same piece also contains subdocument text", () => {
    const p = parts({ pieces: [{ text: "Main\rFootnote!", compressed: true }], mainChars: 5, subChars: 8 });
    expect(success(extractLegacyDocText(wrap(p))).rawText).toBe("Main\r");
  });
  it("handles an empty main story without pieces", () => { expect(success(extractLegacyDocText(wrap(parts({ pieces: [] })))).rawText).toBe(""); });
  it("returns unsupported for Word6/95, later FIBs, and non-DOC compound files", () => {
    const p = parts(); p.view.setUint16(2, 0x65, true); error(extractLegacyDocText(wrap(p)), "unsupported");
    const q = parts({ version: 0x10c }); q.view.setUint16(q.extensionAt + 2, 0x112, true); error(extractLegacyDocText(wrap(q)), "unsupported");
    error(extractLegacyDocText(makeCfb([]).bytes), "unsupported");
  });
  it("refuses encrypted and XOR-obfuscated DOC before decoding payload", () => {
    for (const flags of [0x100, 0x8100]) { const p = parts(); p.view.setUint16(10, flags, true); error(extractLegacyDocText(wrap(p)), "encrypted"); }
    error(extractLegacyDocText(makeCfb([{ name: "EncryptedPackage", data: new Uint8Array() }]).bytes), "encrypted");
  });
  it("rejects a missing selected Table stream and invalid FIB counts", () => {
    const p = parts(); p.view.setUint16(10, 0x200, true); error(extractLegacyDocText(wrap(p)));
    const q = parts(); q.view.setUint16(32, 0xffff, true); error(extractLegacyDocText(wrap(q)));
    const r = parts(); r.view.setUint16(152, 92, true); error(extractLegacyDocText(wrap(r)));
  });
  it("rejects negative character counts and cbMac beyond or before the FIB", () => {
    const p = parts(); p.view.setInt32(76, -1, true); error(extractLegacyDocText(wrap(p)));
    const q = parts(); q.view.setUint32(64, 5000, true); error(extractLegacyDocText(wrap(q)));
    const r = parts(); r.view.setUint32(64, 100, true); error(extractLegacyDocText(wrap(r)));
  });
  it("rejects out-of-range or absent CLX and truncated PRC/PCDT", () => {
    const p = parts(); p.view.setUint32(154 + 33 * 8, 5000, true); error(extractLegacyDocText(wrap(p)));
    const q = parts(); q.view.setUint32(154 + 33 * 8 + 4, 0, true); error(extractLegacyDocText(wrap(q)), "unsupported");
    const r = parts({ property: true }); r.tableView.setInt16(1, -1, true); error(extractLegacyDocText(wrap(r)));
    const s = parts(); s.tableView.setUint32(1, 0xffffffff, true); error(extractLegacyDocText(wrap(s)));
  });
  it("rejects unsorted, duplicate, nonzero-first, negative and uncovered CPs", () => {
    for (const value of [1, -1, 6]) { const p = parts(); p.tableView.setInt32(p.cpAt, value, true); error(extractLegacyDocText(wrap(p))); }
    const p = parts(); p.tableView.setInt32(p.cpAt + 4, 0, true); error(extractLegacyDocText(wrap(p)));
    const q = parts(); q.tableView.setInt32(q.cpAt + 4, 7, true); error(extractLegacyDocText(wrap(q)));
  });
  it("rejects text before the FIB, beyond cbMac, and fractional compressed FC", () => {
    for (const fc of [2, 4000, 0x40000001]) { const p = parts(); p.tableView.setUint32(p.pcdAt + 2, fc, true); error(extractLegacyDocText(wrap(p))); }
  });
  it("checks subdocument pieces too, even though it omits their text", () => {
    const p = parts({ pieces: [{ text: "Main\r", compressed: true }, { text: "Footnote!" }], mainChars: 5, subChars: 8 });
    p.tableView.setUint32(p.pcdAt + 8 + 2, 4000, true); error(extractLegacyDocText(wrap(p)));
  });
  it("enforces text, piece, CLX, property, container, and invalid-limit budgets", () => {
    const input = wrap(parts({ property: true }));
    for (const limits of [{ maxTextCodeUnits: 2 }, { maxPieces: 0 }, { maxClxBytes: 2 }, { maxPropertyRecords: 0 }, { maxInputBytes: 100 }, { maxPieces: Infinity }]) error(extractLegacyDocText(input, limits), "limit-exceeded");
  });
  it("returns typed failures instead of throwing on deterministic corruptions", () => {
    const input = wrap(parts({ pieces: [{ text: "Untrusted 世界\r" }] }));
    let state = 13;
    for (let i = 0; i < 200; i++) {
      const changed = input.slice(); state = (state * 1664525 + 1013904223) >>> 0;
      const at = state % changed.length; changed[at] ^= (state >>> 16) & 255;
      const result = extractLegacyDocText(changed, { maxChainSectors: 1000 });
      expect(typeof result.ok).toBe("boolean");
      if (!result.ok) expect(["malformed", "unsupported", "encrypted", "limit-exceeded"]).toContain(result.error.code);
    }
  });
});
