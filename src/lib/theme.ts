export interface ThemeTokens {
  background: string;
  surface: string;
  surface2: string;
  foreground: string;
  muted: string;
  border: string;
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
    border: "#27272a",
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
    border: "#c7d0dc",
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
