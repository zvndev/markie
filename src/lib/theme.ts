export interface ThemeTokens {
  background: string;
  surface: string;
  surface2: string;
  foreground: string;
  muted: string;
  border: string;
  /**
   * Rules drawn inside a rendered document: heading underlines, horizontal
   * rules, table borders, code edges. Deliberately far quieter than `border`.
   * A card edge is an object boundary you can act on and has to be seen; a
   * heading underline is typography and its job is to be almost subliminal.
   * They shared a token until 0.5.0, which meant making cards legible also
   * made every document shout. Optional: a theme without it gets a value
   * derived from its own border, so custom themes need no migration.
   */
  docRule?: string;
  accent: string;
  link: string;
  statusGreen?: string;
  statusYellow?: string;
  statusRed?: string;
  statusBlue?: string;
  statusPurple?: string;
  fontSize: number; // base px for the document body
  contentWidth: number; // max width px for the reading column
}

export interface ThemePreset {
  id: string;
  name: string;
  builtIn?: boolean;
  tokens: ThemeTokens;
}

export const THEME_APPLIED_EVENT = "markie:theme-applied";

export const MARKIE_DARK: ThemePreset = {
  id: "markie-dark",
  name: "Markie Dark",
  builtIn: true,
  tokens: {
    background: "#09090b",
    surface: "#18181b",
    surface2: "#1c1c20",
    foreground: "#fafafa",
    muted: "#a1a1aa",
    // Deliberately quiet, and deliberately below the 3:1 that WCAG 1.4.11 asks
    // of a boundary identifying a component. It was raised to #71717a during
    // 0.5.0 for exactly that reason, and the result was rejected on sight: an
    // app made of visible boxes rather than of documents. Markie is a reader,
    // its edges are meant to be felt rather than seen, and the owner's call is
    // that the calm is worth more than the ratio. Cards are separated by
    // background steps (background / surface / surface-2) and by shadow, so
    // this hairline is a hint and not the only thing carrying structure.
    // If it is ever raised again, raise it alone: docRule below is what keeps
    // rendered documents out of the blast radius.
    border: "#27272a",
    docRule: "#27272a",
    accent: "#3f3f46",
    link: "#60a5fa",
    statusGreen: "#4ade80",
    statusYellow: "#fde047",
    statusRed: "#f87171",
    statusBlue: "#60a5fa",
    statusPurple: "#d8b4fe",
    fontSize: 16,
    contentWidth: 768,
  },
};

export const MARKIE_LIGHT: ThemePreset = {
  id: "markie-light",
  name: "Markie Light",
  builtIn: true,
  tokens: {
    background: "#f8fafc",
    surface: "#eef2f6",
    surface2: "#e3e8ef",
    foreground: "#18181b",
    muted: "#475569",
    // The light half of the same decision recorded on the dark border above:
    // raised to #7a818b during 0.5.0, rejected, and restored. Same reasoning,
    // and the light theme feels it more, because a dark hairline on a pale
    // page reads as a drawn box in a way a light one on a dark page does not.
    border: "#c7d0dc",
    docRule: "#c7d0dc",
    accent: "#dbeafe",
    link: "#1d4ed8",
    statusGreen: "#166534",
    statusYellow: "#92400e",
    statusRed: "#991b1b",
    statusBlue: "#1d4ed8",
    statusPurple: "#6b21a8",
    fontSize: 16,
    contentWidth: 768,
  },
};

export const BUILT_IN_THEMES: ThemePreset[] = [MARKIE_DARK, MARKIE_LIGHT];

const STORE_KEY = "markie.themes.v1";

interface ThemeStore {
  activeId: string;
  custom: ThemePreset[];
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadThemeStore(): ThemeStore {
  const raw = getStorage()?.getItem(STORE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ThemeStore;
      if (parsed && typeof parsed.activeId === "string") {
        return { activeId: parsed.activeId, custom: parsed.custom ?? [] };
      }
    } catch {
      // fall through to default
    }
  }
  return { activeId: MARKIE_DARK.id, custom: [] };
}

export function saveThemeStore(store: ThemeStore): void {
  getStorage()?.setItem(STORE_KEY, JSON.stringify(store));
}

export function allThemes(store: ThemeStore): ThemePreset[] {
  return [...BUILT_IN_THEMES, ...store.custom];
}

export function findTheme(store: ThemeStore, id: string): ThemePreset {
  return allThemes(store).find((t) => t.id === id) ?? MARKIE_DARK;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, "");
  const value =
    raw.length === 3
      ? raw
          .split("")
          .map((char) => char + char)
          .join("")
      : raw;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb
    .map((channel) => channel / 255)
    .map((value) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function editorThemeForTokens(
  tokens: Pick<ThemeTokens, "background">
): "light" | "dark" {
  const tone = luminance(tokens.background);
  return tone !== null && tone > 0.45 ? "light" : "dark";
}

export function applyTheme(tokens: ThemeTokens): void {
  if (typeof document === "undefined") return;
  const r = document.documentElement.style;
  r.setProperty("--background", tokens.background);
  r.setProperty("--surface", tokens.surface);
  r.setProperty("--surface-2", tokens.surface2);
  r.setProperty("--foreground", tokens.foreground);
  r.setProperty("--muted", tokens.muted);
  r.setProperty("--border", tokens.border);
  // A custom theme saved before 0.5.0 has no docRule. Rather than dropping such
  // a document back to the loud shared border, soften that theme's own border
  // toward its surface, which keeps the hairline in the theme's palette.
  r.setProperty(
    "--doc-rule",
    tokens.docRule ??
      `color-mix(in srgb, ${tokens.border} 42%, ${tokens.surface})`
  );
  r.setProperty("--accent", tokens.accent);
  r.setProperty("--blue", tokens.link);
  r.setProperty("--status-green", tokens.statusGreen ?? tokens.foreground);
  r.setProperty("--status-yellow", tokens.statusYellow ?? tokens.foreground);
  r.setProperty("--status-red", tokens.statusRed ?? tokens.foreground);
  r.setProperty("--status-blue", tokens.statusBlue ?? tokens.link);
  r.setProperty("--status-purple", tokens.statusPurple ?? tokens.foreground);
  r.setProperty("--doc-font-size", `${tokens.fontSize}px`);
  r.setProperty("--doc-width", `${tokens.contentWidth}px`);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(THEME_APPLIED_EVENT, {
        detail: { tokens, editorTheme: editorThemeForTokens(tokens) },
      })
    );
  }
}
