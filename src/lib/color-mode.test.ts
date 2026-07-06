import { beforeEach, describe, expect, it } from "vitest";
import {
  COLOR_MODE_CHANGED_EVENT,
  applyColorMode,
  colorModeForThemeId,
} from "./color-mode";
import { MARKIE_DARK, MARKIE_LIGHT } from "./theme";

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
});
