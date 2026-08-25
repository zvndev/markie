import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_STEP,
  maxPanelWidth,
  nudgePanelWidth,
  readPanelWidth,
  resizePanelWidth,
} from "./panel-width";

describe("how wide the panel is allowed to get", () => {
  it("uses the hard maximum on a roomy window", () => {
    expect(maxPanelWidth(1600)).toBe(LEFT_PANEL_MAX_WIDTH);
  });

  // A 520px panel inside an 800px window leaves the document a slot too narrow
  // to read, so the viewport share wins.
  it("falls back to 45% of a narrow window", () => {
    expect(maxPanelWidth(800)).toBe(360);
    expect(maxPanelWidth(600)).toBe(270);
  });

  it("never drops below the minimum, however small the window claims to be", () => {
    expect(maxPanelWidth(300)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(maxPanelWidth(0)).toBe(LEFT_PANEL_MIN_WIDTH);
  });
});

describe("clamping a supplied width", () => {
  it("leaves a sensible width alone", () => {
    expect(clampPanelWidth(300, 1280)).toBe(300);
  });

  it("pulls a too-narrow width up to the minimum", () => {
    expect(clampPanelWidth(40, 1280)).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it("pulls a too-wide width down to the maximum", () => {
    expect(clampPanelWidth(900, 1600)).toBe(LEFT_PANEL_MAX_WIDTH);
  });

  it("respects the viewport share before the hard maximum", () => {
    expect(clampPanelWidth(520, 800)).toBe(360);
    expect(clampPanelWidth(400, 600)).toBe(270);
  });

  // A corrupt preference should restore the shipped look, not the minimum.
  it("falls back to the default for a width that is not a width", () => {
    expect(clampPanelWidth(Number.NaN, 1280)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(Number.POSITIVE_INFINITY, 1280)).toBe(
      LEFT_PANEL_DEFAULT_WIDTH
    );
    expect(clampPanelWidth(-0, 1280)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it("rounds to whole pixels", () => {
    expect(clampPanelWidth(300.6, 1280)).toBe(301);
  });
});

describe("dragging the separator", () => {
  it("follows the pointer", () => {
    expect(resizePanelWidth(252, 120, 1280)).toBe(372);
    expect(resizePanelWidth(252, -30, 1280)).toBe(222);
  });

  // The decision behind this test: dragging hard to the left stops at the
  // minimum. It must NOT collapse the panel.
  it("stops at the minimum instead of collapsing", () => {
    expect(resizePanelWidth(252, -400, 1280)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(resizePanelWidth(252, -5000, 1280)).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it("stops at the maximum", () => {
    expect(resizePanelWidth(252, 900, 1600)).toBe(LEFT_PANEL_MAX_WIDTH);
  });
});

describe("reading the stored width", () => {
  it("reads a stored number", () => {
    expect(readPanelWidth("372", 1280)).toBe(372);
  });

  it("defaults when there is nothing usable stored", () => {
    expect(readPanelWidth(null, 1280)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    expect(readPanelWidth("abc", 1280)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    expect(readPanelWidth("", 1280)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  // Stored wide, then the window shrank.
  it("re-clamps a stored width against the current window", () => {
    expect(readPanelWidth("520", 800)).toBe(360);
  });
});

describe("nudging with the keyboard", () => {
  it("steps by a fixed amount", () => {
    expect(nudgePanelWidth(252, LEFT_PANEL_STEP, 1280)).toBe(268);
    expect(nudgePanelWidth(252, -LEFT_PANEL_STEP, 1280)).toBe(236);
  });

  it("stops at the minimum", () => {
    expect(nudgePanelWidth(204, -LEFT_PANEL_STEP, 1280)).toBe(
      LEFT_PANEL_MIN_WIDTH
    );
  });
});
