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
});
