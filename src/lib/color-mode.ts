// Light / dark / system color mode, layered on top of the theme presets.
// Light → Markie Light, Dark → Markie Dark, System → follows the OS and
// re-applies when the OS preference flips.
import {
  applyTheme,
  loadThemeStore,
  saveThemeStore,
  MARKIE_DARK,
  MARKIE_LIGHT,
} from "@/lib/theme";

export type ColorMode = "system" | "light" | "dark";

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
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function resolveColorMode(mode: ColorMode): "light" | "dark" {
  if (mode === "system") return osPrefersDark() ? "dark" : "light";
  return mode;
}

// Apply the resolved mode by switching the active built-in theme.
export function applyColorMode(mode: ColorMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // ignore
  }
  const resolved = resolveColorMode(mode);
  const preset = resolved === "dark" ? MARKIE_DARK : MARKIE_LIGHT;
  const store = loadThemeStore();
  saveThemeStore({ ...store, activeId: preset.id });
  applyTheme(preset.tokens);
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
