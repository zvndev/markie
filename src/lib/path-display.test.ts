import { describe, expect, it } from "vitest";
import { compactDir, compactHomePath, inferHomePath } from "./path-display";

describe("path display", () => {
  it("infers macOS and Linux home roots", () => {
    expect(inferHomePath(["/Users/ada/Notes/a.md"])).toBe("/Users/ada");
    expect(inferHomePath(["/home/ada/Notes/a.md"])).toBe("/home/ada");
  });

  it("infers Windows home roots", () => {
    expect(inferHomePath(["C:\\Users\\Ada\\Notes\\a.md"])).toBe("C:\\Users\\Ada");
    expect(inferHomePath(["D:/Documents and Settings/Ada/Notes/a.md"])).toBe(
      "D:/Documents and Settings/Ada"
    );
  });

  it("compacts paths below home for library lists", () => {
    expect(compactHomePath("/Users/ada/Notes/a.md", "/Users/ada", false)).toBe(
      "Notes/a.md"
    );
    expect(compactHomePath("/Users/ada/Notes/a.md", "/Users/ada", true)).toBe(
      "~/Notes/a.md"
    );
  });

  it("compacts Windows paths case-insensitively", () => {
    expect(
      compactHomePath(
        "C:\\Users\\Ada\\Documents\\Markie\\a.md",
        "c:\\users\\ada",
        false
      )
    ).toBe("Documents\\Markie\\a.md");
    expect(
      compactHomePath(
        "C:\\Users\\Ada\\Documents\\Markie\\a.md",
        "C:\\Users\\Ada",
        true
      )
    ).toBe("~\\Documents\\Markie\\a.md");
  });

  it("leaves paths outside home untouched", () => {
    expect(compactHomePath("/srv/docs/a.md", "/Users/ada", true)).toBe(
      "/srv/docs/a.md"
    );
  });
});

describe("compactDir", () => {
  const HOME = "/Users/kirby";

  it("keeps the tail, which is the part that says which work this is", () => {
    // A column of forty rows used to open with the same forty characters of
    // home directory before reaching anything that told them apart.
    expect(compactDir(`${HOME}/Desktop/Coding/ZVN/markie/docs`, HOME)).toBe("…/markie/docs");
  });

  it("shows a short path whole", () => {
    expect(compactDir(`${HOME}/Documents`, HOME)).toBe("~/Documents");
    expect(compactDir(HOME, HOME)).toBe("~");
  });

  it("shortens a path outside home too", () => {
    expect(compactDir("/opt/notes/specs", HOME)).toBe("…/notes/specs");
    expect(compactDir("/opt/notes", HOME)).toBe("opt/notes");
  });

  it("takes as many segments as it is asked for", () => {
    expect(compactDir(`${HOME}/a/b/c/d`, HOME, 3)).toBe("…/b/c/d");
    expect(compactDir(`${HOME}/a/b/c/d`, HOME, 1)).toBe("…/d");
  });

  it("uses the separator the path itself uses", () => {
    expect(compactDir("C:\\Users\\kirby\\Docs\\Notes\\Specs", "C:\\Users\\kirby")).toBe(
      "…\\Notes\\Specs"
    );
  });

  it("has nothing to say about nothing", () => {
    expect(compactDir("", HOME)).toBe("");
  });
});
