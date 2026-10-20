import { useEffect, useState } from "react";
import { THEME_APPLIED_EVENT } from "@/lib/theme";

/**
 * Display-only adaptation of authored Word/RTF/ODT run colors to the on-screen
 * page. The page follows the app theme (var(--background)), so an authored
 * black run is invisible on a dark page and an authored white or pale-yellow
 * run is invisible on a light one. Word and Google Docs solve this in their
 * dark modes by keeping the hue and flipping lightness; this does the same.
 *
 * The result only ever reaches an inline `style.color` on screen. It never
 * touches the run model, so save, export and print keep the authored color.
 */
type Rgb = readonly [number, number, number];

/** Below this the authored color is treated as unreadable on the page. */
export const MIN_RUN_CONTRAST = 3;
/** An adapted color is pushed at least this far, so it reads as body text. */
export const ADAPTED_RUN_CONTRAST = 4.5;

export function parseCssColor(value: string | null | undefined): Rgb | null {
  const raw = value?.trim().toLowerCase() ?? "";
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(raw);
  if (hex) {
    const digits = hex[1].length <= 4 ? hex[1].slice(0, 3).split("").map((char) => char + char).join("") : hex[1];
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(raw);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((channel) => Math.max(0, Math.min(255, Math.round(channel)))) as unknown as Rgb;
  return null;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue), lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): Rgb {
  if (!saturation) return [lightness * 255, lightness * 255, lightness * 255].map(Math.round) as unknown as Rgb;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation, p = 2 * lightness - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((value) => Math.round(value * 255)) as unknown as Rgb;
}

/**
 * Inline CSS color for an authored run color on a page of `background`.
 * Deterministic for a given (authored, background) pair, which the paragraph
 * editor relies on: it records the painted style and rejects any edit whose
 * span style no longer matches it.
 *
 * - Readable as authored (contrast >= 3:1): keep it exactly.
 * - Near-black or near-white neutral: use the theme's own text color.
 * - Anything else: keep hue and saturation, mirror lightness to the page's
 *   readable side, then step further until it reaches 4.5:1.
 */
export function displayRunColor(authored: string, background: string | null | undefined): string {
  const color = parseCssColor(`#${authored}`);
  if (!color) return "";
  const literal = toHex(color);
  const page = parseCssColor(background);
  if (!page || contrastRatio(color, page) >= MIN_RUN_CONTRAST) return literal;
  const [hue, saturation, lightness] = toHsl(color);
  const chroma = (Math.max(...color) - Math.min(...color)) / 255;
  if (chroma < 0.1 && (lightness <= 0.25 || lightness >= 0.75)) return "var(--foreground)";
  const darkPage = contrastRatio([255, 255, 255], page) > contrastRatio([0, 0, 0], page);
  let next = darkPage ? Math.max(lightness, 1 - lightness) : Math.min(lightness, 1 - lightness);
  let candidate = fromHsl(hue, saturation, next);
  while (contrastRatio(candidate, page) < ADAPTED_RUN_CONTRAST && (darkPage ? next < 1 : next > 0)) {
    next = darkPage ? Math.min(1, next + 0.02) : Math.max(0, next - 0.02);
    candidate = fromHsl(hue, saturation, next);
  }
  return toHex(candidate);
}

/** The live page background as a normalized hex, or null when the theme is unknown. */
export function readWordPageBackground(): string | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const declared = root.style.getPropertyValue("--background") || (typeof getComputedStyle === "function" ? getComputedStyle(root).getPropertyValue("--background") : "");
  const parsed = parseCssColor(declared);
  if (parsed) return toHex(parsed);
  // A theme color the parser cannot read (for example oklch) still has a tone.
  const tone = root.dataset.themeTone;
  return tone === "dark" ? "#000000" : tone === "light" ? "#ffffff" : null;
}

/** Re-renders whenever the app applies a theme, so run colors re-adapt live. */
export function useWordPageBackground(): string | null {
  const [background, setBackground] = useState(readWordPageBackground);
  useEffect(() => {
    const update = () => setBackground(readWordPageBackground());
    update();
    window.addEventListener(THEME_APPLIED_EVENT, update);
    return () => window.removeEventListener(THEME_APPLIED_EVENT, update);
  }, []);
  return background;
}
