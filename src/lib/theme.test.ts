import { describe, it, expect, beforeEach } from "vitest";
import {
  loadThemeStore,
  saveThemeStore,
  allThemes,
  findTheme,
  MARKIE_DARK,
  MARKIE_LIGHT,
} from "./theme";

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

function luminance(hex: string) {
  const [r, g, b] = hex
    .replace("#", "")
    .match(/.{2}/g)!
    .map((pair) => parseInt(pair, 16) / 255)
    .map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("theme store", () => {
  beforeEach(() => storage.clear());

  it("defaults to Markie Dark with no custom themes", () => {
    const store = loadThemeStore();
    expect(store.activeId).toBe(MARKIE_DARK.id);
    expect(store.custom).toEqual([]);
  });

  it("persists and reloads custom presets", () => {
    const custom = {
      id: "my-theme",
      name: "Mine",
      tokens: { ...MARKIE_LIGHT.tokens, link: "#ff0000" },
    };
    saveThemeStore({ activeId: "my-theme", custom: [custom] });
    const store = loadThemeStore();
    expect(store.activeId).toBe("my-theme");
    expect(findTheme(store, "my-theme").tokens.link).toBe("#ff0000");
  });

  it("includes built-ins plus custom in allThemes", () => {
    saveThemeStore({
      activeId: MARKIE_DARK.id,
      custom: [{ id: "x", name: "X", tokens: MARKIE_DARK.tokens }],
    });
    expect(allThemes(loadThemeStore()).map((t) => t.id)).toEqual([
      "markie-dark",
      "markie-light",
      "x",
    ]);
  });

  it("survives corrupted storage", () => {
    storage.set("markie.themes.v1", "{not json");
    expect(loadThemeStore().activeId).toBe(MARKIE_DARK.id);
  });

  it("falls back to dark for unknown ids", () => {
    expect(findTheme(loadThemeStore(), "nope").id).toBe(MARKIE_DARK.id);
  });

  it("keeps top chrome muted controls readable in built-in themes", () => {
    for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
      expect(contrast(theme.tokens.muted, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.muted, theme.tokens.surface2)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps side-panel status colors readable in built-in themes", () => {
    const statusKeys = [
      "statusGreen",
      "statusYellow",
      "statusRed",
      "statusBlue",
      "statusPurple",
    ] as const;

    for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
      for (const key of statusKeys) {
        expect(contrast(theme.tokens[key]!, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(theme.tokens[key]!, theme.tokens.surface2)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
