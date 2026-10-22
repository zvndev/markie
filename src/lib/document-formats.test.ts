import { describe, expect, it } from "vitest";
import {
  classifyDocumentFormat,
  DOCUMENT_FILE_ACCEPT,
  decodeTextDocument,
  encodeTextDocument,
  TextDocumentError,
} from "./document-formats";

describe("document format classification", () => {
  it.each([
    ["notes.md", "markdown", "text", "text"],
    ["notes.MARKDOWN", "markdown", "text", "text"],
    ["component.mdx", "markdown", "text", "text"],
    ["counter.WD", "darkmown", "text", "text"],
    ["C:\\drafts\\letter.TXT", "text", "text", "text"],
    ["/drafts/letter.text", "text", "text", "text"],
    ["service.log", "text", "text", "text"],
    ["report.csv", "csv", "text", "text"],
    ["copy.json", "json", "text", "text"],
    ["copy.yaml", "yaml", "text", "text"],
    ["copy.YML", "yaml", "text", "text"],
    ["copy.xml", "xml", "text", "text"],
    ["letter.docx", "docx", "bytes", "engine"],
    ["letter.doc", "doc", "bytes", "engine"],
    ["letter.rtf", "rtf", "bytes", "engine"],
    ["letter.html", "html", "bytes", "unsupported"],
    ["letter.htm", "html", "bytes", "unsupported"],
    ["letter.odt", "odt", "bytes", "engine"],
    ["letter.pdf", "unsupported", "bytes", "unsupported"],
    ["README", "unsupported", "bytes", "unsupported"],
    ["archive.docx.zip", "unsupported", "bytes", "unsupported"],
    ["counter.wd.js", "unsupported", "bytes", "unsupported"],
    ["counter.skin", "unsupported", "bytes", "unsupported"],
  ])("classifies %s explicitly", (name, kind, representation, editing) => {
    expect(classifyDocumentFormat(name)).toMatchObject({ kind, representation, editing });
  });

  it("does not let callers mutate the shared classification", () => {
    expect(Object.isFrozen(classifyDocumentFormat("notes.txt"))).toBe(true);
  });

  it("offers Darkmown as literal source without treating Markdown as interactive directives", () => {
    expect(DOCUMENT_FILE_ACCEPT.split(",")).toContain(".wd");
    expect(classifyDocumentFormat("counter.wd")).toMatchObject({ kind: "darkmown", mimeType: "text/plain" });
    expect(classifyDocumentFormat("counter.md").kind).toBe("markdown");
  });
});

describe("text document byte fidelity", () => {
  it.each([
    ["one\ntwo\n", "lf"],
    ["one\r\ntwo\r\n", "crlf"],
    ["one\rtwo\r", "cr"],
    ["one\r\ntwo\nthree\r", "mixed"],
    ["one", "none"],
    ["", "none"],
  ])("preserves %j and reports %s line endings", (text, newline) => {
    const original = new TextEncoder().encode(text);
    const decoded = decodeTextDocument(original);
    expect(decoded).toEqual({ text, encoding: "utf-8", bom: false, newline });
    expect(encodeTextDocument(decoded.text, decoded)).toEqual(original);
  });

  it.each(["utf-8", "utf-16le", "utf-16be"] as const)("round-trips %s BOM and Unicode", (encoding) => {
    const text = "Résumé 日本語 👋\r\nnext";
    const bytes = encodeTextDocument(text, { encoding, bom: true });
    const decoded = decodeTextDocument(bytes);
    expect(decoded).toEqual({ text, encoding, bom: true, newline: "crlf" });
    expect(encodeTextDocument(decoded.text, decoded)).toEqual(bytes);
  });

  it("removes only the encoding BOM, not a second intentional BOM character", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61]);
    const decoded = decodeTextDocument(bytes);
    expect(decoded.text).toBe("\ufeffa");
    expect(encodeTextDocument(decoded.text, decoded)).toEqual(bytes);
  });

  it("does not silently normalize line endings when saving edited text", () => {
    const decoded = decodeTextDocument(new TextEncoder().encode("a\r\nb"));
    expect(new TextDecoder().decode(encodeTextDocument("a\r\nb\r\nc", decoded))).toBe("a\r\nb\r\nc");
  });

  it.each([
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    [0x89, 0x50, 0x4e, 0x47],
    [0x25, 0x50, 0x44, 0x46, 0x2d],
    [0x61, 0x00, 0x62],
  ])("rejects binary bytes instead of opening them as text: %j", (...values) => {
    expect(() => decodeTextDocument(new Uint8Array(values))).toThrow(TextDocumentError);
  });

  it("rejects malformed UTF-8 rather than inserting replacement characters", () => {
    expect(() => decodeTextDocument(new Uint8Array([0xc3, 0x28]))).toThrow(/valid/i);
  });

  it("rejects truncated UTF-16 and unsupported UTF-32 BOMs", () => {
    expect(() => decodeTextDocument(new Uint8Array([0xff, 0xfe, 0x61]))).toThrow(TextDocumentError);
    expect(() => decodeTextDocument(new Uint8Array([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]))).toThrow(/UTF-32/i);
    expect(() => decodeTextDocument(new Uint8Array([0, 0, 0xfe, 0xff, 0, 0, 0, 0x61]))).toThrow(/UTF-32/i);
  });

  it("rejects malformed string surrogates rather than replacing content on export", () => {
    expect(() => encodeTextDocument("broken\ud800")).toThrow(TextDocumentError);
    expect(() => encodeTextDocument("broken\udc00")).toThrow(TextDocumentError);
  });

  it("works on a byte subarray without decoding its surrounding buffer", () => {
    const bytes = new Uint8Array([0, 0x61, 0x62, 0]);
    expect(decodeTextDocument(bytes.subarray(1, 3)).text).toBe("ab");
  });
});
