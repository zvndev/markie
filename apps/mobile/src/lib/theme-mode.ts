// System, light or dark, painted with the desktop's own Markie tokens
// (src/lib/theme.ts), so a document reads the same on the phone as on the Mac.
import { applyTheme, MARKIE_DARK, MARKIE_LIGHT } from "@/lib/theme";

export type ThemeMode = "system" | "light" | "dark";
export type Tone = "light" | "dark";

const MODE_KEY = "markie.mobile.theme.v1";

export function loadThemeMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): ThemeMode {
  const value = storage?.getItem(MODE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function saveThemeMode(mode: ThemeMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    // The choice still applies for this launch.
  }
}

export function resolveTone(mode: ThemeMode, systemDark: boolean): Tone {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** Paints the tokens and tells the shell which tone it is in. */
export function paintTone(tone: Tone): void {
  applyTheme(tone === "dark" ? MARKIE_DARK.tokens : MARKIE_LIGHT.tokens);
  const root = document.documentElement;
  root.classList.toggle("dark", tone === "dark");
  root.style.colorScheme = tone;
  const meta = document.querySelector('meta[name="theme-color"]') ?? Object.assign(document.createElement("meta"), { name: "theme-color" });
  meta.setAttribute("content", tone === "dark" ? MARKIE_DARK.tokens.background : MARKIE_LIGHT.tokens.background);
  if (!meta.parentNode) document.head.append(meta);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
