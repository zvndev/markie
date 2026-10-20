// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, MARKIE_DARK, MARKIE_LIGHT } from "@/lib/theme";
import { ADAPTED_RUN_CONTRAST, contrastRatio, displayRunColor, parseCssColor, readWordPageBackground } from "./word-colors";

const DARK = MARKIE_DARK.tokens.background, LIGHT = MARKIE_LIGHT.tokens.background;
const rgb = (value: string) => parseCssColor(value)!;

afterEach(() => { document.documentElement.removeAttribute("style"); delete document.documentElement.dataset.themeTone; });

describe("display-only Word run colors", () => {
  it("keeps authored colors exactly when they already read on the page", () => {
    expect(displayRunColor("CC0000", DARK)).toBe("#cc0000");
    expect(displayRunColor("cc0000", LIGHT)).toBe("#cc0000");
    expect(displayRunColor("336699", DARK)).toBe("#336699");
    expect(displayRunColor("000000", LIGHT)).toBe("#000000");
    expect(displayRunColor("ffffff", DARK)).toBe("#ffffff");
  });

  it("hands near-black and near-white neutrals to the theme text color", () => {
    for (const authored of ["000000", "222222", "333333", "1a1a1a"]) expect(displayRunColor(authored, DARK)).toBe("var(--foreground)");
    for (const authored of ["ffffff", "f2f2f2", "eeeeee"]) expect(displayRunColor(authored, LIGHT)).toBe("var(--foreground)");
  });

  it.each([
    ["1f3864", DARK], ["0000ff", DARK], ["002060", DARK], ["555555", DARK],
    ["ffff00", LIGHT], ["00ffff", LIGHT], ["ffc000", LIGHT], ["bbbbbb", LIGHT],
  ])("mirrors %s to a readable color of the same hue on %s", (authored, page) => {
    const adapted = displayRunColor(authored, page);
    expect(adapted).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(rgb(adapted), rgb(page))).toBeGreaterThanOrEqual(ADAPTED_RUN_CONTRAST);
    const [r, g, b] = rgb(`#${authored}`), [ar, ag, ab] = rgb(adapted);
    // Hue survives: the dominant channel of a chromatic color stays dominant.
    if (Math.max(r, g, b) !== Math.min(r, g, b)) expect([ar, ag, ab].indexOf(Math.max(ar, ag, ab))).toBe([r, g, b].indexOf(Math.max(r, g, b)));
  });

  it("is deterministic and leaves colors alone when the page is unknown", () => {
    expect(displayRunColor("1f3864", DARK)).toBe(displayRunColor("1f3864", DARK));
    expect(displayRunColor("000000", null)).toBe("#000000");
    expect(displayRunColor("nothex", DARK)).toBe("");
  });

  it("reads the live page from the applied theme, including templates beyond Markie Light and Dark", () => {
    expect(readWordPageBackground()).toBeNull();
    applyTheme(MARKIE_DARK.tokens); expect(readWordPageBackground()).toBe(DARK);
    applyTheme({ ...MARKIE_LIGHT.tokens, background: "#fdf6e3" }); expect(readWordPageBackground()).toBe("#fdf6e3");
    applyTheme({ ...MARKIE_DARK.tokens, background: "oklch(0.2 0.02 250)" }); expect(readWordPageBackground()).toBe("#000000");
  });
});
