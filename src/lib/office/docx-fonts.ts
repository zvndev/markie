// Fonts a Word file carries inside itself.
//
// Word can embed the fonts a document uses ("Embed fonts in the file"). Each
// is a part under word/fonts/, named *.odttf: an ordinary TrueType or OpenType
// font whose first 32 bytes are XORed with a key, so that the part is not a
// loose font file someone could lift out and install. The key is a GUID kept
// beside the font's name in word/fontTable.xml:
//
//   <w:font w:name="Some Face">
//     <w:embedRegular r:id="rId1" w:fontKey="{1A2B3C4D-....}"/>
//   </w:font>
//
// and word/_rels/fontTable.xml.rels turns rId1 into the part. ECMA-376 Part 1,
// 17.8.1: the GUID's 32 hex digits, read as 16 bytes in reverse order, are the
// key, and it is applied twice over, to bytes 0-15 and again to 16-31.
//
// Reading only. These fonts are shown in the document they came in and
// nowhere else: nothing here writes a font to disk or installs one. Saving
// keeps the parts exactly as they arrived, because the editor never rewrites
// a font part or the font table (docx.ts SAFE_OFFICE_DEPENDENCIES).
import { parseXml, xmlAttribute, xmlDescendants, type XmlElement } from "./xml";
import type { ZipEntry } from "./zip";

const W = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const R = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];

export type DocxFontVariant = "regular" | "bold" | "italic" | "boldItalic";

export interface DocxEmbeddedFont {
  /** The name the document's runs use for it. */
  readonly family: string;
  readonly variant: DocxFontVariant;
  /** The font itself, with the obfuscation removed. */
  readonly data: Uint8Array;
  readonly format: "truetype" | "opentype";
  /** The package part it came from. */
  readonly part: string;
}

const VARIANTS: Record<string, DocxFontVariant> = { embedRegular: "regular", embedBold: "bold", embedItalic: "italic", embedBoldItalic: "boldItalic" };
const MAX_FONTS = 32;
const MAX_FONT_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const GUID = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i;

/** The 16-byte key a font key GUID stands for, or null when it is not a GUID. */
export function docxFontKey(fontKey: string | undefined): Uint8Array | null {
  const match = GUID.exec((fontKey ?? "").trim());
  if (!match) return null;
  const hex = match.slice(1).join("");
  const key = new Uint8Array(16);
  // Reverse order: the GUID's last byte is the key's first.
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.slice(30 - i * 2, 32 - i * 2), 16);
  return key;
}

/**
 * Removes (or applies: XOR is its own inverse) the obfuscation on an .odttf
 * part. Returns a new array; the part itself is never changed.
 */
export function deobfuscateDocxFont(data: Uint8Array, fontKey: string | undefined): Uint8Array | null {
  const key = docxFontKey(fontKey);
  if (!key || data.length < 32) return null;
  const font = new Uint8Array(data);
  for (let i = 0; i < 32; i++) font[i] ^= key[i % 16];
  return font;
}

/** What kind of font the first four bytes say this is, if any Markie will load. */
export function sfntFormat(data: Uint8Array): DocxEmbeddedFont["format"] | null {
  if (data.length < 12) return null;
  const tag = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
  if (tag === 0x00010000 || tag === 0x74727565) return "truetype"; // 1.0, 'true'
  if (tag === 0x4f54544f) return "opentype"; // 'OTTO'
  return null;
}

function relationshipsPart(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

function resolve(source: string, target: string): string | null {
  if (!target || /[\\\x00-\x20\x7f:%?#]/.test(target)) return null;
  const pieces = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const piece of target.replace(/^\//, "").split("/")) {
    if (!piece || piece === ".") return null;
    if (piece === "..") {
      if (!pieces.length) return null;
      pieces.pop();
    } else pieces.push(piece);
  }
  return pieces.join("/");
}

function decode(data: Uint8Array): XmlElement | null {
  try {
    return parseXml(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return null;
  }
}

const isWord = (node: XmlElement, name: string) => node.localName === name && W.includes(node.namespace);

/**
 * The embedded fonts in a package's parts. Never throws: a font table that
 * cannot be read, a key that is not a GUID, or bytes that are not a font once
 * the key is applied are all simply not fonts, and the document opens without
 * them exactly as it did before.
 */
export function readDocxEmbeddedFonts(entries: readonly ZipEntry[]): DocxEmbeddedFont[] {
  const parts = new Map(entries.map((entry) => [entry.name, entry.data]));
  const fonts: DocxEmbeddedFont[] = [];
  let total = 0;
  for (const [name, data] of parts) {
    // The font table is wherever the package says; by content it is the part
    // whose root is w:fonts. Checking the name first keeps this cheap.
    if (!/fonttable[^/]*\.xml$/i.test(name)) continue;
    const table = decode(data);
    if (!table || !isWord(table, "fonts")) continue;
    const relsData = parts.get(relationshipsPart(name));
    const rels = relsData ? decode(relsData) : null;
    if (!rels) continue;
    const targets = new Map<string, string>();
    for (const rel of rels.children) {
      const id = xmlAttribute(rel, "Id"), target = xmlAttribute(rel, "Target");
      if (!id || !target || xmlAttribute(rel, "TargetMode") === "External" || !/\/font$/.test(xmlAttribute(rel, "Type") ?? "")) continue;
      const resolved = resolve(name, target);
      if (resolved) targets.set(id, resolved);
    }
    for (const font of xmlDescendants(table)) {
      if (!isWord(font, "font")) continue;
      const family = W.map((ns) => xmlAttribute(font, "name", ns)).find(Boolean)?.trim();
      if (!family || family.length > 200 || /[\x00-\x1f\x7f]/u.test(family)) continue;
      for (const embed of font.children) {
        const variant = W.includes(embed.namespace) ? VARIANTS[embed.localName] : undefined;
        if (!variant) continue;
        const id = R.map((ns) => xmlAttribute(embed, "id", ns)).find(Boolean);
        const key = W.map((ns) => xmlAttribute(embed, "fontKey", ns)).find(Boolean);
        const part = id ? targets.get(id) : undefined;
        const raw = part ? parts.get(part) : undefined;
        if (!part || !raw || raw.length > MAX_FONT_BYTES || total + raw.length > MAX_TOTAL_BYTES || fonts.length >= MAX_FONTS) continue;
        // A part with no key is a plain font (some generators write one).
        const plain = key ? deobfuscateDocxFont(raw, key) : new Uint8Array(raw);
        const format = plain ? sfntFormat(plain) : null;
        if (!plain || !format || fonts.some((existing) => existing.family === family && existing.variant === variant)) continue;
        total += raw.length;
        fonts.push(Object.freeze({ family, variant, data: plain, format, part }));
      }
    }
  }
  return fonts;
}
