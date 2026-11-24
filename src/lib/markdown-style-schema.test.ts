// What a stored Markdown style may hold, tested against input that means harm.
// A style comes from another account by way of a server, so nothing here may
// let a string through that was not picked from the lists.
// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MARKDOWN_STYLE_CHOICES,
  MARKDOWN_STYLE_LIMITS,
  MARKDOWN_STYLE_NUMBERS,
  MARKDOWN_STYLE_PRESET_IDS,
  cleanMarkdownStyleName,
  isMarkdownStyleProfileId,
  sanitizeMarkdownStyle,
  sanitizeMarkdownStyleStore,
} from "./markdown-style-schema";

const HOSTILE = [
  "} body { display: none } .x {",
  "red; background: url(https://evil.test/track.png)",
  "</style><script>alert(1)</script>",
  "expression(alert(1))",
  "@import url(//evil.test/x.css)",
  "var(--x, url(javascript:alert(1)))",
  "grid\u0000",
  "GRID",
  " grid",
  "",
];

describe("sanitizeMarkdownStyle", () => {
  it("answers null for anything that is not an object", () => {
    for (const raw of [null, undefined, 3, "spacious", true, [], [{ base: "compact" }]]) expect(sanitizeMarkdownStyle(raw)).toBeNull();
  });

  it("reads an empty object, and an unknown preset, as Spacious", () => {
    expect(sanitizeMarkdownStyle({})).toEqual({ base: "spacious" });
    for (const base of [...HOSTILE, "future-preset", 7, null, { toString: () => "compact" }]) {
      expect(sanitizeMarkdownStyle({ base })).toEqual({ base: "spacious" });
    }
  });

  it("keeps every listed option of every choice", () => {
    for (const [key, options] of Object.entries(MARKDOWN_STYLE_CHOICES)) {
      for (const option of options) expect(sanitizeMarkdownStyle({ choices: { [key]: option } })?.choices).toEqual({ [key]: option });
    }
  });

  it("drops a choice whose value is not one of its listed options", () => {
    for (const key of Object.keys(MARKDOWN_STYLE_CHOICES)) {
      for (const value of [...HOSTILE, 1, null, ["grid"], { id: "grid" }]) {
        expect(sanitizeMarkdownStyle({ base: "compact", choices: { [key]: value } })).toEqual({ base: "compact" });
      }
    }
  });

  it("drops an option that belongs to a different choice", () => {
    expect(sanitizeMarkdownStyle({ choices: { tableStyle: "disc", bulletStyle: "grid" } })).toEqual({ base: "spacious" });
  });

  it("drops choices and numbers it has no list for", () => {
    const style = sanitizeMarkdownStyle({
      choices: { customCss: "body{display:none}", __proto__: { polluted: "yes" }, constructor: "x", tableStyle: "grid" },
      numbers: { zIndex: 99999, toString: 1, blockGap: 1.2 },
      css: "body { display: none }",
      raw: "<style>",
    });
    expect(style).toEqual({ base: "spacious", choices: { tableStyle: "grid" }, numbers: { blockGap: 1.2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("moves a number out of range to the nearest end, and drops what is not a number", () => {
    for (const [key, { min, max }] of Object.entries(MARKDOWN_STYLE_NUMBERS)) {
      expect(sanitizeMarkdownStyle({ numbers: { [key]: 1e308 } })?.numbers).toEqual({ [key]: max });
      expect(sanitizeMarkdownStyle({ numbers: { [key]: -1e308 } })?.numbers).toEqual({ [key]: min });
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1.2", "1; color: red", null, [1], { valueOf: () => 1 }]) {
        expect(sanitizeMarkdownStyle({ numbers: { [key]: value } })).toEqual({ base: "spacious" });
      }
    }
  });

  it("rounds a number to three places, so no exponent can be printed", () => {
    expect(sanitizeMarkdownStyle({ numbers: { blockGap: 1.23456789, listItemGap: 1e-9 } })?.numbers).toEqual({ blockGap: 1.235, listItemGap: 0 });
  });

  it("reads an own property only, never an inherited one", () => {
    const inherited = Object.create({ base: "compact", choices: { tableStyle: "grid" } });
    expect(sanitizeMarkdownStyle(inherited)).toEqual({ base: "spacious" });
  });

  it("keeps a name as one short line of text", () => {
    expect(sanitizeMarkdownStyle({ name: "  My\nnotes \tstyle  " })?.name).toBe("My notes style");
    expect(sanitizeMarkdownStyle({ name: "x".repeat(500) })?.name).toHaveLength(MARKDOWN_STYLE_LIMITS.name);
    expect(sanitizeMarkdownStyle({ name: 42 })?.name).toBeUndefined();
    expect(cleanMarkdownStyleName("\n\n", "Untitled")).toBe("Untitled");
  });
});

describe("sanitizeMarkdownStyleStore", () => {
  it("answers null for anything that is not an object", () => {
    for (const raw of [null, undefined, "x", 1, []]) expect(sanitizeMarkdownStyleStore(raw)).toBeNull();
  });

  it("reads an empty store as Spacious with no profiles", () => {
    expect(sanitizeMarkdownStyleStore({})).toEqual({ activeId: "spacious", profiles: [] });
  });

  it("keeps good profiles and drops bad ones", () => {
    const store = sanitizeMarkdownStyleStore({
      activeId: "style-a",
      profiles: [
        { id: "style-a", name: "Mine", style: { base: "compact", choices: { tableStyle: "zebra", linkStyle: "javascript:alert(1)" } } },
        { id: "style-a", name: "A second one with the same id", style: { base: "classic" } },
        { id: "Bad Id!", name: "Bad id", style: { base: "classic" } },
        { id: "compact", name: "Shadows a preset", style: { base: "classic" } },
        { id: "style-b", name: "No style" },
        { id: "style-c", style: { base: "nonsense" } },
        "style-d",
        null,
      ],
      draft: { base: "editorial", numbers: { leading: 99 } },
      extra: "ignored",
    });
    expect(store).toEqual({
      activeId: "style-a",
      profiles: [
        { id: "style-a", name: "Mine", style: { base: "compact", name: "Mine", choices: { tableStyle: "zebra" } } },
        { id: "style-c", name: "Untitled style", style: { base: "spacious", name: "Untitled style" } },
      ],
      draft: { base: "editorial", numbers: { leading: MARKDOWN_STYLE_NUMBERS.leading.max } },
    });
  });

  it("reads an active id that names nothing as Spacious", () => {
    for (const activeId of ["gone", "} body {", 3, null]) expect(sanitizeMarkdownStyleStore({ activeId, profiles: [] })?.activeId).toBe("spacious");
    for (const preset of MARKDOWN_STYLE_PRESET_IDS) expect(sanitizeMarkdownStyleStore({ activeId: preset })?.activeId).toBe(preset);
  });

  it("cuts the list of profiles at the limit", () => {
    const profiles = Array.from({ length: 500 }, (_, index) => ({ id: `style-${index}`, name: `S${index}`, style: { base: "compact" } }));
    expect(sanitizeMarkdownStyleStore({ profiles })?.profiles).toHaveLength(MARKDOWN_STYLE_LIMITS.profiles);
  });

  it("knows a profile id from a preset id and from junk", () => {
    expect(isMarkdownStyleProfileId("style-abc")).toBe(true);
    for (const id of ["compact", "Style", "a b", "", "-x", "x".repeat(60), 4, null]) expect(isMarkdownStyleProfileId(id)).toBe(false);
  });
});

describe("the lists themselves", () => {
  it("hold only ids that could never be CSS", () => {
    const ids = [...MARKDOWN_STYLE_PRESET_IDS, ...Object.keys(MARKDOWN_STYLE_CHOICES), ...Object.values(MARKDOWN_STYLE_CHOICES).flat(), ...Object.keys(MARKDOWN_STYLE_NUMBERS)];
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9-]{0,31}$/);
  });

  it("keep Spacious first, and every number's default inside its range", () => {
    expect(MARKDOWN_STYLE_PRESET_IDS[0]).toBe("spacious");
    for (const { min, max, default: value } of Object.values(MARKDOWN_STYLE_NUMBERS)) {
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });
});

describe("the server's copy", () => {
  it("is this file, byte for byte, under its header", () => {
    const source = readFileSync(new URL("./markdown-style-schema.ts", import.meta.url), "utf8");
    const copy = readFileSync(new URL("../../server/src/generated/markdown-style-schema.ts", import.meta.url), "utf8");
    const header = copy.split("\n").slice(0, 2).join("\n") + "\n";
    expect(header).toContain("GENERATED from src/lib/markdown-style-schema.ts");
    // Out of date? Run: (cd server && npm run markdown-style:sync)
    expect(copy.slice(header.length)).toBe(source);
  });

  it("has no imports, so the server can run it as it is", () => {
    const source = readFileSync(new URL("./markdown-style-schema.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\benum\b|\bnamespace\b/);
  });
});
