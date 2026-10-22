/**
 * Original Word 97 plain-story serialization FOUNDATION from public [MS-DOC].
 * No document-engine implementation or generated document bytes used as a source.
 * §2.3.1 terminal paragraph; §2.5.1–6 counted FIB and extents;
 * §2.8.35/2.9.38/2.9.177–178 UTF-16 piece table and CLX.
 * https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/9aeaa2e7-4a45-468e-ab13-3f6193eb9394
 * This intentionally lacks mandatory stylesheet/property indexes (§2.5.6): it is
 * NOT a conforming DOC exporter, rich writer, or safe replacement for an input DOC.
 */
import { type CfbFailure } from "./cfb";
import { type CfbWriteStream } from "./cfb-write";
import { DEFAULT_LEGACY_DOC_LIMITS, type LegacyDocLimits } from "./legacy-doc";

export type LegacyDocPlainStoryFoundationResult = {
  ok: true;
  kind: "plain-story-foundation";
  /** Required DOC structures are missing; these are components, not a DOC file. */
  completion: false;
  missingStructures: readonly ["stylesheet", "character-property-index", "paragraph-property-index"];
  streams: readonly CfbWriteStream[];
  characterCount: number;
  paragraphCount: number;
  appendedTerminalParagraph: boolean;
  warnings: readonly string[];
} | CfbFailure;
export type LegacyDocPlainStoryLimits = Pick<LegacyDocLimits, "maxTextCodeUnits" | "maxPieces" | "maxClxBytes" | "maxStreamBytes" | "maxTotalStreamBytes">;
const TEXT_OFFSET = 1024; // 900-byte Word 97 FIB, then zero alignment padding.
const CLX_BYTES = 21; // Pcdt(1 + 4), two CPs(8), one Pcd(8).

/**
 * Serializes ONLY an unformatted main story into new WordDocument + 0Table streams.
 * It does not assemble a compound file. Aggregate budget counts these two streams,
 * not container metadata; any future assembler must enforce its own CFB budgets.
 * CRLF/LF become Word CR paragraph marks. A missing final CR is appended (including
 * an empty input, which becomes one empty paragraph); existing final CRs are kept.
 * Counts/limits use UTF-16 code units, not Unicode scalar values. Tabs and manual
 * line breaks (VT) are allowed. Other C0/C1 controls and object markers are refused
 * instead of emitting fields, sections, tables or drawing references without data.
 * Lone surrogates are malformed. No normalization or BOM stripping is performed.
 */
export function serializeLegacyDocPlainStoryStreams(text: string, overrides: Partial<LegacyDocPlainStoryLimits> = {}): LegacyDocPlainStoryFoundationResult {
  const failure = (code: CfbFailure["error"]["code"], message: string): CfbFailure => ({ ok: false, error: { code, message } });
  try {
    const limits = { ...DEFAULT_LEGACY_DOC_LIMITS, ...overrides };
    if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 0)) return failure("limit-exceeded", "DOC limits must be nonnegative safe integers.");
    if (typeof text !== "string") return failure("malformed", "Plain-story input must be text.");
    // Budget the input too, before producing a second string or allocating bytes.
    if (text.length > limits.maxTextCodeUnits) return failure("limit-exceeded", "Plain-story input exceeds the character budget.");
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(++i);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return failure("malformed", "Plain-story text contains an unpaired surrogate.");
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return failure("malformed", "Plain-story text contains an unpaired surrogate.");
      else if ((unit < 32 && ![9, 10, 11, 13].includes(unit)) || (unit >= 0x7f && unit <= 0x9f) || unit === 0xfffc) {
        return failure("unsupported", "Plain-story text contains a control or object marker requiring unsupported DOC structures.");
      }
    }
    let story = text.replace(/\r\n|\n/g, "\r");
    const appendedTerminalParagraph = !story.endsWith("\r");
    if (appendedTerminalParagraph) story += "\r";
    if (story.length > limits.maxTextCodeUnits || story.length > 0x7fffffff || limits.maxPieces < 1 || limits.maxClxBytes < CLX_BYTES) return failure("limit-exceeded", "Plain story exceeds the text or piece-table budget.");
    const meaningfulBytes = TEXT_OFFSET + story.length * 2;
    const wordBytes = meaningfulBytes;
    if (wordBytes > limits.maxStreamBytes || CLX_BYTES > limits.maxStreamBytes || wordBytes + CLX_BYTES > limits.maxTotalStreamBytes || meaningfulBytes >= 0x40000000) return failure("limit-exceeded", "Plain story exceeds the binary byte budget.");
    const word = new Uint8Array(wordBytes), view = new DataView(word.buffer);
    const w16 = (at: number, value: number) => view.setUint16(at, value, true);
    const w32 = (at: number, value: number) => view.setUint32(at, value, true);
    // [MS-DOC] 2.5.2: no encryption, no quick/incremental saves, 0Table,
    // no write reservation, mandatory fExtChar=1; nFibBack=Word 6/95 identifier.
    w16(0, 0xa5ec); w16(2, 0x00c1); w16(6, 0x0409); w16(10, 0x1000); w16(12, 0x00bf);
    // reserved5/6 historically represented fcMin/fcMac. They are undefined in
    // the current specification; useful text extents are still written there.
    w32(24, TEXT_OFFSET); w32(28, meaningfulBytes);
    w16(32, 14); w16(62, 22); w32(64, meaningfulBytes); w32(76, story.length);
    w16(152, 0x5d); // Word 97 has 93 fc/lcb pairs and no extension words.
    w32(154 + 33 * 8, 0); w32(154 + 33 * 8 + 4, CLX_BYTES); w16(898, 0);
    let paragraphCount = 0;
    for (let i = 0; i < story.length; i++) {
      const unit = story.charCodeAt(i); w16(TEXT_OFFSET + i * 2, unit);
      if (unit === 13) paragraphCount++;
    }
    const table = new Uint8Array(CLX_BYTES), tableView = new DataView(table.buffer);
    table[0] = 2; // Pcdt; no preceding Prc property records.
    tableView.setUint32(1, 16, true); // PlcPcd length: CP[0], CP[1], Pcd[0].
    tableView.setUint32(5, 0, true); tableView.setUint32(9, story.length, true);
    // Pcd flags=0; uncompressed FcCompressed=TEXT_OFFSET; Prm0=0 (no-op).
    tableView.setUint32(15, TEXT_OFFSET, true);
    return {
      ok: true, kind: "plain-story-foundation", completion: false,
      missingStructures: Object.freeze(["stylesheet", "character-property-index", "paragraph-property-index"]),
      streams: Object.freeze([{ name: "WordDocument", data: word }, { name: "0Table", data: table }]),
      characterCount: story.length, paragraphCount, appendedTerminalParagraph,
      warnings: Object.freeze([
        "Serialization foundation only: required stylesheet and CHPX/PAPX property indexes are not emitted; this is not a conforming DOC exporter.",
        "No formatting, sections, tables, lists, fields, drawings, revisions, metadata preservation, or additional stories are supported. Never overwrite an imported DOC with this output.",
      ]),
    };
  } catch {
    return failure("malformed", "Plain-story foundation could not be serialized.");
  }
}
