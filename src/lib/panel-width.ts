// Width of the left library panel. The panel is unmounted while collapsed and
// remounted (key={leftView}) when the rail switches views, so the width has to
// live somewhere it can be re-read on every mount — renderer localStorage, the
// same convention as the Recent/Files tab and colour mode.
export const LEFT_PANEL_WIDTH_KEY = "markie.leftpanel.width.v1";

// 200 is the floor the overview band's three-column grid still reads at; 520
// keeps at least a 712px document column on a 1280px window; 252 is the width
// the panel shipped with, so an untouched install looks unchanged.
export const LEFT_PANEL_MIN_WIDTH = 200;
export const LEFT_PANEL_MAX_WIDTH = 520;
export const LEFT_PANEL_DEFAULT_WIDTH = 252;

// On a small window the hard maximum would eat the document, so the panel also
// never takes more than this share of the viewport.
export const LEFT_PANEL_MAX_FRACTION = 0.45;

// Keyboard nudges from the separator handle.
export const LEFT_PANEL_STEP = 16;
export const LEFT_PANEL_STEP_LARGE = 64;

// The widest the panel may be in a viewport this wide. Never below the minimum:
// a tiny window should still show a usable panel rather than a sliver.
export function maxPanelWidth(viewportWidth: number): number {
  const fromViewport = Number.isFinite(viewportWidth)
    ? Math.round(viewportWidth * LEFT_PANEL_MAX_FRACTION)
    : LEFT_PANEL_MAX_WIDTH;
  return Math.max(
    LEFT_PANEL_MIN_WIDTH,
    Math.min(LEFT_PANEL_MAX_WIDTH, fromViewport)
  );
}

function clampToBounds(width: number, viewportWidth: number): number {
  return Math.max(
    LEFT_PANEL_MIN_WIDTH,
    Math.min(maxPanelWidth(viewportWidth), Math.round(width))
  );
}

// Clamp a *stored or supplied* width. A width that can't be a width at all
// (NaN, Infinity, zero or negative) falls back to the default rather than to
// the minimum, so a corrupt preference restores the shipped look.
export function clampPanelWidth(width: number, viewportWidth: number): number {
  const wanted =
    Number.isFinite(width) && width > 0 ? width : LEFT_PANEL_DEFAULT_WIDTH;
  return clampToBounds(wanted, viewportWidth);
}

// localStorage hands back strings or null; anything unparseable is a default.
export function readPanelWidth(
  raw: string | null,
  viewportWidth: number
): number {
  if (raw === null || raw.trim() === "") {
    return clampPanelWidth(LEFT_PANEL_DEFAULT_WIDTH, viewportWidth);
  }
  return clampPanelWidth(Number(raw), viewportWidth);
}

// Live drag. Dragging past the minimum clamps at the minimum — it does not
// collapse the panel; collapsing stays an explicit act (⌘L, the rail, the
// chevron), because a drag that silently unmounts the panel is a one-way door.
export function resizePanelWidth(
  startWidth: number,
  dx: number,
  viewportWidth: number
): number {
  const start = Number.isFinite(startWidth)
    ? startWidth
    : LEFT_PANEL_DEFAULT_WIDTH;
  const delta = Number.isFinite(dx) ? dx : 0;
  return clampToBounds(start + delta, viewportWidth);
}

// Keyboard arrows on the separator.
export function nudgePanelWidth(
  width: number,
  deltaPx: number,
  viewportWidth: number
): number {
  return resizePanelWidth(width, deltaPx, viewportWidth);
}
