import { describe, it, expect } from "vitest";
import { isKnownApp } from "./terminal.js";

describe("isKnownApp", () => {
  it("accepts detected terminal ids and names", () => {
    expect(isKnownApp("ghostty")).toBe(true);
    expect(isKnownApp("iTerm")).toBe(true);
    expect(isKnownApp("terminal")).toBe(true);
    expect(isKnownApp("Terminal")).toBe(true);
  });
  it("rejects anything else (no arbitrary app launch)", () => {
    expect(isKnownApp("Calculator")).toBe(false);
    expect(isKnownApp("")).toBe(false);
    expect(isKnownApp("../../evil")).toBe(false);
  });
});
