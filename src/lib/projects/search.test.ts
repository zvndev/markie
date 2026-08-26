import { describe, expect, it } from "vitest";
import { filterProject, filterTaxonomy, substantialProjects } from "@/lib/projects/search";
import type { ProjectNode, Taxonomy } from "@/lib/projects/taxonomy";

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

describe("filterProject", () => {
  const project = TAXONOMY.projects[0];

  it("keeps a whole block when the block name matches", () => {
    expect(filterProject(project, "organized").blocks[0].files).toHaveLength(2);
  });

  it("keeps matching files across blocks and loose files, and recounts", () => {
    const found = filterProject(project, "stray");
    expect(found.blocks).toHaveLength(0);
    expect(found.looseFiles.map((f) => f.name)).toEqual(["stray.md"]);
    expect(found.fileCount).toBe(1);
  });

  it("does not treat the project's own name as a match", () => {
    // You are already inside it. Matching the container would answer "show me
    // everything", which is the state you just searched to leave.
    const found = filterProject(project, "markie");
    expect(found.fileCount).toBe(0);
  });

  it("returns the project untouched for an empty filter", () => {
    expect(filterProject(project, "  ")).toBe(project);
  });
});

describe("substantialProjects", () => {
  const p = (name: string, fileCount: number, isUnfiled = false) =>
    ({
      key: name,
      name,
      fileCount,
      isUnfiled,
      made: 0,
      updated: 0,
      blocks: [],
      looseFiles: [],
    }) as ProjectNode;

  it("skips the workspace folder holding only the document Markie wrote", () => {
    // Right after setup that folder is the newest thing on the machine, and
    // landing there shows the organization feature organizing nothing.
    const list = [p("Markie", 1), p("Thesis", 40), p("Notes", 12)];
    expect(substantialProjects(list).map((x) => x.name)).toEqual(["Thesis", "Notes"]);
  });

  it("skips Unfiled, which is the pile of things Markie could not place", () => {
    expect(
      substantialProjects([p("Unfiled", 90, true), p("Thesis", 40)]).map((x) => x.name)
    ).toEqual(["Thesis"]);
  });

  it("keeps recency order among the projects it does offer", () => {
    const list = [p("New", 5), p("Old", 500)];
    expect(substantialProjects(list).map((x) => x.name)).toEqual(["New", "Old"]);
  });

  it("still lands somewhere when every project is thin", () => {
    expect(substantialProjects([p("Markie", 1)]).map((x) => x.name)).toEqual(["Markie"]);
    expect(substantialProjects([p("Unfiled", 3, true)]).map((x) => x.name)).toEqual(["Unfiled"]);
    expect(substantialProjects([])).toEqual([]);
  });
});
