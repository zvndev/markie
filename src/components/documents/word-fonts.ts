// How a Word, RTF or OpenDocument file's fonts reach the screen.
//
// A run names a font. What paints it, in order: the copy the file itself
// embeds, the font of that name installed on this computer, then the bundled
// metric-compatible stand-in (src/lib/fonts/registry.ts officeFontStack).
//
// An embedded font is loaded for this page only, through the FontFace API,
// under an alias nothing else uses. It is never written to disk and never
// installed, and because the alias is private a file cannot use its own font
// to redraw Markie's interface or another document. When the editor closes
// the document the faces are removed.
import { useEffect, useMemo, useState } from "react";
import { getDocxEmbeddedFonts } from "@/lib/office/docx";
import type { DocxEmbeddedFont } from "@/lib/office/docx-fonts";
import type { RichDocument } from "@/lib/office/rich-text-types";
import { LIBRARY_FAMILIES, bundledFamiliesUsed, cssFamilyName, officeFontStack } from "@/lib/fonts/registry";
import { fontDataUrl, inlineFontFaceRules } from "@/lib/fonts/bundled-fonts";
import type { DocxPrintFonts } from "@/lib/office/docx-print";
import { knownLocalFonts, listLocalFontsQuietly, type LocalFontFamily } from "@/lib/fonts/local-fonts";

export type WordFontStack = (fontName: string | undefined) => string;

let nextSet = 0;
const aliasSets = new WeakMap<readonly DocxEmbeddedFont[], Map<string, string>>();

/** One private alias per embedded family, the same for every snapshot of a file. */
export function embeddedFontAliases(fonts: readonly DocxEmbeddedFont[]): Map<string, string> {
  let aliases = aliasSets.get(fonts);
  if (!aliases) {
    const set = ++nextSet;
    aliases = new Map();
    for (const font of fonts) {
      const key = font.family.toLowerCase();
      if (!aliases.has(key)) aliases.set(key, `Markie Embedded ${set} ${aliases.size + 1}`);
    }
    aliasSets.set(fonts, aliases);
  }
  return aliases;
}

/** The stack function for a document: its embedded fonts, then the usual order. */
export function wordFontStack(fonts: readonly DocxEmbeddedFont[]): WordFontStack {
  const aliases = embeddedFontAliases(fonts);
  return (fontName) => officeFontStack(fontName, fontName ? aliases.get(fontName.trim().toLowerCase()) : undefined);
}

/** The FontFace descriptors an embedded font is loaded with. */
export function embeddedFontDescriptors(font: DocxEmbeddedFont): { weight: string; style: string } {
  return {
    weight: font.variant === "bold" || font.variant === "boldItalic" ? "700" : "400",
    style: font.variant === "italic" || font.variant === "boldItalic" ? "italic" : "normal",
  };
}

const EMPTY: readonly DocxEmbeddedFont[] = Object.freeze([]);

/** The embedded fonts of a document, or none for anything but a Word file. */
export function embeddedFontsOf(doc: RichDocument): readonly DocxEmbeddedFont[] {
  if (doc.format !== "docx") return EMPTY;
  const fonts = getDocxEmbeddedFonts(doc);
  return fonts.length ? fonts : EMPTY;
}

/**
 * Loads a document's embedded fonts while it is on screen and returns how its
 * font names are painted. The faces are added once per opened file, not once
 * per edit: every snapshot of a file shares one font list.
 */
export function useWordFonts(doc: RichDocument): WordFontStack {
  const fonts = embeddedFontsOf(doc);
  useEffect(() => {
    const set = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts.length || typeof FontFace === "undefined" || !set) return;
    const aliases = embeddedFontAliases(fonts);
    const faces: FontFace[] = [];
    for (const font of fonts) {
      try {
        // An owned copy: the engine's bytes stay untouched. The browser
        // sanitises the font as it decodes it and refuses a malformed one.
        const face = new FontFace(aliases.get(font.family.toLowerCase())!, font.data.slice().buffer, embeddedFontDescriptors(font));
        set.add(face);
        void face.load().catch(() => set.delete(face));
        faces.push(face);
      } catch {
        // Not loadable here: the text falls back down its stack.
      }
    }
    return () => { for (const face of faces) set.delete(face); };
  }, [fonts]);
  return useMemo(() => wordFontStack(fonts), [fonts]);
}

export interface WordFontChoice { id: string; label: string; group: string }

export const WORD_FONT_GROUPS = { document: "In this document", bundled: "Included with Markie", local: "On this computer", common: "Common fonts" } as const;
// Offered when this browser cannot say what is installed. Each has a bundled
// stand-in, so each paints even where it is missing.
const COMMON_FONTS = ["Arial", "Calibri", "Cambria", "Courier New", "Georgia", "Helvetica", "Times New Roman"];

/**
 * The font menu for a Word-style document: the document's own fonts first,
 * then the ones Markie bundles, then the ones installed here. The id is the
 * real font name, which is what gets written into the file.
 */
export function wordFontChoices(documentFonts: readonly string[], installed: readonly LocalFontFamily[] | null): WordFontChoice[] {
  const seen = new Set<string>();
  const choices: WordFontChoice[] = [];
  const add = (names: readonly string[], group: string) => {
    for (const name of names) {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      choices.push({ id: name.trim(), label: name.trim(), group });
    }
  };
  add([...documentFonts].sort((a, b) => a.localeCompare(b)), WORD_FONT_GROUPS.document);
  add(LIBRARY_FAMILIES.map((family) => family.family), WORD_FONT_GROUPS.bundled);
  if (installed?.length) add(installed.map((font) => font.family), WORD_FONT_GROUPS.local);
  else add(COMMON_FONTS, WORD_FONT_GROUPS.common);
  return choices;
}

/** Every font name the document's runs use. */
export function documentFontNames(doc: RichDocument): string[] {
  const names = new Set<string>();
  const collect = (paragraphs: RichDocument["paragraphs"]) => {
    for (const paragraph of paragraphs) for (const run of paragraph.runs) {
      const font = (run.resolvedStyle ?? run.style).fontFamily;
      if (font) names.add(font);
    }
  };
  collect(doc.paragraphs);
  for (const table of doc.tables) for (const row of table.rows) for (const cell of row.cells) collect(cell.paragraphs);
  return [...names];
}

/** Installed fonts, once this browser is allowed to list them without asking. */
export function useInstalledFonts(): LocalFontFamily[] | null {
  const [fonts, setFonts] = useState<LocalFontFamily[] | null>(knownLocalFonts);
  useEffect(() => {
    let live = true;
    if (!fonts) void listLocalFontsQuietly().then((found) => { if (live && found) setFonts(found); });
    return () => { live = false; };
  }, [fonts]);
  return fonts;
}

// Print output is one HTML string with a size limit of its own; embedded
// fonts past this are left out and their text falls back down its stack.
const MAX_PRINT_EMBEDDED_BYTES = 6 * 1024 * 1024;

/**
 * The fonts a printed or exported copy carries, so paper and PDF match the
 * screen: the file's own embedded fonts and the bundled stand-ins its font
 * names need, all inside the page as data: URLs. Nothing is fetched by the
 * print window and nothing is installed.
 *
 * Null, at once, for a document that needs none: its output is then built in
 * the same turn as the command, exactly as before fonts were carried.
 */
export function printFontsFor(doc: RichDocument): Promise<DocxPrintFonts> | null {
  const embedded = embeddedFontsOf(doc);
  const bundled = bundledFamiliesUsed([], documentFontNames(doc));
  if (!embedded.length && !bundled.length) return null;
  const aliases = embeddedFontAliases(embedded);
  const rules: string[] = [];
  let bytes = 0;
  for (const font of embedded) {
    if (bytes + font.data.length > MAX_PRINT_EMBEDDED_BYTES) continue;
    bytes += font.data.length;
    const { weight, style } = embeddedFontDescriptors(font);
    const url = fontDataUrl(font.data, font.format === "opentype" ? "font/otf" : "font/ttf");
    rules.push(`@font-face{font-family:${cssFamilyName(aliases.get(font.family.toLowerCase())!)};font-weight:${weight};font-style:${style};src:url("${url}") format("${font.format}")}`);
  }
  return (bundled.length ? inlineFontFaceRules(bundled) : Promise.resolve("")).then((faces) => {
    if (faces) rules.push(faces);
    return { faces: rules.join("\n"), stack: wordFontStack(embedded) };
  });
}
