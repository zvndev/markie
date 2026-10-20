// Light / dark / system color mode, layered on top of style templates.
//
// The mode never chooses a look, only a tone. The active template (Markie,
// Paper, Nord, ...) supplies a light and a dark variant, and the mode picks
// which one is painted. System follows the OS and re-applies when it flips.
//
// Custom presets are single-tone: editing colors forks the variant you were
// looking at into a preset that remembers its template and tone, and it stands
// in for that tone only. Switching to the other tone paints the template's own
// variant there; switching back brings the custom preset back. Picking a custom
// preset directly also switches the mode to its tone, since that is the only
// tone it has.
import {
  applyTheme,
  chooseCustomPreset,
  chooseTemplate,
  findTheme,
  loadThemeStore,
  presetForTone,
  presetTone,
  saveThemeStore,
  BUILT_IN_THEMES,
  type ThemeStore,
  type ThemeTone,
} from "./theme";

export type ColorMode = "system" | "light" | "dark";
export const COLOR_MODE_CHANGED_EVENT = "markie:color-mode-changed";

const MODE_KEY = "markie.colormode.v1";

export function getColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable
  }
  return "system";
}

function osPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function resolveColorMode(mode: ColorMode): ThemeTone {
  if (mode === "system") return osPrefersDark() ? "dark" : "light";
  return mode;
}

// The tone a built-in variant id belongs to; null for anything else.
export function colorModeForThemeId(themeId: string): Exclude<ColorMode, "system"> | null {
  return BUILT_IN_THEMES.find((theme) => theme.id === themeId)?.tone ?? null;
}

// Save a store and paint whichever preset it resolves to in the current tone.
// The store's activeId is rewritten to that preset, so every reader of
// findTheme(store, store.activeId) agrees with what is on screen.
export function commitThemeStore(store: ThemeStore, tone: ThemeTone = resolveColorMode(getColorMode())): ThemeStore {
  const preset = presetForTone(store, tone);
  const next: ThemeStore = { ...store, activeId: preset.id };
  saveThemeStore(next);
  applyTheme(findTheme(next, preset.id).tokens);
  return next;
}

// Apply the resolved mode by painting the active template's variant for it.
export function applyColorMode(mode: ColorMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
  const resolved = resolveColorMode(mode);
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }
  commitThemeStore(loadThemeStore(), resolved);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(COLOR_MODE_CHANGED_EVENT, {
        detail: { mode, resolved },
      })
    );
  }
}

// Choose a template and paint its variant for the current mode.
export function applyTemplate(templateId: string): ThemeStore {
  const tone = resolveColorMode(getColorMode());
  return commitThemeStore(chooseTemplate(loadThemeStore(), templateId, tone), tone);
}

// Choose a custom preset. It has one tone, so the mode follows it when needed.
export function applyCustomPreset(presetId: string): ThemeStore {
  const store = chooseCustomPreset(loadThemeStore(), presetId);
  const preset = store.custom.find((t) => t.id === presetId);
  if (!preset) return store;
  const tone = presetTone(preset);
  if (resolveColorMode(getColorMode()) !== tone) {
    saveThemeStore(store);
    applyColorMode(tone);
    return loadThemeStore();
  }
  return commitThemeStore(store, tone);
}

// Keep "system" in sync with live OS changes; returns an unsubscribe fn.
export function watchSystemColorMode(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getColorMode() === "system") applyColorMode("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
