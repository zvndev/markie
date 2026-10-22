import { describe, expect, it } from "vitest";
import { extractRtfText } from "./rtf";
import { DocumentImportError, resolveDocumentImportLimits, type DocumentImportLimits } from "./types";

// Every fixture below is generated in this file from the public RTF1.9.1 wire grammar
// (https://go.microsoft.com/fwlink/?LinkId=120924). No external document, parser,
// package, reader/writer sample, conformance corpus or implementation was used.
const limits = resolveDocumentImportLimits();
const encode = (source: string) => Uint8Array.from(source, (character) => character.charCodeAt(0));
const read = (source: string, overrides: Partial<DocumentImportLimits> = {}) => extractRtfText(encode(source), { ...limits, ...overrides });
function fails(source: string, code: DocumentImportError["code"], overrides: Partial<DocumentImportLimits> = {}) {
  try { read(source, overrides); throw new Error("Expected import rejection"); }
  catch (error) { expect(error).toBeInstanceOf(DocumentImportError); expect((error as DocumentImportError).code).toBe(code); }
}

describe("original bounded RTF body-text conversion", () => {
  it("extracts literal body text, formatting groups and paragraph/line/tab boundaries", () => {
    const result = read(String.raw`{\rtf1\ansi Hello {\b bold} and {\i italic}.\par Next\line line\tab tab}`);
    expect(result.text).toBe("Hello bold and italic.\nNext\nline\ttab");
    expect(result.warnings.join(" ")).toMatch(/new plain-text copy/);
    expect(result.warnings.join(" ")).toMatch(/not preserved/);
  });

  it("honors one delimiter space, ignores source wrapping and preserves explicit escapes", () => {
    expect(read("{\\rtf1\r\n\\ansi  One\r\nTwo\\b  spaces}").text).toBe(" OneTwo spaces");
    expect(read(String.raw`{\rtf1 \{brace\} \\ path\~space\-soft\_join}`).text).toBe("{brace} \\ path\u00a0space\u00adsoft\u2011join");
    expect(read(String.raw`{\rtf1 A\emdash B\endash C\lquote D\rquote\ldblquote E\rdblquote\bullet}`).text)
      .toBe("A—B–C‘D’“E”•");
  });

  it("decodes raw and escaped Windows-1252 without treating bytes as UTF-8", () => {
    expect(read(String.raw`{\rtf1\ansi\ansicpg1252 caf\'e9 \'27literal}`).text).toBe("café 'literal");
    expect(read("{\\rtf1\\ansi\\ansicpg1252 raw \xe9 \\'80 \\'93quoted\\'94}").text).toBe("raw é € “quoted”");
  });

  it("decodes signed Unicode units, scoped fallback counts and surrogate pairs", () => {
    expect(read(String.raw`{\rtf1\uc1 A\u28450?{\uc0\u233}B\u233?}`).text).toBe("A漢éBé");
    expect(read(String.raw`{\rtf1\uc1 \u-10179?\u-8704?}`).text).toBe("😀");
    expect(read(String.raw`{\rtf1\uc2 \u233\'3f?Z}`).text).toBe("éZ");
    expect(read(String.raw`{\rtf1\uc1 \u233\~Z}`).text).toBe("éZ");
    expect(read(String.raw`{\rtf1\uc1 \u233\b Z}`).text).toBe("éZ");
    expect(read(String.raw`{\rtf1\uc2 \u233{X}Y}`).text).toBe("éXY");
  });

  it("omits metadata, font/color tables, field instructions, comments and nested ignorable groups", () => {
    const result = read(String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0\fcharset0 Example Font;}}{\colortbl;\red0\green0\blue0;}{\info{\author Secret Author}{\title Secret Title}}Body{\*\unknownDestination hidden {nested} \'e9}{\annotation private comment}{\header Page header}{\footer Page footer}{\footnote Note}{\field{\*\fldinst HYPERLINK "https://invalid.example"}{\fldrslt Visible link}}}`);
    expect(result.text).toBe("BodyVisible link");
    expect(result.warnings.join(" ")).toMatch(/non-body destinations/);
  });

  it("omits hex image/object payloads without decoding or fetching them", () => {
    const result = read(String.raw`{\rtf1 Body{\pict\pngblip 89504e470d0a}{\object{\*\objdata 01020304}{\result object fallback}}Tail}`);
    expect(result.text).toBe("BodyTail");
  });

  it("does not expose recognized metadata destinations even outside a summary info group", () => {
    expect(read(String.raw`{\rtf1{\title Private title}{\author Private author}{\company Private company}Body}`).text).toBe("Body");
  });

  it("recognizes supported visible destinations even when marked ignorable", () => {
    expect(read(String.raw`{\rtf1{\field{\*\fldinst SECRET INSTRUCTION}{\*\fldrslt Visible}}}`).text).toBe("Visible");
  });

  it("scopes hidden text and resets character properties with plain", () => {
    const result = read(String.raw`{\rtf1 A{\v hidden}B\v secret\plain C\v0 D}`);
    expect(result.text).toBe("ABCD");
    expect(result.warnings.join(" ")).toMatch(/Hidden RTF text/);
  });

  it("flattens table row/cell text with a visible loss warning", () => {
    const result = read(String.raw`{\rtf1\trowd\intbl A\cell B\cell\row C\nestcell D\nestrow}`);
    expect(result.text).toBe("A\tB\t\nC\tD\n");
    expect(result.warnings.join(" ")).toMatch(/tables were flattened/);
  });

  it("tracks font-table codepage overrides and does not reject unused foreign fonts", () => {
    expect(read(String.raw`{\rtf1\deff0{\fonttbl{\f0\fcharset0 Standard;}{\f1\fcharset204 Foreign;}}\f0 caf\'e9}`).text).toBe("café");
    expect(read(String.raw`{\rtf1{\fonttbl{\f0\fcharset204\cpg1252 Override;}}\f0 caf\'e9}`).text).toBe("café");
    expect(read(String.raw`{\rtf1{\fonttbl{\f0\fcharset128 Japanese;}}\f0\uc0\u28450}`).text).toBe("漢");
    fails(String.raw`{\rtf1{\fonttbl{\f1\fcharset204 Cyrillic;}}\f1\'e9}`, "unsupported");
    fails(String.raw`{\rtf1{\fonttbl{\f1\fcharset2 Symbol;}}\f1 ABC}`, "unsupported");
  });

  it("warns for unknown non-ignorable controls but respects case-sensitive control names", () => {
    const result = read(String.raw`{\rtf1 A\futureword12 B\PAR C}`);
    expect(result.text).toBe("ABC");
    expect(result.warnings.join(" ")).toMatch(/Unrecognized/);
  });

  it.each([
    String.raw`{\rtf1\mac x}`, String.raw`{\rtf1\pc x}`, String.raw`{\rtf1\pca x}`, String.raw`{\rtf1\ansicpg1251 x}`,
    String.raw`{\rtf1\cpg932 x}`, String.raw`{\rtf1\fromhtml1 body}`, String.raw`{\rtf1\htmlrtf1 body}`,
    String.raw`{\rtf1\upr{ANSI}{\*\ud Unicode}}`, String.raw`{\rtf1{\*\ud Unicode}}`, String.raw`{\rtf1\deleted old}`, String.raw`{\rtf1\revised new}`,
    String.raw`{\rtf1\bin3 abc}`, String.raw`{\rtf1{\pict\bin3 abc}}`, String.raw`{\rtf2 future}`,
  ])("rejects unsupported encoding/binary/alternate/revision semantics: %s", (source) => fails(source, "unsupported"));

  it.each([
    "", "plain text", "{}", String.raw`{\RTF1 x}`, String.raw`{\rtf1 x`, String.raw`{\rtf1 x}}`, String.raw`{\rtf1 x}junk`,
    String.raw`{\rtf1\'f}`, String.raw`{\rtf1\'gg}`, String.raw`{\rtf1\u}`, String.raw`{\rtf1\uc-1 x}`, String.raw`{\rtf1\uc x}`,
    String.raw`{\rtf1\u65535?}`, String.raw`{\rtf1\u-10179?}`, String.raw`{\rtf1\u-8704?}`, String.raw`{\rtf1\bin-1 x}`,
    String.raw`{\rtf1\fs- x}`, String.raw`{\rtf1 x\fonttbl secret}`, String.raw`{\rtf1{\* ignored}}`, String.raw`{\rtf1\* x}`,
    "{\\rtf1 nul\u0000}", String.raw`{\rtf1\u0?}`, String.raw`{\rtf1{\rtf1 nested}}`, String.raw`{\rtf1\'81}`,
    String.raw`{\rtf1\fcharset204 text}`, String.raw`{\rtf1{\fonttbl{\f0\fcharset256 Bad;}}body}`,
    String.raw`{\rtf1{\fonttbl{\f0\cpg0 Bad;}}body}`, String.raw`{\rtf1{\fonttbl{\f0 Valid;}}\f99 unknown}`,
  ])("rejects malformed structure or Unicode without a partial result: %s", (source) => fails(source, "malformed"));

  it("bounds bytes, output, nesting, tokens, control names and numeric parameters", () => {
    fails(String.raw`{\rtf1 Body}`, "limit-exceeded", { maxInputBytes: 3 });
    fails(String.raw`{\rtf1 12345}`, "limit-exceeded", { maxTextCodeUnits: 4 });
    fails(String.raw`{\rtf1{{{{deep}}}}}`, "limit-exceeded", { maxDepth: 3 });
    fails(String.raw`{\rtf1\b\i\ul\strike x}`, "limit-exceeded", { maxControlWords: 3 });
    fails(String.raw`{\rtf1{}{}{}}`, "limit-exceeded", { maxNodes: 3 });
    fails(`{\\rtf1\\${"a".repeat(33)} x}`, "limit-exceeded");
    fails(String.raw`{\rtf1\fs12345678901 x}`, "limit-exceeded");
    fails(String.raw`{\rtf1\fs2147483648 x}`, "malformed");
  });

  it("handles large generated runs iteratively, produces deterministic warnings and never mutates input", () => {
    const body = "Generated text ".repeat(5000);
    const source = encode(`{\\rtf1 ${body}}`);
    const original = new Uint8Array(source);
    expect(extractRtfText(source, limits).text).toBe(body);
    expect(source).toEqual(original);
    expect(read(String.raw`{\rtf1 A\future1 B\future2 C}`).warnings).toEqual(read(String.raw`{\rtf1 A\future1 B\future2 C}`).warnings);
  });
});
