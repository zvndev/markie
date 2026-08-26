import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectsTree, filterTaxonomy } from "@/components/projects-tree";
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
  totalFiles: 5,
  unfiledCount: 1,
  ignoredCount: 0,
  assignmentRows: [],
  blockUpserts: [],
  projects: [
    {
      name: "Markie",
      made: NOW - 5 * HOUR,
      updated: NOW,
      fileCount: 3,
      isUnfiled: false,
      // Nothing was written alongside this one, so it sits under the project
      // rather than inside a block of one.
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
      name: "Thesis",
      made: NOW - 100 * HOUR,
      updated: NOW - 50 * HOUR,
      fileCount: 1,
      isUnfiled: false,
      looseFiles: [],
      blocks: [
        {
          id: "b2",
          name: "chapter one",
          made: NOW - 100 * HOUR,
          updated: NOW - 50 * HOUR,
          files: [file("ch1.md", "/t", 50)],
        },
      ],
    },
    {
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

const tree = (over: Partial<React.ComponentProps<typeof ProjectsTree>> = {}) => (
  <ProjectsTree
    taxonomy={TAXONOMY}
    activePath={null}
    onOpenPath={() => {}}
    filter=""
    {...over}
  />
);

describe("ProjectsTree", () => {
  it("shows a loose file under its project, in with the blocks by recency", () => {
    render(tree());
    const stray = screen.getByText("stray.md");
    expect(stray.closest("[data-markie-project-block]")).toBeNull();
    const project = stray.closest("[data-markie-project]")!;
    const rows = [...project.querySelectorAll("button")].map((b) => b.textContent ?? "");
    // Markie's block was touched now; the loose file two hours ago.
    expect(rows.findIndex((t) => t.includes("organized-workspace"))).toBeLessThan(
      rows.findIndex((t) => t.includes("stray.md"))
    );
  });

  it("keeps loose files in view when filtering", () => {
    render(tree({ filter: "stray" }));
    expect(screen.getByText("stray.md")).toBeInTheDocument();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
  });

  it("opens the most recent work and leaves older projects folded", () => {
    render(tree());
    // Project one is open down to its newest block's files.
    expect(screen.getByText("organized-workspace")).toBeInTheDocument();
    expect(screen.getByText("plan.md")).toBeInTheDocument();
    // Project two is open but its blocks are folded.
    expect(screen.getByText("chapter one")).toBeInTheDocument();
    expect(screen.queryByText("ch1.md")).not.toBeInTheDocument();
    // Project three is folded entirely.
    expect(screen.getByText("Bookkeeping")).toBeInTheDocument();
    expect(screen.queryByText("receipts")).not.toBeInTheDocument();
  });

  it("expands a folded project and opens a file from it", async () => {
    const onOpenPath = vi.fn();
    render(tree({ onOpenPath }));
    await userEvent.click(screen.getByText("Bookkeeping"));
    await userEvent.click(screen.getByText("receipts"));
    await userEvent.click(screen.getByText("jan.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/b/jan.md");
  });

  it("folds a project that opened itself", async () => {
    render(tree());
    await userEvent.click(screen.getByText("Markie"));
    expect(screen.queryByText("organized-workspace")).not.toBeInTheDocument();
  });

  it("marks the open document", () => {
    render(tree({ activePath: "/p/spec.md" }));
    const active = screen.getByText("spec.md").closest("button")!;
    const other = screen.getByText("plan.md").closest("button")!;
    expect(active.className).toContain("bg-accent");
    expect(other.className).not.toContain("bg-accent ");
  });

  it("reaches every row by keyboard, and says what each one does", () => {
    render(tree());
    const project = screen.getByText("Markie").closest("button")!;
    expect(project.tagName).toBe("BUTTON");
    expect(project).toHaveAttribute("aria-expanded", "true");
    const block = screen.getByText("organized-workspace").closest("button")!;
    expect(block).toHaveAttribute("aria-expanded", "true");
    const fileRow = screen.getByText("plan.md").closest("button")!;
    expect(fileRow).toHaveAttribute("title", "/p/plan.md");
  });

  it("filters across projects, blocks, and file names", async () => {
    render(tree({ filter: "zzz" }));
    expect(screen.queryByText("Markie")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("opens everything a search matched rather than hiding it behind a fold", () => {
    render(tree({ filter: "jan" }));
    expect(screen.getByText("jan.md")).toBeInTheDocument();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
  });

  it("says the index is still being built instead of saying there is nothing", () => {
    render(tree({ taxonomy: { ...TAXONOMY, projects: [] }, scanning: true }));
    expect(screen.getByRole("status").textContent).toMatch(/still finding your markdown/i);
  });

  it("says it is organizing before the first tree exists", () => {
    render(tree({ taxonomy: null, loading: true }));
    expect(screen.getByRole("status").textContent).toMatch(/organizing/i);
  });

  it("refuses to draw a tree it knows is not ready yet", () => {
    // A taxonomy built before the repo names are read folds whole machines
    // into one folder-derived project. Better to say so than to show it.
    render(tree({ preparing: true }));
    expect(screen.getByRole("status").textContent).toMatch(/organizing/i);
    expect(screen.queryByText("Markie")).not.toBeInTheDocument();
  });

  it("invites the user in when there is genuinely nothing", () => {
    render(tree({ taxonomy: { ...TAXONOMY, projects: [] } }));
    expect(screen.getByText(/Open a file/)).toBeInTheDocument();
  });
});

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
});
