import { describe, expect, it } from "vitest";
import { buildTaxonomy } from "@/lib/projects/taxonomy";
import { parseRules } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

const HOME = "/home/u";
const NOW = Date.parse("2026-08-26T12:00:00Z");
const HOUR = 3600_000;
const f = (path: string, ageHours: number, over: Partial<EngineFile> = {}): EngineFile => ({
  path,
  name: path.split("/").pop()!,
  dir: path.split("/").slice(0, -1).join("/"),
  mtimeMs: NOW - ageHours * HOUR,
  birthtimeMs: NOW - ageHours * HOUR,
  fmProject: null,
  fmBlock: null,
  repoName: null,
  ...over,
});
const EMPTY = parseRules("").rules!;
const build = (files: EngineFile[], over: Partial<Parameters<typeof buildTaxonomy>[1]> = {}) =>
  buildTaxonomy(files, {
    pins: [],
    rules: EMPTY,
    priorAssignments: [],
    knownBlocks: [],
    home: HOME,
    now: () => NOW,
    ...over,
  });

describe("buildTaxonomy", () => {
  it("sorts projects, blocks, and files most-recent-first", () => {
    const files = [
      f("/home/u/Documents/Old/a.md", 100),
      f("/home/u/Documents/Fresh/b.md", 1),
      f("/home/u/Documents/Fresh/c.md", 2),
    ];
    const t = build(files);
    expect(t.projects.map((p) => p.name)).toEqual(["Fresh", "Old"]);
    expect(t.projects[0].blocks[0].files.map((x) => x.name)).toEqual(["b.md", "c.md"]);
  });

  it("groups front matter blocks under their declared names", () => {
    const files = [
      f("/home/u/anywhere/x.md", 1, { fmProject: "App", fmBlock: "auth" }),
      f("/home/u/elsewhere/y.md", 2, { fmProject: "App", fmBlock: "auth" }),
      f("/home/u/etc/z.md", 3, { fmProject: "App", fmBlock: "billing" }),
    ];
    const app = build(files).projects.find((p) => p.name === "App")!;
    expect(app.blocks.map((b) => b.name)).toEqual(["auth", "billing"]);
    expect(app.blocks[0].files).toHaveLength(2);
  });

  it("gives a front matter block a durable row so a rename has something to land on", () => {
    const files = [f("/home/u/anywhere/x.md", 1, { fmProject: "App", fmBlock: "auth" })];
    const t = build(files);
    const blockId = t.projects[0].blocks[0].id;
    expect(t.blockUpserts.map((b) => b.block_id)).toContain(blockId);
    expect(t.blockUpserts.find((b) => b.block_id === blockId)).toMatchObject({
      project: "App",
      auto_name: "auth",
      custom_name: null,
    });
  });

  it("applies custom names over auto names", () => {
    const files = [f("/home/u/Documents/P/a.md", 1), f("/home/u/Documents/P/b.md", 2)];
    const first = build(files);
    const blockId = first.assignmentRows[0].blockId!;
    const renamed = build(files, {
      priorAssignments: first.assignmentRows.map((r) => ({
        path: r.path,
        block_id: r.blockId,
        mtime_ms: r.mtimeMs,
      })),
      knownBlocks: first.blockUpserts.map((b) =>
        b.block_id === blockId ? { ...b, custom_name: "My Feature" } : b
      ),
    });
    expect(renamed.projects.find((x) => x.name === "P")!.blocks[0].name).toBe("My Feature");
  });

  it("keeps a rename on a front matter block too", () => {
    const files = [f("/home/u/anywhere/x.md", 1, { fmProject: "App", fmBlock: "auth" })];
    const first = build(files);
    const renamed = build(files, {
      knownBlocks: first.blockUpserts.map((b) => ({ ...b, custom_name: "Sign-in work" })),
    });
    expect(renamed.projects[0].blocks[0].name).toBe("Sign-in work");
  });

  it("reports unfiled count and marks the Unfiled project", () => {
    const t = build([f("/home/u/Desktop/loose.md", 1)]);
    expect(t.unfiledCount).toBe(1);
    expect(t.projects[0].isUnfiled).toBe(true);
  });

  it("sorts Unfiled by recency like any other project", () => {
    const t = build([f("/home/u/Desktop/loose.md", 1), f("/home/u/Documents/P/a.md", 100)]);
    expect(t.projects.map((p) => p.name)).toEqual(["Unfiled", "P"]);
  });

  it("counts files the rules told it to ignore, and shows none of them", () => {
    const rules = parseRules(`---\nmarkie_rules:\n  ignore:\n    - "~/skip/**"\n---\n`).rules!;
    const t = build([f("/home/u/skip/a.md", 1), f("/home/u/Documents/P/b.md", 1)], { rules });
    expect(t.ignoredCount).toBe(1);
    expect(t.totalFiles).toBe(1);
    expect(t.projects.map((p) => p.name)).toEqual(["P"]);
  });

  it("emits assignment rows suitable for the registry cache", () => {
    const files = [f("/home/u/Documents/P/a.md", 1), f("/home/u/Documents/P/b.md", 2)];
    const t = build(files);
    expect(t.assignmentRows[0]).toMatchObject({
      path: "/home/u/Documents/P/a.md",
      project: "P",
      source: "derived",
      mtimeMs: files[0].mtimeMs,
    });
    expect(t.assignmentRows[0].blockId).toBeTruthy();
    expect(t.assignmentRows).toHaveLength(t.totalFiles);
  });

  it("records where each assignment came from, not just where it landed", () => {
    const rules = parseRules(
      `---\nmarkie_rules:\n  rules:\n    - match: "~/code/**"\n      project: Ruled\n---\n`
    ).rules!;
    const files = [
      f("/home/u/code/a.md", 1),
      f("/home/u/Documents/P/b.md", 1),
      f("/home/u/anywhere/c.md", 1, { fmProject: "FM" }),
      f("/home/u/Documents/P/d.md", 1),
    ];
    const t = build(files, { rules, pins: [{ path: "/home/u/Documents/P/d.md", project: "Pinned", block_id: "pin-block" }] });
    const source = (p: string) => t.assignmentRows.find((r) => r.path === p)!.source;
    expect(source("/home/u/code/a.md")).toBe("rule");
    expect(source("/home/u/Documents/P/b.md")).toBe("derived");
    expect(source("/home/u/anywhere/c.md")).toBe("frontmatter");
    expect(source("/home/u/Documents/P/d.md")).toBe("pin");
  });

  it("puts a pinned file in the block it was pinned to", () => {
    const files = [f("/home/u/Documents/P/a.md", 1), f("/home/u/Documents/P/b.md", 1)];
    const t = build(files, {
      pins: [{ path: files[0].path, project: "P", block_id: "chosen" }],
    });
    const p = t.projects.find((x) => x.name === "P")!;
    const chosen = p.blocks.find((b) => b.id === "chosen")!;
    expect(chosen.files.map((x) => x.name)).toEqual(["a.md"]);
    expect(p.fileCount).toBe(2);
  });

  it("re-derivation with the same input is stable", () => {
    const files = [
      f("/home/u/Documents/P/a.md", 1),
      f("/home/u/Documents/P/b.md", 60),
      f("/home/u/Documents/Q/c.md", 2),
    ];
    const first = build(files);
    const second = build(files, {
      priorAssignments: first.assignmentRows.map((r) => ({
        path: r.path,
        block_id: r.blockId,
        mtime_ms: r.mtimeMs,
      })),
      knownBlocks: first.blockUpserts,
    });
    expect(second.assignmentRows).toEqual(first.assignmentRows);
    expect(second.projects.map((p) => p.blocks.map((b) => [b.id, b.name]))).toEqual(
      first.projects.map((p) => p.blocks.map((b) => [b.id, b.name]))
    );
  });

  it("survives an empty index", () => {
    const t = build([]);
    expect(t).toMatchObject({ projects: [], totalFiles: 0, unfiledCount: 0 });
  });

  it("handles 12k files in well under a second", () => {
    const files = Array.from({ length: 12_000 }, (_, i) =>
      f(`/home/u/Documents/P${i % 40}/d${i % 7}/f${i}.md`, (i % 500) / 3)
    );
    const started = performance.now();
    const t = build(files);
    const elapsed = performance.now() - started;
    expect(t.totalFiles).toBe(12_000);
    expect(elapsed).toBeLessThan(1000);
  });

  // 40% of the blocks the real index produced held exactly one file. A block
  // of one is a file with a folder drawn around it, and several hundred of
  // them are noise where organization was promised.
  describe("blocks of one", () => {
    it("puts a file that clustered with nothing under its project instead", () => {
      const t = build([f("/home/u/Documents/P/lonely.md", 1)]);
      const p = t.projects.find((x) => x.name === "P")!;
      expect(p.blocks).toHaveLength(0);
      expect(p.looseFiles.map((x) => x.name)).toEqual(["lonely.md"]);
      expect(p.fileCount).toBe(1);
    });

    it("says so in the cache row, so the file is free to join a block later", () => {
      const t = build([f("/home/u/Documents/P/lonely.md", 1)]);
      expect(t.assignmentRows).toEqual([
        expect.objectContaining({ path: "/home/u/Documents/P/lonely.md", blockId: null }),
      ]);
      expect(t.blockUpserts).toHaveLength(0);
    });

    it("keeps a block a document declared for itself, however small", () => {
      const t = build([
        f("/home/u/Documents/P/a.md", 1, { fmProject: "P", fmBlock: "Login rewrite" }),
      ]);
      const p = t.projects.find((x) => x.name === "P")!;
      expect(p.blocks.map((b) => b.name)).toEqual(["Login rewrite"]);
      expect(p.looseFiles).toHaveLength(0);
    });

    it("keeps a block the user pinned a file into", () => {
      const file = f("/home/u/Documents/P/a.md", 1);
      const t = build([file], { pins: [{ path: file.path, project: "P", block_id: "b_kept" }] });
      const p = t.projects.find((x) => x.name === "P")!;
      expect(p.blocks.map((b) => b.id)).toEqual(["b_kept"]);
      expect(p.looseFiles).toHaveLength(0);
    });

    it("keeps a block the user named, because a name is a decision", () => {
      const file = f("/home/u/Documents/P/a.md", 1);
      const t = build([file], {
        priorAssignments: [{ path: file.path, block_id: "b_kept", mtime_ms: file.mtimeMs }],
        knownBlocks: [
          {
            block_id: "b_kept",
            project: "P",
            auto_name: "A",
            custom_name: "My Feature",
            merged_into: null,
            created_at: new Date(NOW).toISOString(),
            updated_at: new Date(NOW).toISOString(),
          },
        ],
      });
      const p = t.projects.find((x) => x.name === "P")!;
      expect(p.blocks.map((b) => b.name)).toEqual(["My Feature"]);
      expect(p.looseFiles).toHaveLength(0);
    });

    it("dates a project from its loose files as well as its blocks", () => {
      const t = build([
        f("/home/u/Documents/P/old-a.md", 300),
        f("/home/u/Documents/P/old-b.md", 301),
        f("/home/u/Documents/P/fresh.md", 1),
      ]);
      const p = t.projects.find((x) => x.name === "P")!;
      expect(p.looseFiles.map((x) => x.name)).toEqual(["fresh.md"]);
      expect(p.updated).toBe(NOW - HOUR);
    });
  });
});
