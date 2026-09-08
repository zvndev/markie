import { afterEach, describe, expect, it } from "vitest";
import { getAssetBaseDir, isAssetUrl, resolveAssetSrc, setAssetBaseDir } from "@/lib/asset-url";

afterEach(() => setAssetBaseDir(null));

const decoded = (url: string) => decodeURIComponent(url.replace("markie-asset://local/", ""));

describe("resolveAssetSrc", () => {
  it("resolves a relative path against the open document's folder", () => {
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("demo/shot.png"))).toBe("/Users/me/report/demo/shot.png");
  });

  it("leaves anything that already says where it lives", () => {
    setAssetBaseDir("/Users/me/report");
    for (const src of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "//example.com/a.png",
    ]) {
      expect(resolveAssetSrc(src)).toBe(src);
    }
  });

  it("leaves the src alone when no document is open", () => {
    expect(resolveAssetSrc("demo/shot.png")).toBe("demo/shot.png");
  });

  it("normalises the path rather than handing main a string full of dots", () => {
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("./demo/../shot.png"))).toBe("/Users/me/report/shot.png");
    expect(decoded(resolveAssetSrc("../assets/logo.png"))).toBe("/Users/me/assets/logo.png");
  });

  it("cannot be walked above the root", () => {
    // Main refuses this anyway. Producing a sane path here means the refusal
    // is about access rather than about a string nobody can read.
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("../../../../../../etc/passwd"))).toBe("/etc/passwd");
  });

  it("reads the src as a URL: escapes decoded, query and hash dropped", () => {
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("my%20image.png"))).toBe("/Users/me/report/my image.png");
    expect(decoded(resolveAssetSrc("a.png?v=2"))).toBe("/Users/me/report/a.png");
    expect(decoded(resolveAssetSrc("a.png#top"))).toBe("/Users/me/report/a.png");
  });

  it("keeps an absolute path absolute instead of nesting it under the folder", () => {
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("/Users/me/elsewhere/a.png"))).toBe("/Users/me/elsewhere/a.png");
  });

  it("survives a src that is empty or malformed", () => {
    setAssetBaseDir("/Users/me/report");
    expect(resolveAssetSrc(null)).toBe("");
    expect(resolveAssetSrc("   ")).toBe("");
    expect(decoded(resolveAssetSrc("100%.png"))).toBe("/Users/me/report/100%.png");
  });

  it("remembers and clears the base", () => {
    setAssetBaseDir("/Users/me/report");
    expect(getAssetBaseDir()).toBe("/Users/me/report");
    setAssetBaseDir("");
    expect(getAssetBaseDir()).toBeNull();
  });

  it("resolves against a base handed in, and leaves the document's alone", () => {
    // A SKILL.md previewed out of the catalog cache has its pictures beside
    // its own file, not beside whatever is open in the editor.
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("assets/demo.png", "/Users/me/cache/pdf"))).toBe(
      "/Users/me/cache/pdf/assets/demo.png"
    );
    expect(getAssetBaseDir()).toBe("/Users/me/report");
  });

  it("falls back to the document's base when the one handed in is empty", () => {
    setAssetBaseDir("/Users/me/report");
    expect(decoded(resolveAssetSrc("a.png", undefined))).toBe("/Users/me/report/a.png");
    expect(decoded(resolveAssetSrc("a.png", null))).toBe("/Users/me/report/a.png");
    expect(decoded(resolveAssetSrc("a.png", "  "))).toBe("/Users/me/report/a.png");
  });

  it("needs no open document when a base is handed in", () => {
    expect(decoded(resolveAssetSrc("a.png", "/Users/me/cache/pdf"))).toBe("/Users/me/cache/pdf/a.png");
    expect(resolveAssetSrc("https://example.com/a.png", "/Users/me/cache/pdf")).toBe(
      "https://example.com/a.png"
    );
  });

  it("recognises its own urls", () => {
    setAssetBaseDir("/Users/me/report");
    expect(isAssetUrl(resolveAssetSrc("a.png"))).toBe(true);
    expect(isAssetUrl("https://example.com/a.png")).toBe(false);
    expect(isAssetUrl(null)).toBe(false);
  });
});
