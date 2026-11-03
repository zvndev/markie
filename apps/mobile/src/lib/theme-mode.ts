// System, light or dark, painted with the desktop's own Markie tokens
// (src/lib/theme.ts), so a document reads the same on the phone as on the Mac.
import { applyTheme, MARKIE_DARK, MARKIE_LIGHT, saveThemeStore } from "@/lib/theme";

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
  // The desktop's source editor (CodeMirror, in a live text document) picks
  // its colours from the desktop's theme store when it mounts, and from the
  // event applyTheme sends after that. The store is kept on the phone's tone
  // so an editor that mounts later reads light text on light, never dark.
  try {
    saveThemeStore({ activeId: tone === "dark" ? MARKIE_DARK.id : MARKIE_LIGHT.id, custom: [] });
  } catch {
    // Storage unavailable: the event below still reaches a mounted editor.
  }
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
