import { describe, expect, it } from "vitest";
import { baseName, buildProjectTree, editsAsMarkdown, initiallyExpanded } from "./tree";

describe("buildProjectTree", () => {
  it("nests by path, folders first, names in natural order", () => {
    const tree = buildProjectTree([
      { path: "package.json", kind: "file" },
      { path: "site", kind: "dir" },
      { path: "site/pages", kind: "dir" },
      { path: "site/pages/p10.wd", kind: "file" },
      { path: "site/pages/p2.wd", kind: "file" },
      { path: "site/pages/index.skin", kind: "file" },
      { path: "api", kind: "dir" },
      { path: "api/hello.js", kind: "file" },
      { path: ".gitignore", kind: "file" },
      { path: "site/escape", kind: "link" },
    ]);
    expect(tree.map((node) => node.path)).toEqual(["api", "site", ".gitignore", "package.json"]);
    const site = tree[1];
    expect(site.children.map((node) => node.path)).toEqual(["site/pages", "site/escape"]);
    expect(site.children[0].children.map((node) => node.name)).toEqual(["index.skin", "p2.wd", "p10.wd"]);
    expect(site.children[1].kind).toBe("link");
  });

  it("still places a file whose folder row was cut off by the listing cap", () => {
    const tree = buildProjectTree([{ path: "deep/er/file.wd", kind: "file" }]);
    expect(tree[0]).toMatchObject({ path: "deep", kind: "dir" });
    expect(tree[0].children[0]).toMatchObject({ path: "deep/er", kind: "dir" });
    expect(tree[0].children[0].children[0]).toMatchObject({ path: "deep/er/file.wd", kind: "file", name: "file.wd" });
  });
});

describe("tree helpers", () => {
  it("opens the way to the site's pages first", () => {
    expect([...initiallyExpanded([{ path: "site", kind: "dir" }, { path: "site/pages", kind: "dir" }, { path: "api", kind: "dir" }])]).toEqual(["site", "site/pages"]);
    expect([...initiallyExpanded([{ path: "api", kind: "dir" }])]).toEqual([]);
  });
  it("names files and picks the Markdown grammar only for Markdown and Darkmown", () => {
    expect(baseName("site/pages/index.wd")).toBe("index.wd");
    expect(baseName("package.json")).toBe("package.json");
    expect(editsAsMarkdown("site/pages/index.wd")).toBe(true);
    expect(editsAsMarkdown("README.md")).toBe(true);
    expect(editsAsMarkdown("site/pages/index.skin")).toBe(false);
    expect(editsAsMarkdown("api/hello.js")).toBe(false);
  });
});
