import { beforeEach, describe, expect, it } from "vitest";
import { applyColorMode } from "./color-mode";
import { MARKIE_DARK, MARKIE_LIGHT } from "./theme";

const storage = new Map<string, string>();
const classes = new Set<string>();
const styles = new Map<string, string>();

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

describe("color mode", () => {
  beforeEach(() => {
    storage.clear();
    classes.clear();
    styles.clear();
  });

  it("removes the dark class when applying light mode", () => {
    classes.add("dark");

    applyColorMode("light");

    expect(classes.has("dark")).toBe(false);
    expect(styles.get("--background")).toBe(MARKIE_LIGHT.tokens.background);
  });

  it("adds the dark class when applying dark mode", () => {
    applyColorMode("dark");

    expect(classes.has("dark")).toBe(true);
    expect(styles.get("--background")).toBe(MARKIE_DARK.tokens.background);
  });
});
