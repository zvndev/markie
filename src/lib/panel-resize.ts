// How wide the side panel is allowed to be.
//
// Three rules, in order of how hard they are:
//
//   1. Never more than half the window. A file list wider than the document it
//      sits beside is not a layout anyone chose.
//   2. Never a useless sliver. Dragging inward stops at a minimum instead of
//      letting the panel shrink until the filenames are unreadable.
//   3. Past a point, stop resisting and just close. A panel dragged nearly shut
//      is a panel the user is trying to get rid of.
//
// Kept separate from the component because it is entirely decisions, and
// decisions are the part worth testing.

export const PANEL_DEFAULT_WIDTH = 252; // what the panel has always been
export const PANEL_MIN_WIDTH = 180;
export const PANEL_SNAP_WIDTH = 140;
export const PANEL_MAX_FRACTION = 0.5;

const STORAGE_KEY = "markie.panel.v1";

export type PanelSize = { collapsed: true } | { collapsed: false; width: number };

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StorageOptions {
  storage?: PanelStorage | null;
}

function defaultStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(opts?: StorageOptions): PanelStorage | null {
  return opts && "storage" in opts ? opts.storage ?? null : defaultStorage();
}

/**
 * What the panel should be, given a dragged width and the window it lives in.
 *
 * Also the right thing to call on window resize: a width that was reasonable in
 * a wide window can be more than half a narrow one, and nothing else re-checks.
 */
export function panelSizeFor(desiredWidth: number, windowWidth: number): PanelSize {
  const max = Math.floor(windowWidth * PANEL_MAX_FRACTION);
  // The window is too narrow to hold a panel anyone could read, so there is no
  // width to offer.
  if (max < PANEL_SNAP_WIDTH) return { collapsed: true };
  if (!Number.isFinite(desiredWidth) || desiredWidth < PANEL_SNAP_WIDTH) {
    return { collapsed: true };
  }
  // When half the window is narrower than the minimum, the maximum wins: "never
  // more than half" is the harder promise of the two.
  const min = Math.min(PANEL_MIN_WIDTH, max);
  return { collapsed: false, width: Math.round(Math.min(Math.max(desiredWidth, min), max)) };
}

export function loadPanelWidth(opts?: StorageOptions): number {
  const storage = resolveStorage(opts);
  if (!storage) return PANEL_DEFAULT_WIDTH;
  try {
    const raw = Number(storage.getItem(STORAGE_KEY));
    // A corrupted or hand-edited value should not decide someone's layout.
    return Number.isFinite(raw) && raw > 0 ? raw : PANEL_DEFAULT_WIDTH;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

export function savePanelWidth(width: number, opts?: StorageOptions): void {
  const storage = resolveStorage(opts);
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage unavailable. The panel still resizes for this session; it just
    // won't be remembered, which is not worth failing a drag over.
  }
}
