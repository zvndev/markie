import { describe, expect, it } from "vitest";
import { compactHomePath, inferHomePath } from "./path-display";

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
