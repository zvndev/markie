import { describe, expect, it } from "vitest";
import {
  blockNameCandidates,
  commonRootDepth,
  deriveBlocks,
  pickBlockName,
} from "@/lib/projects/cluster";
import { DEFAULT_CLUSTERING } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

const HOUR = 3600_000;
const NOW = Date.parse("2026-08-26T12:00:00Z");
const file = (path: string, ageHours: number, dir = "/home/u/p/docs"): EngineFile => ({
  path,
  name: path.split("/").pop()!,
  dir,
  mtimeMs: NOW - ageHours * HOUR,
  birthtimeMs: NOW - ageHours * HOUR - HOUR,
  fmProject: null,
  fmBlock: null,
  repoName: null,
});

const countByBlock = (files: EngineFile[], byPath: Map<string, string>) => {
  const counts = new Map<string, number>();
  for (const f of files) {
    const id = byPath.get(f.path)!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

describe("deriveBlocks", () => {
  it("splits files into sessions at the gap threshold", () => {
    const files = [
      file("/a1.md", 1),
      file("/a2.md", 2), // session A
      file("/b1.md", 50),
      file("/b2.md", 51), // session B (48h gap)
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const ids = new Set(files.map((f) => res.byPath.get(f.path)));
    expect(ids.size).toBe(2);
    expect(res.byPath.get("/a1.md")).toBe(res.byPath.get("/a2.md"));
    expect(res.byPath.get("/b1.md")).toBe(res.byPath.get("/b2.md"));
  });

  it("names a cluster by its dominant folder", () => {
    const files = [
      file("/home/u/p/auth/a.md", 1, "/home/u/p/auth"),
      file("/home/u/p/auth/b.md", 2, "/home/u/p/auth"),
      file("/home/u/p/misc/c.md", 3, "/home/u/p/misc"),
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0].auto_name).toBe("auth");
  });

  it("falls back to the newest file's stem when no folder dominates", () => {
    const one = [file("/home/u/p/plan-v2.md", 1, "/home/u/p")];
    const res = deriveBlocks("P", one, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks[0].auto_name).toBe("plan-v2");
  });

  it("names by the newest stem when the folder is split evenly enough", () => {
    const files = [
      file("/home/u/p/a/one.md", 1, "/home/u/p/a"),
      file("/home/u/p/b/two.md", 2, "/home/u/p/b"),
      file("/home/u/p/c/three.md", 3, "/home/u/p/c"),
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks[0].auto_name).toBe("one");
  });

  it("names a second session in the same folder after its work, not with a counter", () => {
    // Two sessions weeks apart, both dominated by the same folder. The older
    // one takes the folder name; the newer must still say something.
    const files = [
      file("/home/u/p/auth/a.md", 1, "/home/u/p/auth"),
      file("/home/u/p/auth/b.md", 2, "/home/u/p/auth"),
      file("/home/u/p/auth/c.md", 200, "/home/u/p/auth"),
      file("/home/u/p/misc/d.md", 201, "/home/u/p/misc"),
    ];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const names = res.blocks.map((b) => b.auto_name);
    expect(names[0]).toBe("auth"); // ordered oldest first
    expect(names[1]).toBe("a"); // the newest file in the newer session
    expect(new Set(names).size).toBe(2);
    expect(res.blocks[0].block_id).toBe(res.byPath.get("/home/u/p/auth/c.md"));
  });

  it("records made and updated from the members, not the clock", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 3)];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(Date.parse(res.blocks[0].updated_at)).toBe(NOW - 1 * HOUR);
    expect(Date.parse(res.blocks[0].created_at)).toBe(NOW - 4 * HOUR); // birthtime of the oldest
  });

  it("keeps an unchanged file in its prior block (stability)", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 2)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const priorId = first.byPath.get("/a1.md")!;
    const prior = files.map((f) => ({
      path: f.path,
      block_id: first.byPath.get(f.path)!,
      mtime_ms: f.mtimeMs,
    }));
    // Re-derive with one NEW file inside the same window.
    const again = deriveBlocks(
      "P",
      [...files, file("/a3.md", 1.5)],
      prior,
      first.blocks,
      DEFAULT_CLUSTERING,
      () => NOW
    );
    expect(again.byPath.get("/a1.md")).toBe(priorId);
    expect(again.byPath.get("/a3.md")).toBe(priorId); // joined the near block
  });

  it("keeps the auto name a known block already had", () => {
    const files = [file("/home/u/p/auth/a.md", 1, "/home/u/p/auth")];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const prior = files.map((f) => ({
      path: f.path,
      block_id: first.byPath.get(f.path)!,
      mtime_ms: f.mtimeMs,
    }));
    const again = deriveBlocks(
      "P",
      files,
      prior,
      first.blocks.map((b) => ({ ...b, auto_name: "kept" })),
      DEFAULT_CLUSTERING,
      () => NOW
    );
    expect(again.blocks[0].auto_name).toBe("kept");
  });

  it("a file that moved leaves its prior block and reclusters", () => {
    const files = [file("/a1.md", 1)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const prior = [{ path: "/a1.md", block_id: first.byPath.get("/a1.md")!, mtime_ms: 0 }];
    const again = deriveBlocks("P", files, prior, first.blocks, DEFAULT_CLUSTERING, () => NOW);
    // Re-derived, but the deterministic id lands it back in the same block.
    expect(again.byPath.get("/a1.md")).toBe(first.byPath.get("/a1.md"));
  });

  it("routes members of a merged block to the merge target", () => {
    const files = [file("/a1.md", 1)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const merged = first.blocks.map((b) =>
      b.block_id === id ? { ...b, merged_into: "target" } : b
    );
    const prior = [{ path: "/a1.md", block_id: id, mtime_ms: files[0].mtimeMs }];
    const again = deriveBlocks("P", files, prior, merged, DEFAULT_CLUSTERING, () => NOW);
    expect(again.byPath.get("/a1.md")).toBe("target");
  });

  it("follows a chain of merges to its end", () => {
    const files = [file("/a1.md", 1)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const chain = [
      { ...first.blocks[0], merged_into: "mid" },
      { ...first.blocks[0], block_id: "mid", merged_into: "end" },
      { ...first.blocks[0], block_id: "end", merged_into: null },
    ];
    const prior = [{ path: "/a1.md", block_id: id, mtime_ms: files[0].mtimeMs }];
    expect(
      deriveBlocks("P", files, prior, chain, DEFAULT_CLUSTERING, () => NOW).byPath.get("/a1.md")
    ).toBe("end");
  });

  it("survives a merge cycle instead of spinning", () => {
    const files = [file("/a1.md", 1)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const cycle = [
      { ...first.blocks[0], merged_into: "other" },
      { ...first.blocks[0], block_id: "other", merged_into: id },
    ];
    const prior = [{ path: "/a1.md", block_id: id, mtime_ms: files[0].mtimeMs }];
    const res = deriveBlocks("P", files, prior, cycle, DEFAULT_CLUSTERING, () => NOW);
    expect(res.byPath.get("/a1.md")).toBeTruthy();
  });

  it("adapts the gap when a project would exceed the block cap", () => {
    // 40 files, one every 25 hours: gap 24h would make 40 blocks.
    const files = Array.from({ length: 40 }, (_, i) => file(`/f${i}.md`, i * 25));
    const res = deriveBlocks(
      "P",
      files,
      [],
      [],
      { ...DEFAULT_CLUSTERING, maxBlocksPerProject: 10 },
      () => NOW
    );
    const distinct = new Set(files.map((f) => res.byPath.get(f.path)));
    expect(distinct.size).toBeLessThanOrEqual(10);
    expect(res.blocks).toHaveLength(distinct.size);
  });

  it("adopts old ids by majority overlap when adaptation reclusters", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 2), file("/a3.md", 3)];
    const first = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const id = first.byPath.get("/a1.md")!;
    const prior = files.map((f) => ({ path: f.path, block_id: id, mtime_ms: f.mtimeMs }));
    // Force a full recluster by shrinking the cap to 1.
    const res = deriveBlocks(
      "P",
      files,
      prior,
      first.blocks,
      { ...DEFAULT_CLUSTERING, maxBlocksPerProject: 1 },
      () => NOW
    );
    expect(res.byPath.get("/a1.md")).toBe(id); // identity survived
  });

  it("splits a bulk-write cluster (fresh clone) into path-based blocks", () => {
    // 60 files stamped within 5 minutes by a git clone, in three folders.
    const MIN = 60_000;
    const files = Array.from({ length: 60 }, (_, i) => {
      const folder = ["src", "docs", "guides"][i % 3];
      return {
        ...file(`/home/u/repo/${folder}/f${i}.md`, 0, `/home/u/repo/${folder}`),
        mtimeMs: NOW - (i % 5) * MIN,
      };
    });
    const res = deriveBlocks("repo", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const counts = countByBlock(files, res.byPath);
    expect(counts.size).toBeGreaterThanOrEqual(3);
    // Concentration: no path block may swallow the project (audit gate is 40%).
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.ceil(files.length * 0.4));
    // Files from one folder share a block.
    expect(res.byPath.get(files[0].path)).toBe(res.byPath.get(files[3].path));
    // And each path block is named after its folder.
    expect(res.blocks.map((b) => b.auto_name).sort()).toEqual(["docs", "guides", "src"]);
  });

  it("does not bulk-split a small tight cluster (a real work session)", () => {
    const files = [file("/a1.md", 1), file("/a2.md", 1.01), file("/a3.md", 1.02)];
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const ids = new Set(files.map((f) => res.byPath.get(f.path)));
    expect(ids.size).toBe(1);
  });

  it("cuts a long even run at its pauses rather than shattering it", () => {
    // 60 files over four hours in one folder: no path signal to split on, and
    // one 60-file block would be the whole project. It should come apart into
    // a handful of even pieces, not sixty slivers.
    const files = Array.from({ length: 60 }, (_, i) => file(`/f${i}.md`, i * 0.07));
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    const counts = countByBlock(files, res.byPath);
    expect(counts.size).toBeGreaterThan(1);
    expect(counts.size).toBeLessThanOrEqual(4);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.floor(60 * 0.4));
  });

  it("leaves a small tight project as one block, gate or no gate", () => {
    // Under ten files the concentration rule says nothing, and three files
    // written together are one session, not three blocks.
    const files = Array.from({ length: 6 }, (_, i) => file(`/f${i}.md`, i * 0.01));
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(new Set(files.map((f) => res.byPath.get(f.path))).size).toBe(1);
  });

  it("cannot split files that share one instant and one folder, and says so by leaving them", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ ...file(`/f${i}.md`, 1) }));
    const res = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(new Set(files.map((f) => res.byPath.get(f.path))).size).toBe(1);
  });

  it("folds blocks back together when splitting overshoots the block cap", () => {
    // Twelve folders under one root, each a separate bulk-written batch: the
    // concentration split makes twelve blocks, the cap allows four.
    const files = Array.from({ length: 120 }, (_, i) => {
      const folder = `area${i % 12}`;
      return file(`/home/u/p/${folder}/f${i}.md`, (i % 12) * 100, `/home/u/p/${folder}`);
    });
    const res = deriveBlocks(
      "P",
      files,
      [],
      [],
      { ...DEFAULT_CLUSTERING, maxBlocksPerProject: 4 },
      () => NOW
    );
    const counts = countByBlock(files, res.byPath);
    expect(counts.size).toBeLessThanOrEqual(4);
    // Folding must not undo the concentration work it just did.
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(Math.floor(120 * 0.4));
  });

  it("folds clusters below min_files into the nearest neighbour", () => {
    // Three sessions days apart; the middle one holds a single file.
    const files = [
      file("/a1.md", 1),
      file("/a2.md", 2),
      file("/lonely.md", 100),
      file("/b1.md", 200),
      file("/b2.md", 201),
    ];
    const loose = deriveBlocks("P", files, [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(new Set(files.map((f) => loose.byPath.get(f.path))).size).toBe(3);

    const folded = deriveBlocks(
      "P",
      files,
      [],
      [],
      { ...DEFAULT_CLUSTERING, minFiles: 2 },
      () => NOW
    );
    expect(new Set(files.map((f) => folded.byPath.get(f.path))).size).toBe(2);
    // 100h from a1/a2, 100h from b1/b2: it lands with whichever is nearer,
    // and either way it is no longer alone.
    const lonelyBlock = folded.byPath.get("/lonely.md");
    expect(countByBlock(files, folded.byPath).get(lonelyBlock!)).toBeGreaterThan(1);
  });

  it("survives a project of one file", () => {
    const res = deriveBlocks("P", [file("/only.md", 1)], [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks).toHaveLength(1);
    expect(res.byPath.size).toBe(1);
  });

  it("survives a project of no files", () => {
    const res = deriveBlocks("P", [], [], [], DEFAULT_CLUSTERING, () => NOW);
    expect(res.blocks).toEqual([]);
    expect(res.byPath.size).toBe(0);
  });
});

describe("commonRootDepth", () => {
  it("counts the segments every file shares", () => {
    expect(
      commonRootDepth([
        { ...file("/x", 0, "/home/u/repo/src"), path: "/x" },
        { ...file("/y", 0, "/home/u/repo/docs"), path: "/y" },
      ])
    ).toBe(3); // home, u, repo
  });

  it("is zero for files with nothing in common", () => {
    expect(
      commonRootDepth([
        { ...file("/x", 0, "/a/b"), path: "/x" },
        { ...file("/y", 0, "/c/d"), path: "/y" },
      ])
    ).toBe(0);
  });
});

describe("block naming", () => {
  it("offers folder, branch, newest stem, then a dated session", () => {
    const members = [file("/home/u/p/auth/a.md", 1, "/home/u/p/auth")];
    expect(blockNameCandidates(members, 3, () => NOW)).toEqual([
      "auth",
      "auth",
      "a",
      "Work session 2026-08-26",
    ]);
  });

  it("takes the first name nobody has claimed", () => {
    expect(pickBlockName(["docs", "plan"], new Set(["docs"]))).toBe("plan");
    expect(pickBlockName(["docs", "plan"], new Set())).toBe("docs");
  });

  it("falls back to a numbered suffix only when every candidate is taken", () => {
    expect(pickBlockName(["docs", "plan"], new Set(["docs", "plan"]))).toBe("docs (2)");
    expect(pickBlockName(["docs"], new Set(["docs", "docs (2)"]))).toBe("docs (3)");
  });
});
