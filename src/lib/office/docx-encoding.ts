import { DocxError } from "./docx-types";

const encoder = new TextEncoder();

/** XML part encodings this package layer round-trips (W3C XML 1.0 §4.3.3,
 * Appendix F). UTF-16 parts need a byte-order mark; the declaration must agree
 * with the bytes. Edited parts are re-encoded exactly as they arrived. */
export type DocxXmlEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";
export function decodeDocxXml(bytes: Uint8Array): { text: string; encoding: DocxXmlEncoding } {
  const encoding: DocxXmlEncoding = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8-bom"
    : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  let text: string;
  try { text = new TextDecoder(encoding.startsWith("utf-8") ? "utf-8" : encoding, { fatal: true }).decode(bytes); }
  catch { throw new DocxError("unsupported-encoding", "XML part is not valid UTF-8 or byte-order-marked UTF-16."); }
  const declared = /^<\?xml[^>]*?\sencoding[\x20\t\r\n]*=[\x20\t\r\n]*(["'])([^"']*)\1/.exec(text)?.[2].toLowerCase();
  const sixteen = encoding.startsWith("utf-16");
  if (declared !== undefined && (sixteen ? !["utf-16", encoding].includes(declared) : declared !== "utf-8")) {
    throw new DocxError("unsupported-encoding", "XML encoding declaration does not match the part bytes.");
  }
  return { text, encoding };
}
export function encodeDocxXml(text: string, encoding: DocxXmlEncoding): Uint8Array {
  if (encoding === "utf-8") return encoder.encode(text);
  if (encoding === "utf-8-bom") return encoder.encode(`\ufeff${text}`);
  const bytes = new Uint8Array((text.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  const little = encoding === "utf-16le";
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < text.length; i++) view.setUint16((i + 1) * 2, text.charCodeAt(i), little);
  return bytes;
}
