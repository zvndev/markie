// How a picture or clip with a chosen width is written to the file.
//
// Markdown's image syntax has nowhere to put a width, and every non-standard
// place people have tried (`{width=300}`, `=300x`) shows up as literal text in
// any other renderer. The one form that renders everywhere, GitHub included,
// is the HTML tag itself: `<img src="shot.png" width="300">`. So that is what
// a resized picture becomes, and only a resized one. A picture nobody has
// resized stays `![alt](src)`, byte for byte, because a document that uses
// none of this must not change because the feature exists.
//
// Only the width is kept. A browser scales the height from the picture's own
// proportions, and a stored height goes stale the moment the file behind it
// is replaced with a different crop.
import type { MediaKind } from "@/lib/asset-url";

export interface SizedMediaAttrs {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | string | null;
}

// The attribute value as HTML, with the four characters that could end the
// attribute or the tag turned into entities. A path with a quote in it is
// unusual, a path with an ampersand in it is Tuesday.
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A width the file should carry: a whole number of pixels, or nothing. A
// percentage is a width too, but not one a drag produces or a browser reads
// the same way in an attribute and a style, so it is left alone.
export function normalizeWidth(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  const match = /^\s*(\d+)\s*(?:px)?\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return n > 0 ? n : null;
}

/**
 * The HTML block for a picture or clip that has a width, or null when the
 * markdown image syntax is still the right thing to write: no width was set,
 * or the media is audio, which has no width to keep.
 */
export function sizedMediaHtml(attrs: SizedMediaAttrs, kind: MediaKind): string | null {
  const width = normalizeWidth(attrs.width);
  const src = typeof attrs.src === "string" ? attrs.src : "";
  if (width === null || !src || kind === "audio") return null;
  const alt = typeof attrs.alt === "string" ? attrs.alt : "";
  const title = typeof attrs.title === "string" ? attrs.title : "";
  if (kind === "video") {
    // `controls` because the export and the share page draw this tag as it is
    // written, and a clip nobody can pause is a decoration.
    return `<video src="${escapeAttr(src)}" width="${width}" controls></video>`;
  }
  const parts = [`src="${escapeAttr(src)}"`];
  if (alt) parts.push(`alt="${escapeAttr(alt)}"`);
  if (title) parts.push(`title="${escapeAttr(title)}"`);
  parts.push(`width="${width}"`);
  return `<img ${parts.join(" ")}>`;
}

// One media tag, alone on its line, with nothing else in it. This is the
// shape the serializer writes, and the shape a person writes by hand when
// they want a smaller picture on GitHub, so it is the one HTML block the rich
// editor takes in rather than holding aside: the editor has a node for it.
// Anything wider than that (a tag with text after it, two tags, a tag that
// opens a block) is still raw HTML and still held aside verbatim.
const LONE_MEDIA_TAG =
  /^\s{0,3}<(img|video|audio)\b(?:\s+[^\s"'<>=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*\s*\/?>(?:\s*<\/(?:video|audio)\s*>)?\s*$/i;

export function isLoneMediaTag(line: string): boolean {
  return LONE_MEDIA_TAG.test(line.replace(/\r?\n$/, ""));
}
