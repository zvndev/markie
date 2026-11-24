// The system text size (Dynamic Type, Android font scale) as the app applies
// it: all of it to what is read and written, a capped part to the app's own
// labels, and never a number that could break a layout.
import { describe, expect, it } from "vitest";
import { MAX_CHROME_SCALE, MAX_TEXT_SCALE, MIN_TEXT_SCALE, applyTextScale, clampTextScale, splitTextScale, startTextSize } from "../src/lib/text-size";

describe("the system text size", () => {
  it("is 1 at the default and for anything that is not a size", () => {
    expect(clampTextScale(1)).toBe(1);
    for (const bad of [undefined, null, "1.3", Number.NaN, Number.POSITIVE_INFINITY, 0, -2]) expect(clampTextScale(bad)).toBe(1);
  });

  it("is held between the smallest and the largest the layouts were checked at", () => {
    expect(clampTextScale(0.5)).toBe(MIN_TEXT_SCALE);
    // iOS's largest accessibility size is 53pt body, 3.1 times the default.
    expect(clampTextScale(53 / 17)).toBe(MAX_TEXT_SCALE);
    expect(clampTextScale(1.3)).toBe(1.3);
  });

  it("gives the app's labels a capped part and the document the rest", () => {
    expect(splitTextScale(1)).toEqual({ chrome: 1, content: 1 });
    expect(splitTextScale(1.1)).toEqual({ chrome: 1.1, content: 1 });
    const large = splitTextScale(2);
    expect(large.chrome).toBe(MAX_CHROME_SCALE);
    expect(large.chrome * large.content).toBeCloseTo(2, 2);
    // Smaller than the default shrinks everything together.
    expect(splitTextScale(0.85)).toEqual({ chrome: 0.85, content: 1 });
  });

  it("paints the two numbers, and zooms the page only where the native side has not", () => {
    const set = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => { set.set(name, value); } } } as unknown as HTMLElement;
    applyTextScale(1.3, { pageZoom: true }, root);
    expect(set.get("--m-chrome-scale")).toBe("1.15");
    expect(Number(set.get("--m-text-scale")) * 1.15).toBeCloseTo(1.3, 2);
    expect(set.get("-webkit-text-size-adjust")).toBe("115%");
    set.clear();
    applyTextScale(2, { pageZoom: false }, root);
    expect(set.has("-webkit-text-size-adjust")).toBe(false);
    expect(set.get("--m-chrome-scale")).toBe("1.15");
  });

  it("does nothing in a desktop browser", () => {
    let asked = 0;
    const stop = startTextSize("web", { get: async () => { asked += 1; return { scale: 2 }; } });
    stop();
    expect(asked).toBe(0);
  });
});
