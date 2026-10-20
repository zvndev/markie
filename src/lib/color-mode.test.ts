import { beforeEach, describe, expect, it } from "vitest";
import {
  COLOR_MODE_CHANGED_EVENT,
  applyColorMode,
  applyCustomPreset,
  applyTemplate,
  colorModeForThemeId,
  getColorMode,
} from "./color-mode";
import { editColors, findTemplate, loadThemeStore, saveThemeStore, MARKIE_DARK, MARKIE_LIGHT } from "./theme";

const storage = new Map<string, string>();
const classes = new Set<string>();
const styles = new Map<string, string>();
const events: CustomEvent[] = [];

(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
};

(globalThis as Record<string, unknown>).document = {
  documentElement: {
    dataset: {} as Record<string, string>,
    classList: {
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name: string) => classes.has(name),
    },
    style: {
      setProperty: (name: string, value: string) => void styles.set(name, value),
    },
  },
};
(globalThis as Record<string, unknown>).window = {
  dispatchEvent: (event: CustomEvent) => {
    events.push(event);
    return true;
  },
};

describe("color mode", () => {
  beforeEach(() => {
    storage.clear();
    classes.clear();
    styles.clear();
    events.length = 0;
  });

  it("removes the dark class when applying light mode", () => {
    classes.add("dark");

    applyColorMode("light");

    expect(classes.has("dark")).toBe(false);
    expect(styles.get("--background")).toBe(MARKIE_LIGHT.tokens.background);
    expect(events.at(-1)?.type).toBe(COLOR_MODE_CHANGED_EVENT);
    expect(events.at(-1)?.detail).toEqual({ mode: "light", resolved: "light" });
  });

  it("adds the dark class when applying dark mode", () => {
    applyColorMode("dark");

    expect(classes.has("dark")).toBe(true);
    expect(styles.get("--background")).toBe(MARKIE_DARK.tokens.background);
    expect(events.at(-1)?.detail).toEqual({ mode: "dark", resolved: "dark" });
  });

  it("maps built-in theme ids back to toolbar color modes", () => {
    expect(colorModeForThemeId(MARKIE_LIGHT.id)).toBe("light");
    expect(colorModeForThemeId(MARKIE_DARK.id)).toBe("dark");
    expect(colorModeForThemeId("custom")).toBeNull();
  });

  it("maps every template variant to its tone", () => {
    expect(colorModeForThemeId("paper-light")).toBe("light");
    expect(colorModeForThemeId("nord-dark")).toBe("dark");
  });

  // The bug this replaced: applying a mode forced Markie Light or Markie Dark,
  // so any other look was lost on the next launch or toggle.
  it("keeps the chosen template when the mode changes", () => {
    applyColorMode("dark");
    applyTemplate("solarized");
    expect(styles.get("--background")).toBe(findTemplate("solarized")!.dark.tokens.background);

    applyColorMode("light");
    expect(loadThemeStore().activeId).toBe("solarized-light");
    expect(styles.get("--background")).toBe(findTemplate("solarized")!.light.tokens.background);

    // A relaunch re-applies the stored mode and must land on the same template.
    applyColorMode("dark");
    applyColorMode(getColorMode());
    expect(loadThemeStore().activeId).toBe("solarized-dark");
  });

  it("brings a customized tone back after a trip through the other tone", () => {
    applyColorMode("dark");
    applyTemplate("paper");
    saveThemeStore(editColors(loadThemeStore(), "dark", { link: "#ff8800" }, "custom-dark"));

    applyColorMode("light");
    expect(loadThemeStore().activeId).toBe("paper-light");
    applyColorMode("dark");
    expect(loadThemeStore().activeId).toBe("custom-dark");
    expect(styles.get("--blue")).toBe("#ff8800");
  });

  it("switches the mode to match a single-tone custom preset picked directly", () => {
    applyColorMode("light");
    applyTemplate("ink");
    saveThemeStore(editColors(loadThemeStore(), "dark", { accent: "#222233" }, "ink-mine"));
    applyColorMode("light");

    applyCustomPreset("ink-mine");
    expect(getColorMode()).toBe("dark");
    expect(classes.has("dark")).toBe(true);
    expect(loadThemeStore().activeId).toBe("ink-mine");
  });
});
