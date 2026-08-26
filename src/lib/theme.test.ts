import { describe, it, expect, beforeEach } from "vitest";
import {
  loadThemeStore,
  saveThemeStore,
  allThemes,
  findTheme,
  applyTheme,
  editorThemeForTokens,
  MARKIE_DARK,
  MARKIE_LIGHT,
} from "./theme";

const storage = new Map<string, string>();
const styles = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};
(globalThis as Record<string, unknown>).document = {
  documentElement: {
    style: {
      setProperty: (name: string, value: string) => void styles.set(name, value),
    },
  },
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
  beforeEach(() => {
    storage.clear();
    styles.clear();
  });

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

  it("keeps document content colors readable in built-in themes", () => {
    for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
      expect(contrast(theme.tokens.foreground, theme.tokens.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.foreground, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.foreground, theme.tokens.surface2)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.muted, theme.tokens.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.muted, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.link, theme.tokens.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.link, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.statusYellow!, theme.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.tokens.background, theme.tokens.link)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("applies every app and document CSS variable", () => {
    applyTheme(MARKIE_LIGHT.tokens);

    expect(styles.get("--background")).toBe(MARKIE_LIGHT.tokens.background);
    expect(styles.get("--surface")).toBe(MARKIE_LIGHT.tokens.surface);
    expect(styles.get("--surface-2")).toBe(MARKIE_LIGHT.tokens.surface2);
    expect(styles.get("--foreground")).toBe(MARKIE_LIGHT.tokens.foreground);
    expect(styles.get("--muted")).toBe(MARKIE_LIGHT.tokens.muted);
    expect(styles.get("--border")).toBe(MARKIE_LIGHT.tokens.border);
    expect(styles.get("--accent")).toBe(MARKIE_LIGHT.tokens.accent);
    expect(styles.get("--blue")).toBe(MARKIE_LIGHT.tokens.link);
    expect(styles.get("--status-green")).toBe(MARKIE_LIGHT.tokens.statusGreen);
    expect(styles.get("--status-yellow")).toBe(MARKIE_LIGHT.tokens.statusYellow);
    expect(styles.get("--status-red")).toBe(MARKIE_LIGHT.tokens.statusRed);
    expect(styles.get("--status-blue")).toBe(MARKIE_LIGHT.tokens.statusBlue);
    expect(styles.get("--status-purple")).toBe(MARKIE_LIGHT.tokens.statusPurple);
    expect(styles.get("--doc-font-size")).toBe("16px");
    expect(styles.get("--doc-width")).toBe("768px");
  });

  it("chooses a readable source-editor theme from theme background tone", () => {
    expect(editorThemeForTokens(MARKIE_DARK.tokens)).toBe("dark");
    expect(editorThemeForTokens(MARKIE_LIGHT.tokens)).toBe("light");
    expect(editorThemeForTokens({ background: "#fff" })).toBe("light");
    expect(editorThemeForTokens({ background: "not-a-color" })).toBe("dark");
  });

  // WCAG 1.4.11: a boundary that identifies a component needs 3:1. The dark
  // border used to draw at 1.19:1 against the surface behind it, which meant
  // every card in the Projects view had no visible edge at all. This pins the
  // ratio so it cannot quietly slip back.
  describe("the border token stays a visible edge", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [0, 2, 4]
        .map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    it("clears 3:1 against every surface either built-in theme paints", () => {
      // Light used to be exempt from this and drew its card edge at 1.38:1,
      // which is not an edge either. Both themes are held to the same bar.
      for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
        const t = theme.tokens;
        for (const behind of [t.background, t.surface, t.surface2]) {
          expect(ratio(t.border, behind)).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it("measures what it claims to measure", () => {
      // A control on the control: these are the published ratios for black on
      // white and for a colour against itself.
      expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 1);
      expect(ratio("#71717a", "#71717a")).toBeCloseTo(1, 5);
    });
  });
});
