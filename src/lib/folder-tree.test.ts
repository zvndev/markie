import { describe, expect, it } from "vitest";
import { buildFolderTree, countNodes, pathsToFiles, type FolderNode } from "./folder-tree";

const file = (path: string) => {
  const cut = path.lastIndexOf("/");
  return { path, name: path.slice(cut + 1), dir: path.slice(0, cut) };
};

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
      { path: "C:\\work\\notes\\a.md", name: "a.md", dir: "C:\\work\\notes" },
    ]);
    expect(tree[0].label).toBe("C:/work/notes");
  });

  it("is empty for no files", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("ignores a file with no directory rather than inventing a root", () => {
    expect(buildFolderTree([{ path: "a.md", name: "a.md", dir: "" }])).toEqual([]);
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
