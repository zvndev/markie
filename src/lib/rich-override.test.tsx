import { beforeEach, describe, expect, it } from "vitest";
import { richOverride, setRichOverride } from "@/lib/rich-override";

describe("rich override", () => {
  beforeEach(() => localStorage.clear());

  it("defaults off and persists per path", () => {
    expect(richOverride("/a/x.md")).toBe(false);
    setRichOverride("/a/x.md", true);
    expect(richOverride("/a/x.md")).toBe(true);
    expect(richOverride("/a/y.md")).toBe(false);
  });

  it("treats null path as the untitled document", () => {
    setRichOverride(null, true);
    expect(richOverride(null)).toBe(true);
  });

  it("clears an override that is turned back off", () => {
    setRichOverride("/a/x.md", true);
    setRichOverride("/a/x.md", false);
    expect(richOverride("/a/x.md")).toBe(false);
  });
});
