export interface ThemeTokens {
  background: string;
  surface: string;
  surface2: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  link: string;
  fontSize: number; // base px for the document body
  contentWidth: number; // max width px for the reading column
}

export interface ThemePreset {
  id: string;
  name: string;
  builtIn?: boolean;
  tokens: ThemeTokens;
}

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
    fontSize: 16,
    contentWidth: 768,
  },
};

export const MARKIE_LIGHT: ThemePreset = {
  id: "markie-light",
  name: "Markie Light",
  builtIn: true,
  tokens: {
    background: "#fafafa",
    surface: "#f1f1f3",
    surface2: "#e9e9ec",
    foreground: "#18181b",
    muted: "#52525b",
    border: "#d4d4d8",
    accent: "#d4d4d8",
    link: "#2563eb",
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
  r.setProperty("--doc-font-size", `${tokens.fontSize}px`);
  r.setProperty("--doc-width", `${tokens.contentWidth}px`);
}
