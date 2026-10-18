import { describe, expect, it } from "vitest";
import { readCompoundFile } from "./cfb";
import { extractLegacyDocText } from "./legacy-doc";
import { writeCompoundFile } from "./cfb-write";
import { serializeLegacyDocPlainStoryStreams, type LegacyDocPlainStoryLimits, type LegacyDocPlainStoryFoundationResult } from "./legacy-doc-write";

function success(result: LegacyDocPlainStoryFoundationResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}
// Incomplete whole-file assembly is a synthetic test fixture ONLY, not a DOC API.
function fixture(result: ReturnType<typeof success>) {
  const cfb = writeCompoundFile(result.streams);
  if (!cfb.ok) throw new Error(cfb.error.message);
  return cfb.data;
}
function streams(data: Uint8Array) {
  const cfb = readCompoundFile(data);
  if (!cfb.ok) throw new Error(cfb.error.message);
  const word = cfb.file.readRootStream("WordDocument"), table = cfb.file.readRootStream("0Table");
  if (!word.ok || !table.ok) throw new Error("Missing foundation streams.");
  return { word: word.data, table: table.data, view: new DataView(word.data.buffer), tableView: new DataView(table.data.buffer) };
}
describe("original Word 97 plain-story serialization foundation", () => {
  it.each([
    ["", "\r", 1, true], ["Hello", "Hello\r", 1, true], ["Hello\r", "Hello\r", 1, false],
    ["One\r\nTwo\nThree\r", "One\rTwo\rThree\r", 3, false], ["\n\n", "\r\r", 2, false],
    ["世界 😀 e\u0301\tA\vB\ufeff", "世界 😀 e\u0301\tA\vB\ufeff\r", 1, true],
  ])("roundtrips %j with explicit paragraph normalization", (input, expected, paragraphs, appended) => {
    const result = success(serializeLegacyDocPlainStoryStreams(input as string));
    const read = extractLegacyDocText(fixture(result));
    expect(read).toMatchObject({ ok: true, kind: "text-extraction", canWrite: false, rawText: expected });
    expect(result).toMatchObject({ kind: "plain-story-foundation", completion: false, characterCount: (expected as string).length, paragraphCount: paragraphs, appendedTerminalParagraph: appended });
    expect(result.missingStructures).toEqual(["stylesheet", "character-property-index", "paragraph-property-index"]);
    expect(result).not.toHaveProperty("data");
    expect(result.warnings.join(" ")).toContain("not a conforming DOC exporter");
  });
  it("writes counted nonencrypted Word 97 FIB fields and exact one-piece CP/FC extents", () => {
    const input = "A😀\rB\r", result = success(serializeLegacyDocPlainStoryStreams(input));
    const { word, table, view, tableView } = streams(fixture(result));
    expect(word.length).toBe(1024 + input.length * 2); expect(table.length).toBe(21);
    expect(view.getUint16(0, true)).toBe(0xa5ec); expect(view.getUint16(2, true)).toBe(0xc1);
    expect(view.getUint16(10, true)).toBe(0x1000); expect(view.getUint16(12, true)).toBe(0xbf);
    expect(view.getUint32(14, true)).toBe(0); // no encryption key
    expect(view.getUint16(32, true)).toBe(14); expect(view.getUint16(62, true)).toBe(22);
    expect(view.getUint16(152, true)).toBe(93); expect(view.getUint16(898, true)).toBe(0);
    expect(view.getUint32(64, true)).toBe(1024 + input.length * 2);
    expect(view.getUint32(76, true)).toBe(input.length);
    for (const index of [4, 5, 6, 7, 8, 9, 10]) expect(view.getUint32(64 + index * 4, true)).toBe(0);
    for (let i = 0; i < input.length; i++) expect(view.getUint16(1024 + i * 2, true)).toBe(input.charCodeAt(i));
    expect(table[0]).toBe(2); expect(tableView.getUint32(1, true)).toBe(16);
    expect(tableView.getUint32(5, true)).toBe(0); expect(tableView.getUint32(9, true)).toBe(input.length);
    expect(tableView.getUint16(13, true)).toBe(0); expect(tableView.getUint32(15, true)).toBe(1024);
    expect(tableView.getUint16(19, true)).toBe(0);
    expect(view.getUint32(154 + 33 * 8, true)).toBe(0); expect(view.getUint32(154 + 33 * 8 + 4, true)).toBe(21);
    expect(word.subarray(900, 1024).every((b) => b === 0)).toBe(true);
    expect(word.subarray(1024 + input.length * 2).every((b) => b === 0)).toBe(true);
    // Missing mandatory rich structures are an intentional and advertised gap.
    for (const index of [1, 12, 13]) expect(view.getUint32(154 + index * 8 + 4, true)).toBe(0);
  });
  it.each([1535, 1536, 1537, 70000])("roundtrips %i UTF-16 characters across physical stream/chunk boundaries", (length) => {
    const input = "x".repeat(length - 1) + "\r";
    const result = success(serializeLegacyDocPlainStoryStreams(input));
    const read = extractLegacyDocText(fixture(result));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.rawText).toBe(input);
    expect(streams(fixture(result)).view.getUint32(64, true)).toBe(1024 + length * 2);
  });
  it.each(["\ud800", "a\udbff", "\udc00", "\ud800A", "\udc00\ud800"])("rejects unpaired UTF-16 input %j", (input) => {
    expect(serializeLegacyDocPlainStoryStreams(input)).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
  it.each(["\0", "\x01", "\x07", "\x08", "\f", "\x13FIELD\x14x\x15", "\x1f", "\x7f", "\x85", "\ufffc"])("refuses unsupported control/object content %j", (input) => {
    expect(serializeLegacyDocPlainStoryStreams(input)).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });
  it("enforces the final paragraph, input, CLX, piece and stream budgets", () => {
    const cases: Partial<LegacyDocPlainStoryLimits>[] = [
      { maxTextCodeUnits: 0 }, { maxPieces: 0 }, { maxClxBytes: 20 }, { maxStreamBytes: 1025 },
      { maxTotalStreamBytes: 1046 }, { maxTextCodeUnits: NaN }, { maxPieces: Infinity }, { maxClxBytes: -1 },
    ];
    for (const limits of cases) expect(serializeLegacyDocPlainStoryStreams("", limits)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(serializeLegacyDocPlainStoryStreams("a", { maxTextCodeUnits: 1 }).ok).toBe(false);
    expect(serializeLegacyDocPlainStoryStreams("a\r", { maxTextCodeUnits: 2 }).ok).toBe(true);
    expect(serializeLegacyDocPlainStoryStreams("a\r", { maxTextCodeUnits: 1 }).ok).toBe(false);
    expect(serializeLegacyDocPlainStoryStreams("", { maxTotalStreamBytes: 1047 }).ok).toBe(true);
  });
  it("does not coerce objects to text or throw on invalid runtime input", () => {
    for (const input of [null, undefined, {}, 1, ["text"]]) expect(serializeLegacyDocPlainStoryStreams(input as unknown as string)).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
  it("is deterministic and returns independent buffers", () => {
    const first = success(serializeLegacyDocPlainStoryStreams("Same text"));
    const second = success(serializeLegacyDocPlainStoryStreams("Same text"));
    expect(first.streams).toEqual(second.streams); first.streams[0].data.fill(0);
    expect(extractLegacyDocText(fixture(second))).toMatchObject({ ok: true, rawText: "Same text\r", canWrite: false });
  });
});
