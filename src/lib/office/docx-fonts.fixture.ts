// A Word file that embeds a font, made here from the public OOXML vocabulary.
//
// The font is a free one (fixtures/README.md). It is obfuscated below the way
// ECMA-376 Part 1, 17.8.1 describes, written out longhand and separately from
// docx-fonts.ts, so the test checks the reader against the specification and
// not against itself.
import { writeZip } from "./zip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";

export const FIXTURE_FONT_FAMILY = "Markie Fixture Hand";
export const FIXTURE_FONT_KEY = "{1DA6C2E4-7B3F-4A59-8C10-9E2F5B6D7A83}";
export const FIXTURE_FONT_PART = "word/fonts/font1.odttf";

/**
 * Obfuscates (or, run again, restores) a font with a font key GUID. The GUID
 * string "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" is walked from its last hex
 * pair to its first, skipping the hyphens, to give sixteen key bytes; those
 * are XORed over bytes 0 to 15 and again over bytes 16 to 31.
 */
export function obfuscateFont(font: Uint8Array, guid: string): Uint8Array {
  const pairStarts = [35, 33, 31, 29, 27, 25, 22, 20, 17, 15, 12, 10, 7, 5, 3, 1];
  const key = pairStarts.map((at) => Number.parseInt(guid.slice(at, at + 2), 16));
  const out = Uint8Array.from(font);
  for (let block = 0; block < 2; block++) {
    for (let i = 0; i < 16; i++) out[block * 16 + i] ^= key[i];
  }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

export interface EmbeddedFontFixtureOptions {
  /** The key written into the font table. Defaults to the key the font was obfuscated with. */
  declaredKey?: string;
  /** The font name the runs and the font table use. */
  family?: string;
}

/** A two-paragraph Word file whose first run is set in an embedded font. */
export function embeddedFontDocx(font: Uint8Array, options: EmbeddedFontFixtureOptions = {}): Uint8Array {
  const family = options.family ?? FIXTURE_FONT_FAMILY;
  const key = options.declaredKey ?? FIXTURE_FONT_KEY;
  const run = (value: string, fontName: string) =>
    `<w:r><w:rPr><w:rFonts w:ascii="${fontName}" w:hAnsi="${fontName}"/></w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`;
  return writeZip([
    { name: "[Content_Types].xml", data: text(`<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>`) },
    { name: "_rels/.rels", data: text(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body><w:p>${run("Set in the embedded font", family)}</w:p><w:p>${run("Set in Calibri", "Calibri")}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`) },
    { name: "word/_rels/document.xml.rels", data: text(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/fontTable" Target="fontTable.xml"/></Relationships>`) },
    { name: "word/fontTable.xml", data: text(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W}" xmlns:r="${R}"><w:font w:name="${family}"><w:charset w:val="00"/><w:family w:val="script"/><w:pitch w:val="variable"/><w:embedRegular r:id="rId1" w:fontKey="${key}"/></w:font><w:font w:name="Calibri"><w:family w:val="swiss"/></w:font></w:fonts>`) },
    { name: "word/_rels/fontTable.xml.rels", data: text(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/font" Target="fonts/font1.odttf"/></Relationships>`) },
    { name: FIXTURE_FONT_PART, data: obfuscateFont(font, FIXTURE_FONT_KEY) },
  ]);
}
