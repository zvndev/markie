// The font document code is set in.
//
// The theme's tokens carry a body and a heading font. The code font is kept
// here for now, as a preference on this computer, and painted through its own
// custom property. It reads a `codeFont` id off any tokens the theme paints,
// so the day the theme (or a pinned look) carries one, it is honoured with no
// change here. Like every font it is an id from the registry, never CSS.
import { codeTypefaces, findTypeface, adoptLocalTypeface } from "./registry";

const STORE_KEY = "markie.fonts.v1";
/** The stylesheet's own monospace stack. */
export const CODE_FONT_DEFAULT = "";
export const CODE_FONT_CHANGED_EVENT = "markie:code-font-changed";
// The same string theme.ts sends (THEME_APPLIED_EVENT). Not imported: theme.ts
// reads the registry, and this file should stay beside it, not above it.
const THEME_APPLIED = "markie:theme-applied";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A monospace typeface id, or the default for anything else. */
export function cleanCodeFont(id: unknown): string {
  if (typeof id !== "string" || !id) return CODE_FONT_DEFAULT;
  const face = findTypeface(id) ?? adoptLocalTypeface(id);
  return face && face.kind === "mono" ? face.id : CODE_FONT_DEFAULT;
}

export function loadCodeFont(): string {
  try {
    const raw = storage()?.getItem(STORE_KEY);
    return raw ? cleanCodeFont((JSON.parse(raw) as { codeFont?: unknown }).codeFont) : CODE_FONT_DEFAULT;
  } catch {
    return CODE_FONT_DEFAULT;
  }
}

/** The CSS a code font id paints, or "" for the default. */
export function codeFontStack(id: unknown): string {
  const clean = cleanCodeFont(id);
  return clean ? (codeTypefaces().find((face) => face.id === clean)?.stack ?? "") : "";
}

function paint(id: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const stack = codeFontStack(id);
  if (stack) {
    root.style.setProperty("--doc-code-family", stack);
    root.dataset.docCodeFont = cleanCodeFont(id);
  } else {
    root.style.removeProperty("--doc-code-family");
    delete root.dataset.docCodeFont;
  }
}

export function saveCodeFont(id: string): string {
  const clean = cleanCodeFont(id);
  storage()?.setItem(STORE_KEY, JSON.stringify({ codeFont: clean }));
  paint(clean);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CODE_FONT_CHANGED_EVENT, { detail: { codeFont: clean } }));
  return clean;
}

let started = false;

/**
 * Paints the stored code font and keeps it painted. Tokens that name a code
 * font of their own (an owner's pinned look) win while they are applied.
 */
export function startCodeFont(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  paint(loadCodeFont());
  window.addEventListener(THEME_APPLIED, (event) => {
    const tokens = (event as CustomEvent<{ tokens?: { codeFont?: unknown } }>).detail?.tokens;
    paint(cleanCodeFont(tokens?.codeFont) || loadCodeFont());
  });
}
