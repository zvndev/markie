/** Routing information, not a claim that an engine can safely edit a file. */
export type DocumentFormatKind = "markdown" | "text" | "csv" | "json" | "yaml" | "xml" | "docx" | "doc" | "rtf" | "html" | "odt" | "unsupported";

export type DocumentFormatInfo = Readonly<{
  kind: DocumentFormatKind;
  representation: "text" | "bytes";
  editing: "text" | "engine" | "unsupported";
  mimeType: string;
}>;

const FORMATS: Record<DocumentFormatKind, DocumentFormatInfo> = {
  markdown: { kind: "markdown", representation: "text", editing: "text", mimeType: "text/markdown" },
  text: { kind: "text", representation: "text", editing: "text", mimeType: "text/plain" },
  csv: { kind: "csv", representation: "text", editing: "text", mimeType: "text/csv" },
  json: { kind: "json", representation: "text", editing: "text", mimeType: "application/json" },
  yaml: { kind: "yaml", representation: "text", editing: "text", mimeType: "text/plain" },
  xml: { kind: "xml", representation: "text", editing: "text", mimeType: "text/plain" },
  docx: { kind: "docx", representation: "bytes", editing: "engine", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  doc: { kind: "doc", representation: "bytes", editing: "engine", mimeType: "application/msword" },
  rtf: { kind: "rtf", representation: "bytes", editing: "unsupported", mimeType: "application/rtf" },
  html: { kind: "html", representation: "bytes", editing: "unsupported", mimeType: "text/html" },
  odt: { kind: "odt", representation: "bytes", editing: "unsupported", mimeType: "application/vnd.oasis.opendocument.text" },
  unsupported: { kind: "unsupported", representation: "bytes", editing: "unsupported", mimeType: "application/octet-stream" },
};
Object.values(FORMATS).forEach(Object.freeze);

const EXTENSIONS: Record<string, DocumentFormatKind> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "text", text: "text", log: "text", csv: "csv",
  json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
  docx: "docx", doc: "doc", rtf: "rtf", html: "html", htm: "html", odt: "odt",
};

export const DOCUMENT_FILE_ACCEPT = Object.keys(EXTENSIONS).map((extension) => `.${extension}`).join(",");

/** Filename classification never falls back to Markdown or trusts a MIME hint. */
export function classifyDocumentFormat(name: string): DocumentFormatInfo {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : "";
  const kind = Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : "unsupported";
  return FORMATS[kind];
}

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";
export type TextNewline = "lf" | "crlf" | "cr" | "mixed" | "none";
export type DecodedTextDocument = {
  text: string;
  encoding: TextEncoding;
  bom: boolean;
  newline: TextNewline;
};

export class TextDocumentError extends Error {
  constructor(readonly code: "binary-content" | "invalid-text" | "unsupported-encoding", message: string) {
    super(message);
    this.name = "TextDocumentError";
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

function newlineOf(text: string): TextNewline {
  let kind: TextNewline = "none";
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const next = match[0] === "\r\n" ? "crlf" : match[0] === "\r" ? "cr" : "lf";
    if (kind !== "none" && kind !== next) return "mixed";
    kind = next;
  }
  return kind;
}

function assertText(text: string): void {
  // Tabs, newlines and form feeds are meaningful plain text. NULs and the
  // other C0 controls are a strong binary indicator, not replacement text.
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) {
      throw new TextDocumentError("binary-content", "This file contains binary control characters and cannot be edited as text.");
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TextDocumentError("invalid-text", "The document is not valid Unicode text.");
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TextDocumentError("invalid-text", "The document is not valid Unicode text.");
    }
  }
}

/** Decode without replacing invalid bytes or changing any line endings. */
export function decodeTextDocument(bytes: Uint8Array): DecodedTextDocument {
  if (startsWith(bytes, [0xff, 0xfe, 0, 0]) || startsWith(bytes, [0, 0, 0xfe, 0xff])) {
    throw new TextDocumentError("unsupported-encoding", "UTF-32 text is not supported. Convert a copy to UTF-8 first.");
  }
  const binaryPrefixes = [
    [0x50, 0x4b, 3, 4], [0x50, 0x4b, 5, 6], [0x50, 0x4b, 7, 8],
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    [0x89, 0x50, 0x4e, 0x47], [0x25, 0x50, 0x44, 0x46, 0x2d],
  ];
  if (binaryPrefixes.some((prefix) => startsWith(bytes, prefix))) {
    throw new TextDocumentError("binary-content", "This is a binary document, not a text file.");
  }
  let encoding: TextEncoding = "utf-8";
  let offset = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) offset = 3;
  else if (startsWith(bytes, [0xff, 0xfe])) { encoding = "utf-16le"; offset = 2; }
  else if (startsWith(bytes, [0xfe, 0xff])) { encoding = "utf-16be"; offset = 2; }

  let text: string;
  try {
    // The encoding marker was already removed. ignoreBOM keeps an intentional
    // U+FEFF at the start of the document content instead of stripping twice.
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
  } catch {
    throw new TextDocumentError("invalid-text", `The file is not valid ${encoding.toUpperCase()} text. No bytes were replaced.`);
  }
  assertText(text);
  return { text, encoding, bom: offset > 0, newline: newlineOf(text) };
}

/** Encode exactly the supplied text; callers must not normalize newlines. */
export function encodeTextDocument(text: string, metadata: { encoding?: TextEncoding; bom?: boolean } = {}): Uint8Array {
  assertText(text);
  const encoding = metadata.encoding ?? "utf-8";
  if (encoding !== "utf-8" && encoding !== "utf-16le" && encoding !== "utf-16be") {
    throw new TextDocumentError("unsupported-encoding", "Only UTF-8 and UTF-16 text encodings are supported.");
  }
  const bom = metadata.bom ?? false;
  if (encoding === "utf-8") {
    const content = new TextEncoder().encode(text);
    if (!bom) return content;
    const result = new Uint8Array(content.length + 3);
    result.set([0xef, 0xbb, 0xbf]);
    result.set(content, 3);
    return result;
  }
  const result = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
  const littleEndian = encoding === "utf-16le";
  if (bom) result.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  const view = new DataView(result.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16((bom ? 2 : 0) + i * 2, text.charCodeAt(i), littleEndian);
  return result;
}
