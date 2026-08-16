import { describe, expect, it } from "vitest";
import {
  appearanceKey,
  appearanceVars,
  clampFontSize,
  DEFAULT_APPEARANCE,
  DOC_FONTS,
  fontStack,
  isDefault,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  normalizeAppearance,
  stepZoom,
  ZOOM_STEPS,
  zoomLabel,
} from "./doc-appearance";

describe("font size", () => {
  it("keeps the document readable at both ends", () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(400)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(18)).toBe(18);
  });

  it("falls back rather than rendering a document at NaN pixels", () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_APPEARANCE.fontSize);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_APPEARANCE.fontSize);
  });

  it("rounds, because half a pixel is not a font size", () => {
    expect(clampFontSize(16.4)).toBe(16);
    expect(clampFontSize(16.6)).toBe(17);
  });
});

describe("zoom", () => {
  // Repeated presses should land on numbers a person recognises, not 1.331.
  it("steps between presets", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.1, 1)).toBe(1.25);
  });

  // A value between presets snaps to the nearest and then moves one. Zooming
  // in must always end up larger than where it started, and must not skip a
  // stop to get there.
  it("snaps a value between presets to the nearest before stepping", () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(0.97, -1)).toBe(0.9);
    expect(stepZoom(1.15, 1)).toBe(1.25);
    expect(stepZoom(1.15, -1)).toBe(1);
  });

  it("stops at the ends instead of wrapping", () => {
    const [smallest] = ZOOM_STEPS;
    const largest = ZOOM_STEPS[ZOOM_STEPS.length - 1];
    expect(stepZoom(smallest, -1)).toBe(smallest);
    expect(stepZoom(largest, 1)).toBe(largest);
  });

  it("reads as a percentage", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
    expect(zoomLabel(0.5)).toBe("50%");
  });
});

describe("fonts", () => {
  it("resolves a known font to its stack", () => {
    expect(fontStack("charter")).toContain("Charter");
  });

  it("falls back to the first font for one it does not know", () => {
    expect(fontStack("comic-sans")).toBe(DOC_FONTS[0].stack);
  });

  // A stack, not a single name, so a missing font does not leave the document
  // in whatever the browser picks by default.
  it("offers a fallback chain for every font", () => {
    for (const font of DOC_FONTS) {
      expect(font.stack.length).toBeGreaterThan(0);
      if (!font.stack.startsWith("var(")) {
        expect(font.stack).toContain(",");
      }
    }
  });
});

describe("stored settings are never trusted", () => {
  it("returns the default for nothing at all", () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({})).toEqual(DEFAULT_APPEARANCE);
  });

  it("drops a font it does not recognise", () => {
    expect(normalizeAppearance({ fontFamily: "'; DROP TABLE" }).fontFamily).toBe(
      DEFAULT_APPEARANCE.fontFamily
    );
  });

  it("clamps a size and a zoom that came from somewhere else", () => {
    const out = normalizeAppearance({ fontSize: 9999, zoom: 50 });
    expect(out.fontSize).toBe(MAX_FONT_SIZE);
    expect(out.zoom).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  });

  // Zero and negative are not small zooms, they are nonsense, so they get the
  // default rather than being clamped into the range as if they meant
  // something.
  it("rejects a zoom of zero or less rather than rendering nothing", () => {
    expect(normalizeAppearance({ zoom: 0 }).zoom).toBe(DEFAULT_APPEARANCE.zoom);
    expect(normalizeAppearance({ zoom: -2 }).zoom).toBe(DEFAULT_APPEARANCE.zoom);
  });
});

describe("what the canvas reads", () => {
  it("multiplies size by zoom so text reflows instead of overflowing", () => {
    const vars = appearanceVars({ fontFamily: "system", fontSize: 16, zoom: 1.5 });
    expect(vars["--doc-font-size"]).toBe("24.00px");
  });

  it("names a real font stack", () => {
    const vars = appearanceVars({ fontFamily: "georgia", fontSize: 16, zoom: 1 });
    expect(vars["--doc-font-family"]).toContain("Georgia");
  });
});

describe("where it is stored", () => {
  it("keys per document, so two files can be read differently", () => {
    expect(appearanceKey("/a/one.md")).not.toBe(appearanceKey("/a/two.md"));
  });

  it("has somewhere to put an unsaved document", () => {
    expect(appearanceKey(null)).toContain("untitled");
  });
});

describe("knowing when nothing has been changed", () => {
  it("recognises the default", () => {
    expect(isDefault(DEFAULT_APPEARANCE)).toBe(true);
    expect(isDefault({ ...DEFAULT_APPEARANCE, zoom: 1.25 })).toBe(false);
  });
});
