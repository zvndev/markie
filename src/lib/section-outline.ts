// The section rail's view of a document: its H1 to H3 headings, a short
// preview of each section, and which one is on screen.
//
// Pure, so the rich view and the source view follow the same rules. The rich
// view reads headings from its own DOM (src/components/section-rail.tsx); the
// source view reads them from the markdown text here, the way a CommonMark
// renderer would: no headings inside fenced code, HTML comments or front
// matter, and setext underlines count.

import { splitFrontMatter } from "@/lib/front-matter";

export type SectionLevel = 1 | 2 | 3;

export interface Section {
  level: SectionLevel;
  /** Heading text with inline markdown removed. */
  text: string;
  /** The first words of the section's body, for the hover card. */
  snippet: string;
}

export interface SourceSection extends Section {
  /** 0-based line of the heading in the full text, front matter included. */
  line: number;
}

/** About two lines of the hover card. */
export const SNIPPET_CHARS = 180;

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// Lines that start a block of their own, so they cannot be the text of a
// setext heading and do not continue a paragraph that could become one.
const BLOCK_START = /^ {0,3}(?:[>|<]|[-+*][ \t]|\d{1,9}[.)][ \t])/;
const INDENTED = /^(?: {4}|\t)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Inline markdown to plain text: what a reader sees in the heading. */
export function plainInline(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** A body line as preview text: block markers and inline markdown removed. */
function plainBodyLine(line: string): string {
  if (THEMATIC_BREAK.test(line) || TABLE_DELIMITER.test(line)) return "";
  const stripped = line
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/\|/g, " ");
  return plainInline(stripped);
}

/** Collapse and cut preview text to about two lines, on a word boundary. */
export function clipSnippet(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * The H1 to H3 headings of a markdown document, in order, each with the start
 * of its section. Duplicate headings are separate entries: each has its own
 * line. H4 to H6 get no tick.
 *
 * A section runs to the next heading of the same or a higher level, so its
 * preview reads on into its subsections: a "## 1.2.0" followed straight by
 * "### Added" previews as "Added ..." rather than nothing.
 */
export function extractSections(markdown: string): SourceSection[] {
  const { frontMatter, body } = splitFrontMatter(markdown);
  // Lines the front matter takes, so `line` counts from the top of the file.
  const offset = frontMatter ? frontMatter.split(/\r?\n/).length - 1 : 0;
  const lines = body.split(/\r?\n/);
  const sections: SourceSection[] = [];

  // Sections still collecting preview text: the latest heading and the
  // shallower ones it sits under.
  type Open = { section: SourceSection; depth: number; parts: string[]; length: number };
  let open: Open[] = [];
  const close = (entries: Open[]) => {
    for (const entry of entries) entry.section.snippet = clipSnippet(entry.parts.join(" "));
  };
  const addText = (text: string) => {
    if (!text) return;
    for (const entry of open) {
      if (entry.length >= SNIPPET_CHARS) continue;
      entry.parts.push(text);
      entry.length += text.length + 1;
    }
  };
  const startHeading = (level: number, text: string, line: number) => {
    const plain = plainInline(text);
    close(open.filter((entry) => entry.depth >= level));
    open = open.filter((entry) => entry.depth < level);
    // A subheading's own words are part of its parents' previews.
    addText(plain);
    // An empty heading has nothing to label its tick with.
    if (level > 3 || !plain) return;
    const section: SourceSection = { level: level as SectionLevel, text: plain, snippet: "", line: line + offset };
    sections.push(section);
    open.push({ section, depth: level, parts: [], length: 0 });
  };
  const collect = (line: string) => {
    if (open.every((entry) => entry.length >= SNIPPET_CHARS)) return;
    addText(plainBodyLine(line));
  };
  const finish = () => close(open);

  let fence: { char: string; size: number } | null = null;
  let inComment = false;
  // The open paragraph, if any. A setext underline turns it into a heading,
  // so its lines become preview text only once it ends as a paragraph.
  let paragraph: { start: number; lines: string[] } | null = null;
  const endParagraph = () => {
    if (paragraph) for (const text of paragraph.lines) collect(text);
    paragraph = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain a backtick.
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      endParagraph();
      fence = { char: open[1][0], size: open[1].length };
      continue;
    }
    if (/^ {0,3}<!--/.test(line)) {
      endParagraph();
      if (!line.includes("-->", line.indexOf("<!--") + 4)) inComment = true;
      continue;
    }

    if (paragraph && (SETEXT_H1.test(line) || SETEXT_H2.test(line))) {
      const { start, lines: text }: { start: number; lines: string[] } = paragraph;
      paragraph = null;
      startHeading(SETEXT_H1.test(line) ? 1 : 2, text.join(" "), start);
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      endParagraph();
      // "## ##" is an empty heading: the closing hashes are all there is.
      startHeading(atx[1].length, /^#+$/.test(atx[2] ?? "") ? "" : (atx[2] ?? ""), i);
      continue;
    }

    if (!line.trim()) {
      endParagraph();
      continue;
    }
    // A continuation line stays in its paragraph, however indented.
    if (paragraph && !BLOCK_START.test(line) && !THEMATIC_BREAK.test(line)) {
      (paragraph as { lines: string[] }).lines.push(line.trim());
      continue;
    }
    endParagraph();
    // Indented code, a list item, a quote, a table row or HTML: never the
    // text of a setext heading.
    if (INDENTED.test(line) || BLOCK_START.test(line) || THEMATIC_BREAK.test(line)) {
      collect(line);
      continue;
    }
    paragraph = { start: i, lines: [line.trim()] };
  }
  endParagraph();
  finish();
  return sections;
}

/** How long a document must be before the rail appears. */
export const RAIL_MIN_SECTIONS = 3;
export const RAIL_MIN_VIEWPORTS = 1.5;

export function railWanted(sectionCount: number, contentHeight: number, viewportHeight: number): boolean {
  return (
    sectionCount >= RAIL_MIN_SECTIONS &&
    viewportHeight > 0 &&
    contentHeight > viewportHeight * RAIL_MIN_VIEWPORTS
  );
}

/**
 * The section on screen: the last heading at or above a reading line near the
 * top of the view. At the end of the document the reading line moves to the
 * bottom, so a short final section that can never reach the top still lights
 * up when you get there. -1 while the view is above the first heading.
 *
 * `tops` are heading positions in the scroller's content coordinates, the
 * same space as scrollTop.
 *
 * `pinned` is a section just chosen from the rail. It stays the answer while
 * its heading sits between the top of the view and the reading line, so a
 * heading followed closely by a subheading lights the tick that was clicked,
 * not the subheading below it.
 */
export function activeSectionIndex(
  tops: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
  pinned: number | null = null
): number {
  if (!tops.length) return -1;
  const atEnd = scrollTop + viewportHeight >= contentHeight - 2;
  const line = atEnd ? scrollTop + viewportHeight - 1 : scrollTop + Math.min(96, viewportHeight * 0.25);
  if (pinned !== null && pinned >= 0 && pinned < tops.length && tops[pinned] >= scrollTop - 2 && tops[pinned] <= line) {
    return pinned;
  }
  let active = -1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) active = i;
    else break;
  }
  return active;
}

/** Tick length in px by heading level: H1 longest. */
export const TICK_LENGTH: Record<SectionLevel, number> = { 1: 16, 2: 11, 3: 7 };

/**
 * Vertical distance between ticks. Compact like the T3 rail, tighter for a
 * long outline. Null when even the tightest spacing does not fit.
 */
export function tickPitch(count: number, availableHeight: number, { max = 8, min = 4 } = {}): number | null {
  if (count <= 0) return max;
  const fit = Math.floor((availableHeight * 0.9) / count);
  if (fit >= max) return max;
  return fit >= min ? fit : null;
}

/**
 * The deepest heading level to show so the rail fits its height: H1-H3, then
 * H1-H2, then H1 alone. A level is only dropped while enough ticks remain to
 * read as an outline; past that the rail scrolls instead.
 */
export function levelsThatFit(levels: readonly SectionLevel[], availableHeight: number): SectionLevel {
  let viable: SectionLevel = 3;
  for (const deepest of [3, 2, 1] as const) {
    const count = levels.filter((level) => level <= deepest).length;
    if (deepest < 3 && count < RAIL_MIN_SECTIONS) break;
    viable = deepest;
    if (tickPitch(count, availableHeight) !== null) return deepest;
  }
  return viable;
}
