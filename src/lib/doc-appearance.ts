// How a document looks, without touching what it says.
//
// Markdown has no syntax for a font, a size, or a zoom level, and Markie's
// whole promise is that opening a file does not rewrite it. So appearance is
// kept beside the document rather than inside it: nothing here ever reaches the
// bytes on disk.
//
// This is also why the toolbar can honestly offer "font" and "size" while
// refusing underline and text colour. The first two are a way of looking at the
// document; the last two would be edits to it.

export interface DocAppearance {
  fontFamily: string;
  fontSize: number; // px, the document body
  zoom: number; // 1 = 100%
}

// Stacks rather than single names, so a document still renders if the first
// choice is missing. Serif first: this is a reading app.
export const DOC_FONTS: Array<{ id: string; label: string; stack: string }> = [
  { id: "system", label: "System", stack: "var(--font-geist-sans)" },
  { id: "charter", label: "Charter", stack: "Charter, Georgia, 'Times New Roman', serif" },
  { id: "georgia", label: "Georgia", stack: "Georgia, Charter, serif" },
  { id: "iowan", label: "Iowan", stack: "'Iowan Old Style', Palatino, Georgia, serif" },
  { id: "helvetica", label: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { id: "mono", label: "Monospace", stack: "var(--font-geist-mono)" },
];

export const DEFAULT_APPEARANCE: DocAppearance = {
  fontFamily: "system",
  fontSize: 16,
  zoom: 1,
};

// Bounds are about legibility, not taste: below 11px the reading column stops
// being readable, above 32 it stops being a document.
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 32;

export const ZOOM_STEPS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as const;

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_APPEARANCE.fontSize;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

// Steps to the next preset rather than a free multiplier, so repeated presses
// land on round numbers a person recognises instead of 1.331.
export function stepZoom(current: number, direction: 1 | -1): number {
  const steps = ZOOM_STEPS as readonly number[];
  const nearest = steps.reduce((best, step) =>
    Math.abs(step - current) < Math.abs(best - current) ? step : best
  );
  const index = steps.indexOf(nearest);
  const next = index + direction;
  if (next < 0) return steps[0];
  if (next >= steps.length) return steps[steps.length - 1];
  return steps[next];
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export function fontStack(fontFamily: string): string {
  return (
    DOC_FONTS.find((f) => f.id === fontFamily)?.stack ?? DOC_FONTS[0].stack
  );
}

// Anything stored can be edited by hand or come from an older version, so every
// field is validated rather than trusted.
export function normalizeAppearance(raw: unknown): DocAppearance {
  const value = (raw ?? {}) as Partial<DocAppearance>;
  const known = DOC_FONTS.some((f) => f.id === value.fontFamily);
  const zoom = Number(value.zoom);
  return {
    fontFamily: known ? (value.fontFamily as string) : DEFAULT_APPEARANCE.fontFamily,
    fontSize: clampFontSize(Number(value.fontSize ?? DEFAULT_APPEARANCE.fontSize)),
    zoom:
      Number.isFinite(zoom) && zoom > 0
        ? Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], zoom))
        : DEFAULT_APPEARANCE.zoom,
  };
}

// The CSS the document canvas reads. Zoom multiplies the size rather than using
// a transform, so text reflows to the column instead of overflowing it.
export function appearanceVars(
  appearance: DocAppearance
): Record<string, string> {
  return {
    "--doc-font-family": fontStack(appearance.fontFamily),
    "--doc-font-size": `${(appearance.fontSize * appearance.zoom).toFixed(2)}px`,
  };
}

// Keyed per document so two files can be read differently, and by path when
// there is one because that survives the file being re-synced.
export function appearanceKey(docKey: string | null): string {
  return `markie:appearance:${docKey ?? "untitled"}`;
}

export function isDefault(appearance: DocAppearance): boolean {
  return (
    appearance.fontFamily === DEFAULT_APPEARANCE.fontFamily &&
    appearance.fontSize === DEFAULT_APPEARANCE.fontSize &&
    appearance.zoom === DEFAULT_APPEARANCE.zoom
  );
}
