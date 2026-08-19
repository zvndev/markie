import { beforeEach, describe, expect, it } from "vitest";
import { markWelcomeSeen, shouldShowWelcome } from "./first-run";

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

let storage = fakeStorage();
beforeEach(() => {
  storage = fakeStorage();
});

describe("shouldShowWelcome", () => {
  it("shows on a cold launch with nothing opened", () => {
    expect(shouldShowWelcome({ storage, openedFile: false })).toBe(true);
  });

  it("does not show twice", () => {
    markWelcomeSeen({ storage });
    expect(shouldShowWelcome({ storage, openedFile: false })).toBe(false);
  });

  it("never shows when the OS handed Markie a file to open", () => {
    // Markie is the default .md handler. Someone who double-clicked a file
    // asked for that file, and a welcome doc in its place is a bug, not an
    // introduction.
    expect(shouldShowWelcome({ storage, openedFile: true })).toBe(false);
  });

  it("does not burn the welcome on a launch that opened a file", () => {
    // Opening a file first must not cost the user their one introduction, so a
    // later cold launch still gets it.
    shouldShowWelcome({ storage, openedFile: true });
    expect(shouldShowWelcome({ storage, openedFile: false })).toBe(true);
  });

  it("shows when storage is unavailable rather than suppressing itself", () => {
    // Failing closed here means a broken localStorage silently removes
    // onboarding for everyone; showing a document is harmless either way.
    expect(shouldShowWelcome({ storage: null, openedFile: false })).toBe(true);
  });

  it("survives a storage that throws on read", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => shouldShowWelcome({ storage: hostile, openedFile: false })).not.toThrow();
  });
});

describe("markWelcomeSeen", () => {
  it("survives a storage that throws on write", () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(() => markWelcomeSeen({ storage: hostile })).not.toThrow();
  });

  it("is a no-op without storage", () => {
    expect(() => markWelcomeSeen({ storage: null })).not.toThrow();
  });
});
