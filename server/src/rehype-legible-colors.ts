// Keeps a document's own colours readable on a hosted page in light and dark.
//
// A document can carry inline colours: the rich editor writes them, and text
// pasted in from Word, RTF or ODT brings its runs' colours along. An authored
// black run is invisible on the dark page, an authored white or pale-yellow
// one on the light page, and a pale highlight behind text that inherits the
// dark page's light ink is unreadable too.
//
// The page cannot know server-side which scheme the reader uses, so this
// works out both answers and leaves the choice to a stylesheet, one rule per
// distinct style attribute that needs one:
//
//   colour fails on the light page   (prefers-color-scheme: light) readable colour
//   colour fails on the dark page    (prefers-color-scheme: dark) readable colour
//   own background, no own colour    ink or white, whichever reads on it
//
// The rules select the element by its exact style attribute, so the markup is
// left exactly as authored and a colour that already reads on both pages gets
// no rule at all. The colour rule is the one
// src/components/documents/word-colors.ts uses in the app (keep hue, mirror
// lightness, step to 4.5:1); the server cannot import the renderer, so it is
// restated here.
//
// The stylesheet goes into a <style> element, so the attribute value is
// written as a CSS string with every character but [A-Za-z0-9 _-] escaped:
// nothing an author put in a style attribute can close the string, the rule
// or the element. Every colour in a rule is one this file computed.
import { visit } from "unist-util-visit";

type Rgb = readonly [number, number, number];

// The two page backgrounds in render.ts (--page-bg), and the logo ink.
const LIGHT_PAGE: Rgb = [0xf6, 0xf4, 0xef];
const DARK_PAGE: Rgb = [0x17, 0x17, 0x19];
const INK = "#2c2c2c"; // brand.ts BRAND_COLORS.ink
const WHITE = "#ffffff";

const MIN_CONTRAST = 3;
const ADAPTED_CONTRAST = 4.5;

// What an editor or a pasted Office run actually writes by name. Anything
// else unrecognised is left alone, which is the old behaviour.
const NAMED: Record<string, Rgb> = {
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], red: [255, 0, 0], maroon: [128, 0, 0], yellow: [255, 255, 0],
  olive: [128, 128, 0], lime: [0, 255, 0], green: [0, 128, 0], aqua: [0, 255, 255],
  cyan: [0, 255, 255], teal: [0, 128, 128], blue: [0, 0, 255], navy: [0, 0, 128],
  fuchsia: [255, 0, 255], magenta: [255, 0, 255], purple: [128, 0, 128], orange: [255, 165, 0],
};

export function parseCssColor(value: string): Rgb | null {
  const raw = value.trim().toLowerCase();
  if (NAMED[raw]) return NAMED[raw];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(raw);
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].slice(0, 3).split("").map((c) => c + c).join("") : hex[1];
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(raw);
  if (rgb) {
    // A see-through colour's real look depends on what is behind it; leave it.
    if (rgb[4] !== undefined && !/^(1|1\.0+|100%)$/.test(rgb[4])) return null;
    return [rgb[1], rgb[2], rgb[3]].map((c) => Math.max(0, Math.min(255, Math.round(Number(c))))) as unknown as Rgb;
  }
  return null;
}

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (!s) return [l * 255, l * 255, l * 255].map(Math.round) as unknown as Rgb;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((v) => Math.round(v * 255)) as unknown as Rgb;
}

/** A readable stand-in for `color` on `page`, or null when it already reads. */
export function readableOn(color: Rgb, page: Rgb): string | null {
  if (contrastRatio(color, page) >= MIN_CONTRAST) return null;
  const [h, s, l] = toHsl(color);
  const chroma = (Math.max(...color) - Math.min(...color)) / 255;
  if (chroma < 0.1 && (l <= 0.25 || l >= 0.75)) return "var(--text)";
  const darkPage = contrastRatio([255, 255, 255], page) > contrastRatio([0, 0, 0], page);
  let next = darkPage ? Math.max(l, 1 - l) : Math.min(l, 1 - l);
  let candidate = fromHsl(h, s, next);
  while (contrastRatio(candidate, page) < ADAPTED_CONTRAST && (darkPage ? next < 1 : next > 0)) {
    next = darkPage ? Math.min(1, next + 0.02) : Math.max(0, next - 0.02);
    candidate = fromHsl(h, s, next);
  }
  return toHex(candidate);
}

function declarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).replace(/!important/i, "").trim());
  }
  return out;
}

interface ElementNode {
  tagName?: string;
  properties?: Record<string, unknown>;
}

/** A CSS string literal that nothing inside can break out of. */
export function cssString(value: string): string {
  return `"${value.replace(/[^A-Za-z0-9 _-]/gu, (ch) => `\\${ch.codePointAt(0)!.toString(16)} `)}"`;
}

// A pasted Word document can carry a style per run. Past this many distinct
// ones the rest keep their authored colours rather than grow the page.
const MAX_RULES = 400;

interface Adaptation {
  onBg: string | null;
  light: string | null;
  dark: string | null;
}

function adaptationFor(tagName: string | undefined, style: string): Adaptation | null {
  if (!/color|background/i.test(style)) return null;
  const decls = declarations(style);
  const background = decls.get("background-color") ?? decls.get("background");
  const bg = background ? parseCssColor(background) : null;
  const authored = decls.get("color");
  if (bg) {
    // Text on its own background answers to that background, in both
    // schemes. An author who set both picked the pair; leave it. A <mark>
    // already gets dark text from the browser, so only a dark one needs it.
    if (authored) return null;
    const onBg = contrastRatio([0x2c, 0x2c, 0x2c], bg) >= contrastRatio([255, 255, 255], bg) ? INK : WHITE;
    return tagName !== "mark" || onBg === WHITE ? { onBg, light: null, dark: null } : null;
  }
  const color = authored ? parseCssColor(authored) : null;
  if (!color) return null;
  const light = readableOn(color, LIGHT_PAGE);
  const dark = readableOn(color, DARK_PAGE);
  return light || dark ? { onBg: null, light, dark } : null;
}

/** The stylesheet for a set of adaptations, keyed by exact style attribute. */
export function legibleColorCss(rules: Map<string, Adaptation>): string {
  const plain: string[] = [], light: string[] = [], dark: string[] = [];
  for (const [style, a] of rules) {
    const sel = `main [style=${cssString(style)}]`;
    if (a.onBg) plain.push(`${sel}{color:${a.onBg}}`);
    if (a.light) light.push(`${sel}{color:${a.light} !important}`);
    if (a.dark) dark.push(`${sel}{color:${a.dark} !important}`);
  }
  return [
    plain.join(""),
    light.length ? `@media (prefers-color-scheme: light){${light.join("")}}` : "",
    dark.length ? `@media (prefers-color-scheme: dark){${dark.join("")}}` : "",
  ].join("");
}

/**
 * Collects what each styled element needs and leaves the stylesheet on
 * file.data.legibleCss (empty when nothing does). The tree is not changed.
 */
export function rehypeLegibleColors() {
  return (tree: unknown, file: { data: Record<string, unknown> }) => {
    const rules = new Map<string, Adaptation>();
    visit(tree as never, "element", (node: ElementNode) => {
      const style = node.properties?.style;
      if (typeof style !== "string" || rules.has(style) || rules.size >= MAX_RULES) return;
      const adaptation = adaptationFor(node.tagName, style);
      if (adaptation) rules.set(style, adaptation);
    });
    file.data.legibleCss = legibleColorCss(rules);
  };
}
