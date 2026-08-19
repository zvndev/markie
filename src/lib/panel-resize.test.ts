import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_FRACTION,
  PANEL_MIN_WIDTH,
  PANEL_SNAP_WIDTH,
  loadPanelWidth,
  panelSizeFor,
  savePanelWidth,
} from "./panel-resize";

const WIDE = 1600; // half is 800, so the max never interferes

function fakeStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set("markie.panel.v1", seed);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("panelSizeFor", () => {
  it("keeps a comfortable width exactly as dragged", () => {
    expect(panelSizeFor(320, WIDE)).toEqual({ collapsed: false, width: 320 });
  });

  it("holds at the minimum rather than letting the panel get unusable", () => {
    // Between the minimum and the snap point the panel resists: it stops
    // moving instead of shrinking into a useless sliver.
    expect(panelSizeFor(160, WIDE)).toEqual({ collapsed: false, width: PANEL_MIN_WIDTH });
    expect(panelSizeFor(PANEL_SNAP_WIDTH, WIDE)).toEqual({
      collapsed: false,
      width: PANEL_MIN_WIDTH,
    });
  });

  it("collapses once you drag past the snap point", () => {
    expect(panelSizeFor(PANEL_SNAP_WIDTH - 1, WIDE)).toEqual({ collapsed: true });
    expect(panelSizeFor(40, WIDE)).toEqual({ collapsed: true });
    expect(panelSizeFor(0, WIDE)).toEqual({ collapsed: true });
    expect(panelSizeFor(-200, WIDE)).toEqual({ collapsed: true });
  });

  it("never lets the panel take more than half the app", () => {
    const size = panelSizeFor(5000, 1000);
    expect(size).toEqual({ collapsed: false, width: 500 });
    expect(500 / 1000).toBe(PANEL_MAX_FRACTION);
  });

  it("re-clamps a stored width when the window shrinks under it", () => {
    // A 600px panel is fine in a wide window and more than half a narrow one.
    // Without this, shrinking the app leaves the document with no room.
    expect(panelSizeFor(600, 900)).toEqual({ collapsed: false, width: 450 });
  });

  it("lets the maximum win when the window is too narrow for the minimum", () => {
    // Half of 300 is 150, below the 180 minimum. "Never more than half" is the
    // harder rule: a panel wider than the document it sits next to is worse
    // than a slightly cramped one.
    expect(panelSizeFor(400, 300)).toEqual({ collapsed: false, width: 150 });
  });

  it("collapses when the window cannot fit a usable panel at all", () => {
    // Half of 200 is 100, below even the snap point, so there is no width the
    // panel could legitimately occupy.
    expect(panelSizeFor(400, 200)).toEqual({ collapsed: true });
  });

  it("returns whole pixels", () => {
    const size = panelSizeFor(333.7, 1001);
    expect(size.collapsed).toBe(false);
    if (!size.collapsed) expect(Number.isInteger(size.width)).toBe(true);
  });
});

describe("loadPanelWidth", () => {
  it("defaults to the width the panel has always had", () => {
    // Nobody's layout should move on upgrade.
    expect(loadPanelWidth({ storage: fakeStorage() })).toBe(PANEL_DEFAULT_WIDTH);
    expect(PANEL_DEFAULT_WIDTH).toBe(252);
  });

  it("reads back a saved width", () => {
    expect(loadPanelWidth({ storage: fakeStorage("340") })).toBe(340);
  });

  it("falls back to the default on a corrupted value", () => {
    for (const bad of ["", "abc", "NaN", "-50", "0", "{}"]) {
      expect(loadPanelWidth({ storage: fakeStorage(bad) })).toBe(PANEL_DEFAULT_WIDTH);
    }
  });

  it("survives storage being unavailable", () => {
    expect(loadPanelWidth({ storage: null })).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe("savePanelWidth", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    savePanelWidth(300, { storage });
    expect(loadPanelWidth({ storage })).toBe(300);
  });

  it("never throws when storage refuses", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => savePanelWidth(300, { storage: hostile })).not.toThrow();
  });
});
