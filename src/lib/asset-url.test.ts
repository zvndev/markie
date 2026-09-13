import { afterEach, describe, expect, it } from "vitest";
import { getAssetBaseDir, isAssetUrl, resolveAssetSrc, setAssetDocPath } from "@/lib/asset-url";

afterEach(() => setAssetDocPath(null));

// The query suffix names the document a reference belongs to and the
// reference as written (see the tests at the bottom); every other test here
// is about how the path itself gets built, so this strips the suffix the way
// a caller who only wants the path would (new URL(...).pathname does the same
// on the main side).
const decoded = (url: string) =>
  decodeURIComponent(url.replace("markie-asset://local/", "").split("?")[0]);

describe("resolveAssetSrc", () => {
  it("resolves a relative path against the open document's folder", () => {
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("demo/shot.png"))).toBe("/Users/me/report/demo/shot.png");
  });

  it("leaves anything that already says where it lives", () => {
    setAssetDocPath("/Users/me/report/notes.md");
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
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("./demo/../shot.png"))).toBe("/Users/me/report/shot.png");
    expect(decoded(resolveAssetSrc("../assets/logo.png"))).toBe("/Users/me/assets/logo.png");
  });

  it("cannot be walked above the root", () => {
    // Main refuses this anyway. Producing a sane path here means the refusal
    // is about access rather than about a string nobody can read.
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("../../../../../../etc/passwd"))).toBe("/etc/passwd");
  });

  it("reads the src as a URL: escapes decoded, query and hash dropped", () => {
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("my%20image.png"))).toBe("/Users/me/report/my image.png");
    expect(decoded(resolveAssetSrc("a.png?v=2"))).toBe("/Users/me/report/a.png");
    expect(decoded(resolveAssetSrc("a.png#top"))).toBe("/Users/me/report/a.png");
  });

  it("keeps an absolute path absolute instead of nesting it under the folder", () => {
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("/Users/me/elsewhere/a.png"))).toBe("/Users/me/elsewhere/a.png");
  });

  it("survives a src that is empty or malformed", () => {
    setAssetDocPath("/Users/me/report/notes.md");
    expect(resolveAssetSrc(null)).toBe("");
    expect(resolveAssetSrc("   ")).toBe("");
    expect(decoded(resolveAssetSrc("100%.png"))).toBe("/Users/me/report/100%.png");
  });

  it("remembers the open document and derives its folder", () => {
    setAssetDocPath("/Users/me/report/notes.md");
    expect(getAssetBaseDir()).toBe("/Users/me/report");
    setAssetDocPath("");
    expect(getAssetBaseDir()).toBeNull();
  });

  it("resolves against a base handed in, and leaves the document's alone", () => {
    // A SKILL.md previewed out of the catalog cache has its pictures beside
    // its own file, not beside whatever is open in the editor.
    setAssetDocPath("/Users/me/report/notes.md");
    expect(decoded(resolveAssetSrc("assets/demo.png", "/Users/me/cache/pdf"))).toBe(
      "/Users/me/cache/pdf/assets/demo.png"
    );
    expect(getAssetBaseDir()).toBe("/Users/me/report");
  });

  it("falls back to the document's base when the one handed in is empty", () => {
    setAssetDocPath("/Users/me/report/notes.md");
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
    setAssetDocPath("/Users/me/report/notes.md");
    expect(isAssetUrl(resolveAssetSrc("a.png"))).toBe(true);
    expect(isAssetUrl("https://example.com/a.png")).toBe(false);
    expect(isAssetUrl(null)).toBe(false);
  });

  it("names the exact document the reference belongs to, not its folder", () => {
    // Two synced documents can share a folder and reference the same missing
    // picture. Naming the folder let main answer with whichever of them was
    // opened last, which is how one document rendered another's media.
    setAssetDocPath("/Users/k/report/notes.md");
    expect(resolveAssetSrc("shots/a.png")).toBe(
      `markie-asset://local/${encodeURIComponent("/Users/k/report/shots/a.png")}?doc=${encodeURIComponent("/Users/k/report/notes.md")}&ref=${encodeURIComponent("shots/a.png")}`
    );
  });

  it("carries the reference as it was written, not one rebuilt from the path", () => {
    // The uploader stores the reference verbatim, so "./a.png" is linked under
    // "./a.png" and "../img/a.png" under "../img/a.png". A reading machine that
    // recomputes the name from the resolved path asks for "a.png" and for an
    // absolute path, and the server holds nothing under either.
    setAssetDocPath("/Users/k/report/notes.md");
    const refOf = (url: string) => new URL(url).searchParams.get("ref");
    expect(refOf(resolveAssetSrc("./a.png"))).toBe("./a.png");
    expect(refOf(resolveAssetSrc("../img/a.png"))).toBe("../img/a.png");
    expect(refOf(resolveAssetSrc("a%20b.png"))).toBe("a b.png");
    expect(refOf(resolveAssetSrc("/abs/a.png"))).toBe("/abs/a.png");
  });

  it("names no reference when it names no document", () => {
    // Without a document there is nothing to look the reference up against,
    // and a preview resolved against some other folder is not the open one.
    setAssetDocPath("/Users/k/report/notes.md");
    expect(new URL(resolveAssetSrc("a.png", "/elsewhere")).searchParams.get("ref")).toBeNull();
  });

  it("names no document when the caller resolved against some other folder", () => {
    // A preview out of the catalog cache is not the open document, and there
    // is no document to fall back on cloud media for.
    setAssetDocPath("/Users/k/report/notes.md");
    expect(resolveAssetSrc("shots/a.png", "/elsewhere")).toBe(
      `markie-asset://local/${encodeURIComponent("/elsewhere/shots/a.png")}`
    );
    expect(resolveAssetSrc("shots/a.png", "/Users/k/report")).toBe(
      `markie-asset://local/${encodeURIComponent("/Users/k/report/shots/a.png")}`
    );
  });
});
