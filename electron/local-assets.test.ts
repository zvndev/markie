import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { candidatePath, containedIn, imageMimeFor, resolveImage } =
  require("./local-assets") as typeof import("./local-assets");

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "markie-assets-"));
  const docDir = path.join(home, "report");
  mkdirSync(path.join(docDir, "demo"), { recursive: true });
  mkdirSync(path.join(home, "assets"), { recursive: true });
  mkdirSync(path.join(home, "private"), { recursive: true });
  writeFileSync(path.join(docDir, "demo", "shot.png"), "png");
  writeFileSync(path.join(docDir, "notes.txt"), "text");
  writeFileSync(path.join(home, "assets", "logo.png"), "png");
  writeFileSync(path.join(home, "private", "secret.png"), "png");
  return { home, docDir };
}

describe("what a document may show", () => {
  it("finds a picture in the document's own folder", () => {
    const { docDir } = fixture();
    const found = resolveImage("demo/shot.png", { docDir });
    expect(found?.path.endsWith("demo/shot.png")).toBe(true);
    expect(found?.mime).toBe("image/png");
  });

  it("refuses a picture outside the folder, however it is spelled", () => {
    const { home, docDir } = fixture();
    for (const src of [
      "../private/secret.png",
      "../../etc/passwd.png",
      `${home}/private/secret.png`,
      "demo/../../private/secret.png",
    ]) {
      expect(resolveImage(src, { docDir })).toBeNull();
    }
  });

  it("allows a workspace root, which is where a repository keeps its pictures", () => {
    // docs/report.md referring to ../assets/logo.png is how repositories are
    // actually laid out, and refusing it is the one limitation worth lifting.
    const { home, docDir } = fixture();
    expect(resolveImage("../assets/logo.png", { docDir })).toBeNull();
    expect(resolveImage("../assets/logo.png", { docDir, roots: [home] })?.mime).toBe("image/png");
  });

  it("refuses a symlink that points out of the folder", () => {
    // A plain string comparison passes this; realpath on both sides is what
    // actually stops it.
    const { home, docDir } = fixture();
    symlinkSync(path.join(home, "private", "secret.png"), path.join(docDir, "innocent.png"));
    expect(resolveImage("innocent.png", { docDir })).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses a file that is not an image, even inside the folder", () => {
    const { docDir } = fixture();
    expect(resolveImage("notes.txt", { docDir })).toBeNull();
  });

  it("leaves remote and inlined sources alone rather than treating them as paths", () => {
    const { docDir } = fixture();
    for (const src of [
      "https://example.com/a.png",
      "//example.com/a.png",
      "data:image/png;base64,AAAA",
      "mailto:someone@example.com",
    ]) {
      expect(candidatePath(src, docDir)).toBeNull();
    }
  });

  it("reads a src as a URL, because that is what it is", () => {
    const dir = "/docs";
    expect(candidatePath("my%20image.png", dir)).toBe("/docs/my image.png");
    expect(candidatePath("a.png?v=2", dir)).toBe("/docs/a.png");
    expect(candidatePath("a.png#top", dir)).toBe("/docs/a.png");
  });

  it("answers nothing when there is no document to resolve against", () => {
    expect(resolveImage("demo/shot.png", {})).toBeNull();
  });

  it("knows a folder does not contain itself", () => {
    expect(containedIn("/a/b", "/a/b")).toBe(false);
    expect(containedIn("/a/b", "/a/b/c.png")).toBe(true);
    expect(containedIn("/a/b", "/a/bc.png")).toBe(false);
  });

  it("names types by extension rather than guessing at content", () => {
    expect(imageMimeFor("a.PNG")).toBe("image/png");
    expect(imageMimeFor("a.svg")).toBe("image/svg+xml");
    expect(imageMimeFor("a.exe")).toBeNull();
    expect(imageMimeFor("a")).toBeNull();
  });
});
