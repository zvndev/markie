import { describe, expect, it } from "vitest";
import { filterTaxonomy } from "@/lib/projects/search";
import type { Taxonomy } from "@/lib/projects/taxonomy";

const NOW = Date.now();
const HOUR = 3600_000;

const file = (name: string, dir: string, ageHours: number) => ({
  path: `${dir}/${name}`,
  name,
  dir,
  mtimeMs: NOW - ageHours * HOUR,
  birthtimeMs: NOW - ageHours * HOUR,
  fmProject: null,
  fmBlock: null,
  repoName: null,
});

const TAXONOMY: Taxonomy = {
  totalFiles: 6,
  unfiledCount: 1,
  ignoredCount: 0,
  assignmentRows: [],
  blockUpserts: [],
  projects: [
    {
      key: "Markie",
      name: "Markie",
      made: NOW - 5 * HOUR,
      updated: NOW,
      fileCount: 3,
      isUnfiled: false,
      looseFiles: [file("stray.md", "/p", 2)],
      blocks: [
        {
          id: "b1",
          name: "organized-workspace",
          made: NOW - 5 * HOUR,
          updated: NOW,
          files: [file("plan.md", "/p", 0), file("spec.md", "/p", 1)],
        },
      ],
    },
    {
      key: "Thesis",
      name: "Thesis",
      made: NOW - 100 * HOUR,
      updated: NOW - 50 * HOUR,
      fileCount: 2,
      isUnfiled: false,
      looseFiles: [],
      blocks: [
        {
          id: "b2",
          name: "chapter one",
          made: NOW - 100 * HOUR,
          updated: NOW - 50 * HOUR,
          files: [file("ch1.md", "/t", 50), file("ch2.md", "/t", 51)],
        },
      ],
    },
    {
      key: "Bookkeeping",
      name: "Bookkeeping",
      made: NOW - 400 * HOUR,
      updated: NOW - 300 * HOUR,
      fileCount: 1,
      isUnfiled: false,
      looseFiles: [],
      blocks: [
        {
          id: "b3",
          name: "receipts",
          made: NOW - 400 * HOUR,
          updated: NOW - 300 * HOUR,
          files: [file("jan.md", "/b", 300)],
        },
      ],
    },
  ],
};

describe("filterTaxonomy", () => {
  it("keeps a whole project when the project name matches", () => {
    const [p] = filterTaxonomy(TAXONOMY.projects, "markie");
    expect(p.blocks[0].files).toHaveLength(2);
  });

  it("keeps a whole block when the block name matches", () => {
    const [p] = filterTaxonomy(TAXONOMY.projects, "organized");
    expect(p.blocks[0].files).toHaveLength(2);
  });

  it("keeps only matching files and recounts the project", () => {
    const [p] = filterTaxonomy(TAXONOMY.projects, "spec.md");
    expect(p.blocks[0].files.map((f) => f.name)).toEqual(["spec.md"]);
    expect(p.fileCount).toBe(1);
  });

  it("matches on the full path, not just the file name", () => {
    expect(filterTaxonomy(TAXONOMY.projects, "/t/")).toHaveLength(1);
  });

  it("returns everything for an empty filter", () => {
    expect(filterTaxonomy(TAXONOMY.projects, "  ")).toBe(TAXONOMY.projects);
  });

  it("still finds a renamed project by the name the machine gave it", () => {
    // The user calls it "Markie"; the repository on disk is
    // markdown-viewer-zvn, and that is the word they will type when they are
    // thinking about the checkout rather than about the product.
    const renamed = TAXONOMY.projects.map((p) =>
      p.key === "Markie" ? { ...p, key: "markdown-viewer-zvn" } : p
    );
    expect(filterTaxonomy(renamed, "markdown-viewer").map((p) => p.name)).toEqual(["Markie"]);
  });
});
