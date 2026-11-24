// Markdown styles: the presets, the stylesheet written from a style, and the
// transitions the editor makes on the account's store.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_MARKDOWN_STYLE_STORE,
  MARKDOWN_STYLE_APP_SCOPE,
  MARKDOWN_STYLE_CHOICES,
  MARKDOWN_STYLE_CHOICE_LABELS,
  MARKDOWN_STYLE_FONT_KEYS,
  markdownStyleFontCss,
  markdownStyleFontTokens,
  styleFontId,
  withPaintedFonts,
  MARKDOWN_STYLE_GROUPS,
  MARKDOWN_STYLE_NUMBERS,
  MARKDOWN_STYLE_NUMBER_LABELS,
  MARKDOWN_STYLE_PRESETS,
  activeMarkdownStyle,
  activeMarkdownStyleName,
  applyMarkdownStyle,
  canonicalMarkdownStyle,
  chooseMarkdownStyle,
  deleteMarkdownStyle,
  discardMarkdownStyleDraft,
  duplicateMarkdownStyle,
  editMarkdownStyle,
  markdownStyleContainerScope,
  markdownStyleCss,
  markdownStyleEdited,
  markdownStyleGroupChanged,
  markdownStyleStoreOf,
  newMarkdownStyleProfileId,
  paintedMarkdownStyle,
  pinnableMarkdownStyle,
  renameMarkdownStyle,
  resetMarkdownStyleGroup,
  resolveMarkdownStyle,
  sameMarkdownStyle,
  saveMarkdownStyleAs,
  saveMarkdownStyleEdits,
  type MarkdownStyleChoiceKey,
  type MarkdownStyleNumberKey,
} from "./markdown-style";
import { MARKDOWN_STYLE_PRESET_IDS } from "./markdown-style-schema";
import { MARKIE_DARK, TYPEFACES, chooseCustomPreset, chooseTemplate, findTemplate, findTheme, loadThemeStore, normalizeThemeStore, saveThemeStore, setTypography, typographyVars, type ThemeStore } from "./theme";
import { TYPEFACE_LIST, codeTypefaces } from "./fonts/registry";
import { saveCodeFont } from "./fonts/code-font";
import { applyMarkdownStyleChoice, commitMarkdownStyleStore, loadMarkdownStyleStore } from "./markdown-style-store";

afterEach(() => {
  applyMarkdownStyle(null);
  localStorage.clear();
});

const SCOPE = ".markdown-body";
const CHOICE_KEYS = Object.keys(MARKDOWN_STYLE_CHOICES) as MarkdownStyleChoiceKey[];
const NUMBER_KEYS = Object.keys(MARKDOWN_STYLE_NUMBERS) as MarkdownStyleNumberKey[];

/** Every rule of a stylesheet parses, and none of its text escaped a rule. */
function parsed(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}

describe("the presets", () => {
  it("are the six the schema names, Spacious first", () => {
    expect(MARKDOWN_STYLE_PRESETS.map((preset) => preset.id)).toEqual([...MARKDOWN_STYLE_PRESET_IDS]);
    expect(MARKDOWN_STYLE_PRESETS[0].id).toBe("spacious");
  });

  it("Spacious is every list's first option and every number's default", () => {
    const spacious = resolveMarkdownStyle({ base: "spacious" });
    for (const key of CHOICE_KEYS) expect(spacious.choices[key]).toBe(MARKDOWN_STYLE_CHOICES[key][0]);
    for (const key of NUMBER_KEYS) expect(spacious.numbers[key]).toBe(MARKDOWN_STYLE_NUMBERS[key].default);
  });

  it("each hold only listed options and numbers in range, and each differ from every other", () => {
    for (const preset of MARKDOWN_STYLE_PRESETS) {
      for (const [key, value] of Object.entries(preset.choices)) expect(MARKDOWN_STYLE_CHOICES[key as MarkdownStyleChoiceKey]).toContain(value);
      for (const [key, value] of Object.entries(preset.numbers)) {
        const { min, max } = MARKDOWN_STYLE_NUMBERS[key as MarkdownStyleNumberKey];
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThanOrEqual(max);
      }
      // A preset says only how it differs from Spacious.
      expect(canonicalMarkdownStyle({ base: preset.id })).toEqual({ base: preset.id });
    }
    const sheets = MARKDOWN_STYLE_PRESETS.map((preset) => markdownStyleCss({ base: preset.id }, SCOPE));
    expect(new Set(sheets).size).toBe(sheets.length);
  });

  it("have a label for every choice, option and number, and every one sits in exactly one group", () => {
    for (const key of CHOICE_KEYS) {
      expect(MARKDOWN_STYLE_CHOICE_LABELS[key].label).toBeTruthy();
      for (const option of MARKDOWN_STYLE_CHOICES[key]) expect((MARKDOWN_STYLE_CHOICE_LABELS[key].options as Record<string, string>)[option]).toBeTruthy();
    }
    for (const key of NUMBER_KEYS) expect(MARKDOWN_STYLE_NUMBER_LABELS[key].format(MARKDOWN_STYLE_NUMBERS[key].default)).toBeTruthy();
    expect(MARKDOWN_STYLE_GROUPS.flatMap((group) => group.choices).sort()).toEqual([...CHOICE_KEYS].sort());
    expect(MARKDOWN_STYLE_GROUPS.flatMap((group) => group.numbers).sort()).toEqual([...NUMBER_KEYS].sort());
  });
});

describe("markdownStyleCss", () => {
  it("writes nothing at all for Spacious, however it is spelled", () => {
    for (const style of [null, undefined, {}, { base: "spacious" }, "spacious", { base: "nonsense" }, { base: "spacious", choices: { tableStyle: "lines" }, numbers: { blockGap: 1 } }]) {
      expect(markdownStyleCss(style, SCOPE)).toBe("");
      expect(markdownStyleCss(style)).toBe("");
    }
  });

  it("writes rules for every other preset, each one scoped", () => {
    for (const preset of MARKDOWN_STYLE_PRESETS.slice(1)) {
      const css = markdownStyleCss({ base: preset.id });
      expect(css.length).toBeGreaterThan(0);
      const sheet = parsed(css);
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule) for (const selector of rule.selectorText.split(/,(?![^(]*\))/)) expect(selector.trim().startsWith(MARKDOWN_STYLE_APP_SCOPE)).toBe(true);
      }
    }
  });

  it("writes a rule for every option that is not Spacious's, and nothing for the one that is", () => {
    for (const key of CHOICE_KEYS) {
      const [first, ...others] = MARKDOWN_STYLE_CHOICES[key];
      expect(markdownStyleCss({ choices: { [key]: first } }, SCOPE)).toBe("");
      // A typeface is painted as a theme token, never as a rule here.
      if ((MARKDOWN_STYLE_FONT_KEYS as readonly string[]).includes(key)) {
        for (const option of others) expect(markdownStyleCss({ choices: { [key]: option } }, SCOPE)).toBe("");
        continue;
      }
      for (const option of others) {
        const css = markdownStyleCss({ choices: { [key]: option } }, SCOPE);
        expect(css, `${key}:${option}`).not.toBe("");
        expect(css).not.toContain("&");
        expect(css).not.toMatch(/<|undefined|NaN|\[object/);
        // Colours come from the theme, never from here.
        expect(css.replace(/rgba\(0, 0, 0, 0\.18\)/g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
        expect(parsed(css).cssRules.length).toBeGreaterThan(0);
      }
    }
  });

  it("writes a rule for every number away from its default, at both ends of its range", () => {
    for (const key of NUMBER_KEYS) {
      const { min, max, default: standard } = MARKDOWN_STYLE_NUMBERS[key];
      expect(markdownStyleCss({ numbers: { [key]: standard } }, SCOPE)).toBe("");
      for (const value of [min, max]) {
        if (value === standard) continue;
        const css = markdownStyleCss({ numbers: { [key]: value } }, SCOPE);
        expect(css, `${key}:${value}`).not.toBe("");
        expect(css).not.toMatch(/NaN|Infinity|e[+-]\d/);
      }
    }
  });

  it("never lets anything a style holds reach the stylesheet as text", () => {
    const attack = "} html { display: none } .x { color: red; background: url(https://evil.test/x)";
    const hostile = {
      base: attack,
      name: `</style><script>alert(1)</script>${attack}`,
      choices: Object.fromEntries(CHOICE_KEYS.map((key) => [key, attack])),
      numbers: Object.fromEntries(NUMBER_KEYS.map((key) => [key, attack])),
      css: attack,
    };
    expect(markdownStyleCss(hostile, SCOPE)).toBe("");
    // Mixed with real choices, only the real ones are drawn.
    const mixed = markdownStyleCss({ ...hostile, base: "compact", choices: { ...hostile.choices, tableStyle: "grid" }, numbers: { ...hostile.numbers, imageRadius: 1e12 } }, SCOPE);
    expect(mixed).not.toContain("evil");
    expect(mixed).not.toContain("display: none");
    expect(mixed).not.toContain("script");
    expect(mixed).toContain("border-radius: 24px");
    expect(mixed).toContain("border: 1px solid var(--doc-rule)");
  });

  it("refuses a scope key that could carry a selector of its own", () => {
    expect(markdownStyleContainerScope("s1")).toBe('[data-md-style="s1"] .markdown-body');
    for (const key of ['x"] , body [y="', "", "A", "a b", "x".repeat(80)]) expect(() => markdownStyleContainerScope(key)).toThrow();
  });

  it("keeps a container's document out of the app's own rules", () => {
    document.body.innerHTML = '<div class="markdown-body" id="app"><h1>a</h1></div><div data-md-style="s1"><div class="markdown-body" id="scoped"><h1>b</h1></div></div>';
    expect(document.querySelector("#app")!.matches(MARKDOWN_STYLE_APP_SCOPE)).toBe(true);
    expect(document.querySelector("#scoped")!.matches(MARKDOWN_STYLE_APP_SCOPE)).toBe(false);
    expect(document.querySelector("#scoped")!.matches(markdownStyleContainerScope("s1"))).toBe(true);
    expect(document.querySelector("#app")!.matches(markdownStyleContainerScope("s1"))).toBe(false);
    document.body.innerHTML = "";
  });

  it("declares the counter style only when numbered lists use it", () => {
    expect(markdownStyleCss({ choices: { orderedStyle: "paren" } }, SCOPE)).toContain("@counter-style markie-paren");
    expect(markdownStyleCss({ choices: { orderedStyle: "roman" } }, SCOPE)).not.toContain("@counter-style");
  });

  it("leaves task lists out of bullet markers and list indent", () => {
    const css = markdownStyleCss({ choices: { bulletStyle: "dash" }, numbers: { listIndent: 1.2 } }, SCOPE);
    expect(css).toContain('ul:not([data-type="taskList"]) > li:not(.task-list-item)');
    expect(css).toContain('ul:not([data-type="taskList"]), .markdown-body ol { padding-left: 1.2em; }');
  });
});

describe("a style's typefaces", () => {
  it("are the registry's own faces, so the lists the server checks against cannot drift", () => {
    const ids = TYPEFACE_LIST.filter((face) => !face.localOnly).map((face) => face.id);
    // theme.ts hands out the very same list.
    expect(TYPEFACES).toBe(TYPEFACE_LIST);
    expect(MARKDOWN_STYLE_CHOICES.bodyFont).toEqual(["theme", ...ids]);
    expect(MARKDOWN_STYLE_CHOICES.headingFont).toEqual(["theme", "body", ...ids]);
    expect(MARKDOWN_STYLE_CHOICES.codeFont).toEqual(["theme", ...codeTypefaces().filter((face) => !face.localOnly).map((face) => face.id)]);
  });

  it("are nothing for Spacious, and a pairing of bundled faces for every other preset, each its own", () => {
    expect(markdownStyleFontTokens({ base: "spacious" })).toEqual({});
    expect(markdownStyleFontTokens(null)).toEqual({});
    const pairings = MARKDOWN_STYLE_PRESETS.slice(1).map((preset) => markdownStyleFontTokens({ base: preset.id }));
    for (const fonts of pairings) {
      for (const id of [fonts.bodyFont, fonts.codeFont]) expect(TYPEFACE_LIST.find((face) => face.id === id)?.bundled, id).toBe(true);
      expect(fonts.headingFont === "body" || TYPEFACE_LIST.find((face) => face.id === fonts.headingFont)?.bundled).toBe(true);
    }
    expect(new Set(pairings.map((fonts) => fonts.bodyFont)).size).toBe(pairings.length);
  });

  it("stand in for the template's faces, and give way to a face the person chose", () => {
    const paper = findTemplate("paper")!.light;
    const store: ThemeStore = normalizeThemeStore({ activeId: paper.id, custom: [], templateId: "paper", markdownStyle: { activeId: "technical", profiles: [] } });
    expect(findTheme(store, paper.id).tokens).toMatchObject({ bodyFont: "plex-sans", headingFont: "body", codeFont: "jetbrains-mono", background: paper.tokens.background });
    // Their own typography choice is on top of the style's.
    const own = setTypography(store, { bodyFont: "lora" });
    expect(findTheme(own, paper.id).tokens).toMatchObject({ bodyFont: "lora", headingFont: "body" });
    // And so is their own code font.
    saveCodeFont("fira-code");
    expect(findTheme(store, paper.id).tokens.codeFont).toBe("fira-code");
    saveCodeFont("");
    // A heading that follows the text paints no heading face of its own.
    expect(typographyVars(findTheme(store, paper.id).tokens)["--doc-heading-family"]).toBe("");
  });

  it("leave the template's preset exactly as it was under Spacious", () => {
    const store: ThemeStore = normalizeThemeStore({ activeId: MARKIE_DARK.id, custom: [] });
    expect(findTheme(store, MARKIE_DARK.id)).toBe(MARKIE_DARK);
    const paper = findTemplate("paper")!.dark;
    expect(findTheme(normalizeThemeStore({ activeId: paper.id, custom: [], templateId: "paper" }), paper.id)).toBe(paper);
  });

  it("store a font from one computer as the bundled face it names, and nothing for junk", () => {
    expect(styleFontId("bodyFont", "literata")).toBe("literata");
    expect(styleFontId("bodyFont", "local:source-serif:Hoefler Text")).toBe("source-serif");
    expect(styleFontId("codeFont", "local:jetbrains-mono:Monaco")).toBe("jetbrains-mono");
    // A text face is not a code face.
    expect(styleFontId("codeFont", "literata")).toBeUndefined();
    for (const id of ["theme", "local:nope:Futura", "x'; } body { display: none", "", 4, null]) expect(styleFontId("bodyFont", id)).toBeUndefined();
  });

  it("are written into a pinned style as they are painted", () => {
    // The style's own faces, unchanged, add nothing to it.
    expect(withPaintedFonts({ base: "technical" }, { bodyFont: "plex-sans", headingFont: "body", codeFont: "jetbrains-mono" })).toEqual({ base: "technical" });
    // The person's own choices are what a reader should get.
    expect(withPaintedFonts({ base: "technical", choices: { tableStyle: "zebra" } }, { bodyFont: "local:source-serif:Hoefler Text", headingFont: "fraunces", codeFont: "fira-code" })).toEqual({
      base: "technical",
      choices: { tableStyle: "zebra", bodyFont: "source-serif", headingFont: "fraunces", codeFont: "fira-code" },
    });
    // Under Spacious with a template's faces, the style names them.
    expect(withPaintedFonts({ base: "spacious" }, { bodyFont: "charter", headingFont: "iowan" })).toEqual({ base: "spacious", choices: { bodyFont: "charter", headingFont: "iowan" } });
    expect(withPaintedFonts({ base: "spacious" }, {})).toEqual({ base: "spacious" });
  });

  it("are set on a container for a preview, as stacks from the registry and nothing else", () => {
    const scope = markdownStyleContainerScope("s1");
    expect(markdownStyleFontCss({ base: "spacious" }, scope)).toBe("");
    const css = markdownStyleFontCss({ base: "editorial" }, scope);
    expect(css).toContain("'Source Serif 4', Georgia");
    expect(css).toContain(":is(h1, h2, h3, h4, h5, h6) { font-family: 'Playfair Display'");
    expect(css).toContain(":is(code, pre, kbd, samp) { font-family: 'Fira Code'");
    for (const line of css.split("\n")) expect(line.startsWith(scope)).toBe(true);
    expect(parsed(css).cssRules).toHaveLength(3);
    const hostile = markdownStyleFontCss({ choices: { bodyFont: "x'; } body { display: none", headingFont: "local:inter:Evil", codeFont: "literata" } }, scope);
    expect(hostile).toBe("");
  });
});

describe("applyMarkdownStyle", () => {
  it("adds one stylesheet for a style and removes it again for Spacious", () => {
    applyMarkdownStyle({ base: "compact" });
    const sheets = document.querySelectorAll("style#markie-markdown-style");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].textContent).toBe(markdownStyleCss({ base: "compact" }));
    applyMarkdownStyle({ base: "editorial" });
    expect(document.querySelectorAll("style#markie-markdown-style")).toHaveLength(1);
    expect(paintedMarkdownStyle()).toEqual({ base: "editorial" });
    applyMarkdownStyle({ base: "spacious" });
    // Spacious leaves the page exactly as it is without this feature.
    expect(document.querySelector("style#markie-markdown-style")).toBeNull();
    expect(paintedMarkdownStyle()).toEqual({ base: "spacious" });
  });
});

describe("the account's style store", () => {
  const empty = EMPTY_MARKDOWN_STYLE_STORE;

  it("starts on Spacious", () => {
    expect(markdownStyleStoreOf(null)).toEqual(empty);
    expect(markdownStyleStoreOf({})).toEqual(empty);
    expect(activeMarkdownStyle(empty)).toEqual({ base: "spacious", name: "Spacious" });
    expect(markdownStyleEdited(empty)).toBe(false);
  });

  it("turns a changed preset into an unsaved edit named for it", () => {
    const edited = editMarkdownStyle(empty, { choices: { tableStyle: "zebra" } });
    expect(markdownStyleEdited(edited)).toBe(true);
    expect(activeMarkdownStyleName(edited)).toBe("Spacious (edited)");
    expect(resolveMarkdownStyle(activeMarkdownStyle(edited)).choices.tableStyle).toBe("zebra");
    // Changing it back is no edit at all.
    const back = editMarkdownStyle(edited, { choices: { tableStyle: "lines" } });
    expect(markdownStyleEdited(back)).toBe(false);
    expect(back.draft).toBeUndefined();
    expect(activeMarkdownStyleName(back)).toBe("Spacious");
  });

  it("edits on top of another preset keep that preset's other choices", () => {
    const edited = editMarkdownStyle(chooseMarkdownStyle(empty, "compact"), { numbers: { imageRadius: 16 } });
    const resolved = resolveMarkdownStyle(activeMarkdownStyle(edited));
    expect(resolved.base).toBe("compact");
    expect(resolved.choices.headingScale).toBe("compact");
    expect(resolved.numbers.imageRadius).toBe(16);
    expect(activeMarkdownStyleName(edited)).toBe("Compact (edited)");
  });

  it("resets one element to its preset and leaves the others", () => {
    const tables = MARKDOWN_STYLE_GROUPS.find((group) => group.id === "tables")!;
    const headings = MARKDOWN_STYLE_GROUPS.find((group) => group.id === "headings")!;
    let store = editMarkdownStyle(chooseMarkdownStyle(empty, "technical"), { choices: { tableStyle: "zebra", headingRule: "none" }, numbers: { headingSpaceAbove: 1.8 } });
    expect(markdownStyleGroupChanged(activeMarkdownStyle(store), tables)).toBe(true);
    store = resetMarkdownStyleGroup(store, tables);
    const resolved = resolveMarkdownStyle(activeMarkdownStyle(store));
    // Technical's own tables are a grid, not Spacious's lines.
    expect(resolved.choices.tableStyle).toBe("grid");
    expect(resolved.choices.headingRule).toBe("none");
    expect(markdownStyleGroupChanged(activeMarkdownStyle(store), tables)).toBe(false);
    store = resetMarkdownStyleGroup(store, headings);
    expect(markdownStyleEdited(store)).toBe(false);
  });

  it("saves an edit as a named profile, which becomes the style in use", () => {
    const edited = editMarkdownStyle(chooseMarkdownStyle(empty, "classic"), { choices: { dividerStyle: "dotted" } });
    const saved = saveMarkdownStyleAs(edited, "  Essay  ", "style-a");
    expect(saved).toEqual({ activeId: "style-a", profiles: [{ id: "style-a", name: "Essay", style: { base: "classic", name: "Essay", choices: { dividerStyle: "dotted" } } }] });
    expect(markdownStyleEdited(saved)).toBe(false);
    expect(activeMarkdownStyleName(saved)).toBe("Essay");
    expect(pinnableMarkdownStyle(saved)).toEqual({ base: "classic", name: "Essay", choices: { dividerStyle: "dotted" } });
  });

  it("will not save under a preset's id, a taken id or a bad one, and never reuses a name", () => {
    const saved = saveMarkdownStyleAs(empty, "Compact", "style-a");
    expect(saved.profiles[0].name).toBe("Compact 2");
    for (const id of ["compact", "style-a", "Bad Id", ""]) expect(saveMarkdownStyleAs(saved, "x", id)).toBe(saved);
    expect(saveMarkdownStyleAs(saved, "compact 2", "style-b").profiles[1].name).toBe("compact 2 2");
  });

  it("writes later edits into the profile, and a preset is never overwritten", () => {
    const saved = saveMarkdownStyleAs(empty, "Mine", "style-a");
    const edited = editMarkdownStyle(saved, { choices: { linkStyle: "dotted" } });
    expect(activeMarkdownStyleName(edited)).toBe("Mine (edited)");
    const written = saveMarkdownStyleEdits(edited);
    expect(written.profiles[0].style).toEqual({ base: "spacious", name: "Mine", choices: { linkStyle: "dotted" } });
    expect(markdownStyleEdited(written)).toBe(false);
    const presetEdit = editMarkdownStyle(empty, { choices: { linkStyle: "dotted" } });
    expect(saveMarkdownStyleEdits(presetEdit)).toBe(presetEdit);
    expect(discardMarkdownStyleDraft(edited)).toEqual(saved);
  });

  it("duplicates, renames and deletes", () => {
    let store = saveMarkdownStyleAs(editMarkdownStyle(chooseMarkdownStyle(empty, "minimal"), { choices: { tableStyle: "grid" } }), "Notes", "style-a");
    store = duplicateMarkdownStyle(store, "style-a", "style-b");
    store = duplicateMarkdownStyle(store, "editorial", "style-c");
    expect(store.profiles.map((profile) => profile.name)).toEqual(["Notes", "Notes copy", "Editorial copy"]);
    expect(store.activeId).toBe("style-a");
    expect(sameMarkdownStyle(store.profiles[1].style, store.profiles[0].style)).toBe(true);
    expect(sameMarkdownStyle(store.profiles[2].style, { base: "editorial" })).toBe(true);
    expect(duplicateMarkdownStyle(store, "nothing", "style-d")).toBe(store);

    store = renameMarkdownStyle(store, "style-b", "Notes");
    expect(store.profiles[1].name).toBe("Notes 2");
    store = renameMarkdownStyle(store, "style-b", "Field notes");
    expect(store.profiles[1]).toMatchObject({ name: "Field notes", style: { name: "Field notes" } });
    expect(renameMarkdownStyle(store, "compact", "x")).toBe(store);

    store = deleteMarkdownStyle(store, "style-c");
    expect(store.activeId).toBe("style-a");
    // Deleting the style in use falls back to the preset it was built on.
    store = deleteMarkdownStyle(store, "style-a");
    expect(store.activeId).toBe("minimal");
    expect(store.profiles.map((profile) => profile.id)).toEqual(["style-b"]);
  });

  it("makes ids that are free and well formed", () => {
    const id = newMarkdownStyleProfileId([], 1000);
    expect(id).toMatch(/^style-[a-z0-9]+$/);
    expect(newMarkdownStyleProfileId([id], 1000)).toBe(`${id}-2`);
  });

  it("ignores a choice of a style that does not exist", () => {
    expect(chooseMarkdownStyle(empty, "gone")).toBe(empty);
  });
});

describe("inside the theme store", () => {
  it("a store written before styles existed loads, and reads as Spacious", () => {
    const old = { activeId: MARKIE_DARK.id, custom: [], templateId: "markie", overrides: {} } as ThemeStore;
    const store = normalizeThemeStore(old);
    expect("markdownStyle" in store).toBe(false);
    expect(activeMarkdownStyle(markdownStyleStoreOf(store))).toEqual({ base: "spacious", name: "Spacious" });
    // And the oldest shape of all: no template fields either.
    expect(markdownStyleStoreOf(normalizeThemeStore({ activeId: "markie-dark", custom: [] }))).toEqual(EMPTY_MARKDOWN_STYLE_STORE);
  });

  it("is cleaned every time the theme store is read", () => {
    saveThemeStore({
      activeId: MARKIE_DARK.id,
      custom: [],
      markdownStyle: { activeId: "style-a", profiles: [{ id: "style-a", name: "x", style: { base: "compact", choices: { tableStyle: "} body {" } } }], draft: "nope" },
    } as unknown as ThemeStore);
    expect(loadThemeStore().markdownStyle).toEqual({ activeId: "style-a", profiles: [{ id: "style-a", name: "x", style: { base: "compact", name: "x" } }] });
    saveThemeStore({ activeId: MARKIE_DARK.id, custom: [], markdownStyle: "garbage" } as unknown as ThemeStore);
    expect("markdownStyle" in loadThemeStore()).toBe(false);
  });

  it("survives a change of template and of custom preset", () => {
    const markdownStyle = saveMarkdownStyleAs(EMPTY_MARKDOWN_STYLE_STORE, "Mine", "style-a");
    const store = normalizeThemeStore({ activeId: MARKIE_DARK.id, custom: [{ id: "custom-1", name: "C", tokens: MARKIE_DARK.tokens }], markdownStyle });
    expect(chooseTemplate(store, "paper", "light").markdownStyle).toEqual(markdownStyle);
    expect(chooseCustomPreset(store, "custom-1").markdownStyle).toEqual(markdownStyle);
  });

  it("commits, paints and reloads through storage", () => {
    applyMarkdownStyleChoice("technical");
    expect(loadMarkdownStyleStore().activeId).toBe("technical");
    expect(document.querySelector("style#markie-markdown-style")?.textContent).toBe(markdownStyleCss({ base: "technical" }));
    const edited = commitMarkdownStyleStore(editMarkdownStyle(loadMarkdownStyleStore(), { choices: { tableStyle: "zebra" } }));
    expect(activeMarkdownStyleName(edited)).toBe("Technical (edited)");
    expect(activeMarkdownStyleName(loadMarkdownStyleStore())).toBe("Technical (edited)");
    // The rest of the theme store is left as it was.
    expect(loadThemeStore().activeId).toBe(MARKIE_DARK.id);
    applyMarkdownStyleChoice("spacious");
    expect(document.querySelector("style#markie-markdown-style")).toBeNull();
  });
});
