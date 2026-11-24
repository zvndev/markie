// A pinned look is another account's data: what of it a reader's client uses.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pinnedLookFrom, pinnedLookTokens, pinnedLookType, plainColor, safePinnedTokens } from "./pinned-look";

const TOKENS = { background: "#101010", surface: "#181818", surface2: "#202020", foreground: "#fafafa", muted: "#a1a1aa", border: "#333", accent: "#444", link: "#60a5fa" };

describe("plainColor", () => {
  it("accepts hex and colour functions over plain numbers", () => {
    for (const color of ["#fff", "#ffffff", "#ffffff80", "rgb(1, 2, 3)", "rgba(1,2,3,.5)", "hsl(210 40% 50%)", "oklch(0.7 0.1 250)"]) expect(plainColor(color)).toBe(color);
  });

  it("refuses anything that could load, reference or run something", () => {
    for (const value of ["url(https://evil.test/x)", "var(--x)", "red; background: url(x)", "linear-gradient(red, blue)", "expression(alert(1))", "#fff}body{display:none", "", " ", "x".repeat(100), 7, null, undefined, {}]) {
      expect(plainColor(value)).toBeNull();
    }
  });
});

describe("safePinnedTokens", () => {
  it("passes plain tokens through and drops what it does not know", () => {
    expect(safePinnedTokens({ ...TOKENS, docRule: "#222", bodyFont: "charter", fontSize: 17, onload: "alert(1)", statusGreen: "url(x)" })).toEqual({ ...TOKENS, docRule: "#222", bodyFont: "charter", fontSize: 17 });
  });

  it("answers null when a required colour is missing or not a colour", () => {
    expect(safePinnedTokens({ ...TOKENS, background: "url(https://evil.test/x)" })).toBeNull();
    const missing: Record<string, string> = { ...TOKENS };
    delete missing.link;
    expect(safePinnedTokens(missing)).toBeNull();
    for (const raw of [null, "x", 3, [TOKENS]]) expect(safePinnedTokens(raw)).toBeNull();
  });
});

describe("pinnedLookFrom", () => {
  it("is null when nothing is pinned", () => {
    for (const data of [null, undefined, "x", {}, { tokens: null, style: { base: "compact" } }, { tokens: "x" }]) expect(pinnedLookFrom(data)).toBeNull();
  });

  it("reads a pin made before styles existed as tokens with no style", () => {
    expect(pinnedLookFrom({ tokens: TOKENS })).toEqual({ tokens: TOKENS, type: {}, style: null });
  });

  it("cleans the style, and keeps it when the colours cannot be used", () => {
    expect(pinnedLookFrom({ tokens: TOKENS, style: { base: "classic", choices: { tableStyle: "grid", linkStyle: "x" }, future: true } })).toEqual({ tokens: TOKENS, type: {}, style: { base: "classic", choices: { tableStyle: "grid" } } });
    expect(pinnedLookFrom({ tokens: { background: "var(--x)", lineHeight: 1.9 }, style: { base: "classic" } })).toEqual({ tokens: null, type: { lineHeight: 1.9 }, style: { base: "classic" } });
  });
});

describe("the faces a pinned look is read in", () => {
  it("keeps the pinned tokens' own text faces, and takes the code face from the style", () => {
    const look = pinnedLookFrom({ tokens: { ...TOKENS, bodyFont: "literata", headingFont: "eb-garamond", codeFont: "source-code" }, style: { base: "technical", choices: { codeFont: "fira-code" } } })!;
    expect(pinnedLookTokens(look)).toMatchObject({ background: "#101010", bodyFont: "literata", headingFont: "eb-garamond", codeFont: "fira-code" });
  });

  it("takes every face from the style when the tokens name none, as on a public link or an old pin", () => {
    const look = pinnedLookFrom({ tokens: TOKENS, style: { base: "editorial" } })!;
    expect(pinnedLookTokens(look)).toMatchObject({ bodyFont: "source-serif", headingFont: "playfair", codeFont: "fira-code" });
    expect(pinnedLookTokens(pinnedLookFrom({ tokens: TOKENS })!)).toEqual(TOKENS);
  });

  it("gives the type alone when the colours cannot be used", () => {
    const look = pinnedLookFrom({ tokens: { background: "url(x)", lineHeight: 1.9, bodyFont: "lora" }, style: { base: "minimal" } })!;
    expect(pinnedLookTokens(look)).toBeNull();
    expect(pinnedLookType(look)).toEqual({ lineHeight: 1.9, bodyFont: "lora", headingFont: "body", codeFont: "atkinson-mono" });
  });

  it("carries a hostile font id no further than a string for the theme to refuse", () => {
    const look = pinnedLookFrom({ tokens: { ...TOKENS, bodyFont: "x'; } body { display: none", codeFont: "y".repeat(500) }, style: { choices: { codeFont: "} body {" } } })!;
    expect(look.type.codeFont).toBeUndefined();
    expect(pinnedLookTokens(look)?.codeFont).toBeUndefined();
  });
});
