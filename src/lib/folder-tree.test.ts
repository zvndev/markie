import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  countNodes,
  initialOpenSet,
  pathsToFiles,
  sortTree,
  type FolderNode,
} from "./folder-tree";

const file = (path: string, mtimeMs = 0) => {
  const cut = path.lastIndexOf("/");
  return { path, name: path.slice(cut + 1), dir: path.slice(0, cut), mtimeMs };
};

// A tree written by hand, for the shapes buildFolderTree's collapsing rule
// never produces but the open rule still has to survive.
const node = (path: string, parts: Partial<FolderNode> = {}): FolderNode => ({
  path,
  label: path.slice(path.lastIndexOf("/") + 1),
  files: [],
  children: [],
  total: 0,
  latestMtimeMs: 0,
  ...parts,
});

// Flattens to "label (total)" lines so a test reads like the sidebar looks.
function render(nodes: readonly FolderNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.label} (${n.total})`,
    ...n.files.map((f) => `${"  ".repeat(depth + 1)}${f.name}`),
    ...render(n.children, depth + 1),
  ]);
}

describe("building the folder tree", () => {
  // The complaint: ten files under one project produced ten rows.
  it("gives a project one row, not one per file", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      file(`/Users/k/ZVN/Medusa/doc${i}.md`)
    );
    const tree = buildFolderTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("Users/k/ZVN/Medusa");
    expect(tree[0].total).toBe(10);
  });

  // And the other half of it: subfolders were siblings, each reprinting the
  // shared prefix, instead of nesting under the project.
  it("nests subfolders instead of listing them beside their parent", () => {
    const tree = buildFolderTree([
      file("/Users/k/ZVN/Medusa/readme.md"),
      file("/Users/k/ZVN/Medusa/docs/setup.md"),
      file("/Users/k/ZVN/Medusa/docs/deep/notes.md"),
    ]);
    expect(render(tree)).toEqual([
      "Users/k/ZVN/Medusa (3)",
      "  readme.md",
      "  docs (2)",
      "    setup.md",
      "    deep (1)",
      "      notes.md",
    ]);
  });

  it("splits into siblings where the paths genuinely diverge", () => {
    const tree = buildFolderTree([
      file("/Users/k/ZVN/Medusa/a.md"),
      file("/Users/k/ZVN/Markie/b.md"),
    ]);
    expect(render(tree)).toEqual([
      "Users/k/ZVN (2)",
      "  Markie (1)",
      "    b.md",
      "  Medusa (1)",
      "    a.md",
    ]);
  });

  // A folder that holds a file is a place, even if it also has one subfolder,
  // so it must not be folded away or its file becomes unreachable.
  it("does not collapse a folder that holds files of its own", () => {
    const tree = buildFolderTree([
      file("/root/project/readme.md"),
      file("/root/project/docs/guide.md"),
    ]);
    expect(tree[0].label).toBe("root/project");
    expect(tree[0].files.map((f) => f.name)).toEqual(["readme.md"]);
    expect(tree[0].children[0].label).toBe("docs");
  });

  it("counts everything at or below a folder, not just its own level", () => {
    const tree = buildFolderTree([
      file("/a/b/one.md"),
      file("/a/b/c/two.md"),
      file("/a/b/c/d/three.md"),
    ]);
    expect(tree[0].total).toBe(3);
    expect(tree[0].children[0].total).toBe(2);
  });

  it("sorts folders and files by name", () => {
    const tree = buildFolderTree([
      file("/r/zeta/b.md"),
      file("/r/zeta/a.md"),
      file("/r/alpha/x.md"),
    ]);
    expect(tree[0].children.map((c) => c.label)).toEqual(["alpha", "zeta"]);
    expect(tree[0].children[1].files.map((f) => f.name)).toEqual(["a.md", "b.md"]);
  });

  it("keeps a node's path openable", () => {
    const tree = buildFolderTree([file("/Users/k/ZVN/Medusa/docs/x.md")]);
    expect(tree[0].path).toBe("/Users/k/ZVN/Medusa/docs");
  });

  it("handles Windows paths", () => {
    const tree = buildFolderTree([
      { path: "C:\\work\\notes\\a.md", name: "a.md", dir: "C:\\work\\notes", mtimeMs: 0 },
    ]);
    expect(tree[0].label).toBe("C:/work/notes");
  });

  it("is empty for no files", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("ignores a file with no directory rather than inventing a root", () => {
    expect(buildFolderTree([{ path: "a.md", name: "a.md", dir: "", mtimeMs: 0 }])).toEqual([]);
  });
});

describe("opening the tree to a filter's matches", () => {
  it("names every folder on the way to a file", () => {
    const tree = buildFolderTree([file("/a/b/c/x.md")]);
    expect(pathsToFiles(tree)).toContain("/a/b/c");
  });

  it("counts the rows the tree would draw", () => {
    const tree = buildFolderTree([
      file("/a/b/one.md"),
      file("/a/c/two.md"),
    ]);
    expect(countNodes(tree)).toBe(3);
  });
});

describe("the level Browse opens at", () => {
  it("opens every root", () => {
    const tree = buildFolderTree([file("/a/one.md"), file("/b/two.md")]);
    expect([...initialOpenSet(tree)].sort()).toEqual(["/a", "/b"]);
  });

  // Collapsing means a real tree hands us the branch at the root, but the rule
  // is written for the general shape so a chain is never left half open.
  it("follows a single-child chain down to the first folder with a choice", () => {
    const deep = node("/r/one/two", { children: [node("/r/one/two/x"), node("/r/one/two/y")] });
    const tree = [node("/r", { children: [node("/r/one", { children: [deep] })] })];
    expect([...initialOpenSet(tree)].sort()).toEqual(["/r", "/r/one", "/r/one/two"]);
  });

  it("stops at the branching folder rather than opening what is under it", () => {
    const branch = node("/r/one", {
      children: [node("/r/one/x", { children: [node("/r/one/x/deeper")] }), node("/r/one/y")],
    });
    const open = initialOpenSet([node("/r", { children: [branch] })]);
    expect(open.has("/r/one")).toBe(true);
    expect(open.has("/r/one/x")).toBe(false);
  });

  // One file is not a choice, and there is nothing below it to walk into.
  it("counts a file as an entry, so a folder holding two files is the stop", () => {
    const tree = buildFolderTree([file("/a/b/one.md"), file("/a/b/two.md")]);
    expect([...initialOpenSet(tree)]).toEqual(["/a/b"]);
  });

  it("is empty for an empty tree", () => {
    expect(initialOpenSet([])).toEqual(new Set());
  });
});

describe("the newest file beneath a folder", () => {
  it("carries the newest time at or below each folder", () => {
    const tree = buildFolderTree([
      file("/a/b/old.md", 100),
      file("/a/b/c/new.md", 900),
    ]);
    expect(tree[0].latestMtimeMs).toBe(900);
    expect(tree[0].children[0].latestMtimeMs).toBe(900);
  });

  // 200,000 is the indexer's cap (electron/mdindex.js), and one directory can
  // hold all of it. Math.max(...files) died here with a RangeError before the
  // whole panel had drawn anything.
  it("survives one folder holding the whole index", () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({
      path: `/big/file${i}.md`,
      name: `file${i}.md`,
      dir: "/big",
      mtimeMs: i + 1,
    }));
    const tree = buildFolderTree(rows);
    expect(tree[0].latestMtimeMs).toBe(200_000);
    const sorted = sortTree(tree, "updated");
    expect(sorted[0].files[0].name).toBe("file199999.md");
  }, 20_000);

  it("is the folder's own newest file when nothing below it is newer", () => {
    const tree = buildFolderTree([
      file("/a/b/recent.md", 900),
      file("/a/b/c/stale.md", 100),
    ]);
    expect(tree[0].latestMtimeMs).toBe(900);
    expect(tree[0].children[0].latestMtimeMs).toBe(100);
  });
});

describe("sorting the tree", () => {
  const tree = () =>
    buildFolderTree([
      file("/r/alpha/aaa.md", 100),
      file("/r/alpha/zzz.md", 500),
      file("/r/zeta/newest.md", 900),
    ]);

  it("leaves name order alone", () => {
    const sorted = sortTree(tree(), "name");
    expect(sorted[0].children.map((c) => c.label)).toEqual(["alpha", "zeta"]);
    expect(sorted[0].children[0].files.map((f) => f.name)).toEqual(["aaa.md", "zzz.md"]);
  });

  it("puts the newest file first and the folder with the newest file first", () => {
    const sorted = sortTree(tree(), "updated");
    expect(sorted[0].children.map((c) => c.label)).toEqual(["zeta", "alpha"]);
    expect(sorted[0].children[1].files.map((f) => f.name)).toEqual(["zzz.md", "aaa.md"]);
  });

  it("does not disturb the tree it was given", () => {
    const original = tree();
    sortTree(original, "updated");
    expect(original[0].children.map((c) => c.label)).toEqual(["alpha", "zeta"]);
  });
});
