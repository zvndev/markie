import { describe, expect, it } from "vitest";
import {
  AUDIT_GATES,
  buildAuditReport,
  evaluateGates,
  largestBlockOf,
} from "@/lib/projects/audit";
import type { BlockNode, ProjectNode, Taxonomy } from "@/lib/projects/taxonomy";

const T0 = Date.UTC(2026, 0, 2, 12, 0, 0);

function block(id: string, count: number, name = id): BlockNode {
  return {
    id,
    name,
    made: T0,
    updated: T0,
    files: Array.from({ length: count }, (_, i) => ({
      path: `/w/${id}/${i}.md`,
      name: `${i}.md`,
      dir: `/w/${id}`,
      mtimeMs: T0,
      birthtimeMs: null,
      fmProject: null,
      fmBlock: null,
      repoName: null,
    })),
  };
}

function project(name: string, blocks: BlockNode[], isUnfiled = false): ProjectNode {
  return {
    name,
    made: T0,
    updated: T0,
    fileCount: blocks.reduce((n, b) => n + b.files.length, 0),
    blocks,
    isUnfiled,
  };
}

function taxonomy(projects: ProjectNode[], unfiled = 0, ignored = 0): Taxonomy {
  return {
    projects,
    totalFiles: projects.reduce((n, p) => n + p.fileCount, 0),
    unfiledCount: unfiled,
    ignoredCount: ignored,
    assignmentRows: [],
    blockUpserts: [],
  };
}

describe("largestBlockOf", () => {
  it("reports the biggest block and its share", () => {
    const p = project("App", [block("a", 3), block("b", 7)]);
    expect(largestBlockOf(p)).toEqual({ name: "b", files: 7, sharePct: 70 });
  });

  it("returns null for a project with no blocks", () => {
    expect(largestBlockOf(project("Empty", []))).toBeNull();
  });
});

describe("buildAuditReport", () => {
  it("counts projects, blocks, singletons and shares against organized files", () => {
    const t = taxonomy([project("App", [block("a", 1), block("b", 9)])], 2, 5);
    const r = buildAuditReport(t, {
      indexedFiles: 17,
      engineMs: 42,
      rulesError: null,
      now: () => T0,
    });
    expect(r.indexedFiles).toBe(17);
    expect(r.organizedFiles).toBe(10);
    expect(r.ignoredFiles).toBe(5);
    expect(r.projects).toBe(1);
    expect(r.blocks).toBe(2);
    expect(r.singletonBlocks).toBe(1);
    expect(r.singletonBlockPct).toBe(50);
    // 2 unfiled out of the 10 the engine placed, not out of the 17 read.
    expect(r.unfiledPct).toBe(20);
    expect(r.engineMs).toBe(42);
    expect(r.generatedAt).toBe(new Date(T0).toISOString());
  });

  it("ranks the largest blocks across every project", () => {
    const t = taxonomy([
      project("Small", [block("s", 2)]),
      project("Big", [block("g", 40)]),
    ]);
    const r = buildAuditReport(t, { indexedFiles: 42, engineMs: 1, rulesError: null, now: () => T0 });
    expect(r.largestBlocks.map((e) => e.project)).toEqual(["Big", "Small"]);
    expect(r.largestBlocks[0].largest.files).toBe(40);
  });

  it("carries a rules error through untouched", () => {
    const r = buildAuditReport(taxonomy([]), {
      indexedFiles: 0,
      engineMs: 0,
      rulesError: "bad indentation of a mapping entry",
      now: () => T0,
    });
    expect(r.rulesError).toBe("bad indentation of a mapping entry");
    expect(r.unfiledPct).toBe(0);
  });
});

describe("evaluateGates", () => {
  const report = (t: Taxonomy) =>
    buildAuditReport(t, { indexedFiles: t.totalFiles, engineMs: 0, rulesError: null, now: () => T0 });

  it("passes a healthy taxonomy", () => {
    const t = taxonomy([
      project("App", [block("a", 4), block("b", 4), block("c", 4)]),
      project("Docs", [block("d", 4), block("e", 4), block("f", 4)]),
    ]);
    expect(evaluateGates(t, report(t), 30)).toEqual([]);
  });

  it("fails when unfiled reaches 20 percent", () => {
    const t = taxonomy([project("App", [block("a", 10)])], 2);
    const failures = evaluateGates(t, report(t), 30);
    expect(failures.map((f) => f.gate)).toContain("unfiled");
  });

  it("accepts unfiled just under the threshold", () => {
    const t = taxonomy([project("App", [block("a", 5), block("b", 5), block("c", 5), block("d", 5)])], 3);
    // 3 of 20 is 15%, under the gate.
    expect(evaluateGates(t, report(t), 30).map((f) => f.gate)).not.toContain("unfiled");
  });

  it("fails when one block holds more than 40 percent of a project of ten or more", () => {
    const t = taxonomy([project("App", [block("a", 5), block("b", 5)])]);
    const failures = evaluateGates(t, report(t), 30);
    expect(failures.map((f) => f.gate)).toContain("concentration-share");
    expect(failures[0].message).toContain("of project \"App\"");
  });

  it("ignores concentration in projects under ten files", () => {
    const t = taxonomy([project("Tiny", [block("a", 9)])]);
    expect(evaluateGates(t, report(t), 30)).toEqual([]);
  });

  it("fails on the absolute block ceiling even when the share is fine", () => {
    const t = taxonomy([
      project("Huge", [block("a", AUDIT_GATES.blockCeiling + 1), block("b", 2000)]),
    ]);
    const gates = evaluateGates(t, report(t), 30).map((f) => f.gate);
    expect(gates).toContain("concentration-ceiling");
  });

  it("fails when a project exceeds the block cap", () => {
    const blocks = Array.from({ length: 31 }, (_, i) => block(`b${i}`, 2));
    const t = taxonomy([project("Busy", blocks)]);
    const failures = evaluateGates(t, report(t), 30);
    expect(failures.map((f) => f.gate)).toContain("block-cap");
    expect(failures.find((f) => f.gate === "block-cap")?.message).toContain("Busy (31)");
  });
});
