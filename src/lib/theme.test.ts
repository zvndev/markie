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

  // This block used to enforce WCAG 1.4.11 (3:1 for a boundary identifying a
  // component) on the border token. That bar was met during 0.5.0 by raising
  // both themes' borders, and the result was rejected by the person who has to
  // look at it: the app read as a grid of drawn boxes instead of as a reader.
  //
  // The bar is not gone, it is reassigned. What must stay legible is the
  // SEPARATION between surfaces, which the background ramp and the shadows
  // carry, and the token itself goes back to a hint. So these tests now pin the
  // restored values, so a future "accessibility fix" cannot silently reapply a
  // change that was already made and already reverted, and pin document rules
  // to never exceed chrome, so raising one cannot drag the other along.
  describe("the border token stays quiet, on purpose", () => {
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

    it("holds both themes at the hairline the owner chose", () => {
      // Pinned by value, not by ratio, because the decision is a specific look
      // rather than a threshold. Changing either of these is a product call and
      // should have to edit this line to make it.
      expect(MARKIE_DARK.tokens.border).toBe("#27272a");
      expect(MARKIE_LIGHT.tokens.border).toBe("#c7d0dc");
    });

    it("keeps the separation the border is no longer carrying", () => {
      // The reason a quiet border is safe: surfaces are told apart by their
      // backgrounds, so a card is visible whether or not its edge is. If this
      // ramp ever flattens, the quiet border stops being a preference and
      // starts being a bug.
      for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
        const t = theme.tokens;
        expect(ratio(t.surface, t.background)).toBeGreaterThan(1.05);
        expect(ratio(t.surface2, t.background)).toBeGreaterThan(1.05);
      }
    });

    // The other half of the same lesson. Raising `border` to fix card edges also
    // raised every heading underline, table rule and code edge inside rendered
    // documents, because they shared the token. The app chrome got legible and
    // the reading experience got shouty, which is a bad trade in a reader.
    // These two are now separate tokens and must stay separate: chrome is an
    // object edge and has to be seen, a document rule is typography and has to
    // recede.
    it("never lets a document rule be louder than a chrome border", () => {
      // The two tokens hold the same value today, because chrome came back down
      // to where documents already were. The invariant is what matters: if the
      // border is ever raised again for card edges, documents must not follow,
      // which is the whole reason this token was split out.
      for (const theme of [MARKIE_DARK, MARKIE_LIGHT]) {
        const t = theme.tokens;
        expect(t.docRule).toBeDefined();
        for (const behind of [t.background, t.surface]) {
          expect(ratio(t.docRule!, behind)).toBeLessThanOrEqual(ratio(t.border, behind));
          // and stays typography, not a second edge
          expect(ratio(t.docRule!, behind)).toBeLessThan(2);
        }
      }
    });

    it("gives a theme saved before docRule existed a derived hairline", () => {
      // Custom themes predate this token. Falling back to `border` would give
      // them the exact problem this split exists to fix, so applyTheme derives
      // one from the theme's own palette instead.
      const styles = new Map<string, string>();
      const root = { style: { setProperty: (k: string, v: string) => styles.set(k, v) } };
      const doc = globalThis.document;
      Object.defineProperty(globalThis, "document", {
        value: { documentElement: root },
        configurable: true,
      });
      try {
        // A theme object saved before docRule existed: same palette, that key absent.
        const legacy = { ...MARKIE_DARK.tokens };
        delete (legacy as { docRule?: string }).docRule;
        applyTheme(legacy as typeof MARKIE_DARK.tokens);
        const derived = styles.get("--doc-rule");
        expect(derived).toBeDefined();
        expect(derived).not.toBe(MARKIE_DARK.tokens.border);
        expect(derived).toContain("color-mix");
      } finally {
        Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
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
