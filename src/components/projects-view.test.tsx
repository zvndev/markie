import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import { ProjectsView, buildOverviewListing } from "@/components/projects-view";
import type { ProjectNode } from "@/lib/projects/taxonomy";

const NOW = Date.now();
const HOUR = 3600_000;
const ROWS = [
  {
    path: "/home/u/Documents/Markie/plan.md",
    name: "plan.md",
    dir: "/home/u/Documents/Markie",
    mtimeMs: NOW,
    birthtimeMs: NOW - 5000,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
  {
    path: "/home/u/Documents/Markie/spec.md",
    name: "spec.md",
    dir: "/home/u/Documents/Markie",
    mtimeMs: NOW - HOUR,
    birthtimeMs: NOW - 2 * HOUR,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
  // Written months before the pair above, so nothing clusters with it: this is
  // the loose file the detail pane has to show outside any block.
  {
    path: "/home/u/Documents/Markie/stray.md",
    name: "stray.md",
    dir: "/home/u/Documents/Markie",
    mtimeMs: NOW - 900 * HOUR,
    birthtimeMs: NOW - 901 * HOUR,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
  {
    path: "/home/u/Documents/Thesis/ch1.md",
    name: "ch1.md",
    dir: "/home/u/Documents/Thesis",
    mtimeMs: NOW - 50 * HOUR,
    birthtimeMs: null,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
  {
    path: "/home/u/Documents/Thesis/ch2.md",
    name: "ch2.md",
    dir: "/home/u/Documents/Thesis",
    mtimeMs: NOW - 51 * HOUR,
    birthtimeMs: null,
    fmProject: null,
    fmBlock: null,
    repoName: null,
  },
];

function bridge(over: Record<string, unknown> = {}) {
  return installBridge({
    projectsConfig: vi.fn(async () => ({
      path: "/home/u/Documents/Markie/Projects.md",
      content: "",
      created: false,
      home: "/home/u",
    })),
    mdIndexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now" })),
    ...over,
  } as never);
}

const view = (over: Partial<React.ComponentProps<typeof ProjectsView>> = {}) => (
  <ProjectsView onOpenPath={() => {}} refreshKey={0} {...over} />
);

describe("ProjectsView", () => {
  it("lists projects most-recent-first and opens a file", async () => {
    const onOpenPath = vi.fn();
    bridge();
    render(view({ onOpenPath }));
    const rows = await screen.findAllByRole("button", { name: /Markie|Thesis/ });
    expect(rows[0].textContent).toMatch(/Markie/); // newer first
    await userEvent.click(await screen.findByText("plan.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/home/u/Documents/Markie/plan.md");
  });

  it("opens on real work, not on the folder holding the document Markie wrote", async () => {
    // Projects.md is the newest file on a fresh machine, and its folder would
    // otherwise be the first thing the headline feature shows.
    bridge({
      mdIndexScan: vi.fn(async () => ({
        files: [
          {
            path: "/home/u/Documents/Fresh/Projects.md",
            name: "Projects.md",
            dir: "/home/u/Documents/Fresh",
            mtimeMs: NOW,
            birthtimeMs: NOW,
            fmProject: null,
            fmBlock: null,
            repoName: null,
          },
          ...ROWS,
        ],
        scannedAt: "now",
      })),
    });
    render(view());
    expect(await screen.findByText("plan.md")).toBeInTheDocument();
    expect(screen.queryByText("Projects.md")).not.toBeInTheDocument();
  });

  it("shows a file that clustered with nothing outside every block", async () => {
    bridge();
    render(view());
    const stray = await screen.findByText("stray.md");
    // Not a block of one wearing a card: it sits in the pane on its own.
    expect(stray.closest("[data-markie-project-block]")).toBeNull();
    // And it is still organizable, like any other row.
    expect(stray.closest("div.group")).not.toBeNull();
  });

  it("says what a run of loose files is, rather than leaving bare rows", async () => {
    bridge();
    render(view());
    const stray = await screen.findByText("stray.md");
    const run = stray.closest("[data-markie-project-file]")!.parentElement!;
    // The caption names the run and counts it, the way a block header does.
    const caption = screen.getByText("Not in a block");
    expect(caption.parentElement!.parentElement).toBe(run);
    expect(caption.nextElementSibling!.textContent).toBe("1 file");
  });

  it("keeps every control it hides at rest reachable from the keyboard", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    // This pass demoted the block header's controls and metadata to a hover
    // reveal. Anything that starts at opacity-0 has to come back on focus, or
    // the demotion has quietly removed it for anyone not using a mouse.
    const hidden = [...document.querySelectorAll("button")].filter((b) =>
      b.className.includes("opacity-0")
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const button of hidden) {
      expect(button.className).toMatch(/focus-visible:opacity-100/);
      expect(button.tabIndex).toBe(0);
      expect(
        button.getAttribute("aria-label") || button.textContent?.trim()
      ).toBeTruthy();
    }
  });

  it("orders blocks and loose files together, newest first", async () => {
    bridge();
    render(view());
    await screen.findByText("stray.md");
    const pane = document.querySelector(".min-h-0.overflow-y-auto.p-3")!;
    const text = pane.textContent ?? "";
    expect(text.indexOf("plan.md")).toBeLessThan(text.indexOf("stray.md"));
  });

  it("shows the summary stats, and says the layer is virtual", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    const header = screen.getByRole("banner");
    expect(header.textContent).toMatch(/2\s*projects/);
    expect(header.textContent).toMatch(/5\s*files/);
    expect(header.textContent).toMatch(/0\s*unfiled/);
    expect(header.textContent).toMatch(/moves a file on disk/i);
  });

  it("switches the detail pane when another project is picked", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /Thesis/ }));
    expect(await screen.findByText("ch1.md")).toBeInTheDocument();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
  });

  it("renames a block inline and persists the decision", async () => {
    const api = bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getAllByLabelText(/rename block/i)[0]);
    const input = screen.getByRole("textbox", { name: /block name/i });
    await userEvent.clear(input);
    await userEvent.type(input, "release planning{Enter}");
    await waitFor(() =>
      expect(api.projectsBlockSet).toHaveBeenCalledWith(
        expect.objectContaining({ customName: "release planning" })
      )
    );
  });

  it("cancels a rename on Escape without writing anything", async () => {
    const api = bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getAllByLabelText(/rename block/i)[0]);
    const input = screen.getByRole("textbox", { name: /block name/i });
    await userEvent.clear(input);
    await userEvent.type(input, "nope{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: /block name/i })).not.toBeInTheDocument()
    );
    expect(api.projectsBlockSet).not.toHaveBeenCalled();
  });

  it("moves a file to another project from its row menu", async () => {
    const api = bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /organize plan\.md/i }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /move to project/i }),
      "Thesis"
    );
    await waitFor(() =>
      expect(api.projectsPin).toHaveBeenCalledWith({
        path: "/home/u/Documents/Markie/plan.md",
        project: "Thesis",
        blockId: null,
      })
    );
  });

  it("offers Unpin only for a file the user actually moved", async () => {
    bridge({
      projectsState: vi.fn(async () => ({
        pins: [{ path: "/home/u/Documents/Markie/plan.md", project: "Markie", block_id: null }],
        blocks: [],
        assignments: [],
        fingerprint: "fp",
        rulesKnownGood: null,
        rulesError: null,
      })),
    });
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /organize plan\.md/i }));
    expect(screen.getByRole("button", { name: /unpin/i })).toBeInTheDocument();
  });

  it("writes a listing into Projects.md on request and says so", async () => {
    const api = bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /update listing/i }));
    await waitFor(() => expect(api.projectsWriteOverview).toHaveBeenCalled());
    const listing = (api.projectsWriteOverview as unknown as { mock: { calls: Array<[{ listing: string }]> } })
      .mock.calls[0][0].listing;
    expect(listing).toMatch(/\*\*Markie\*\* \(3 files\)/);
    // Loose files are listed too, or the listing would not add up to the count.
    expect(listing).toMatch(/^ {2}- stray\.md$/m);
    expect(await screen.findByRole("status")).toHaveTextContent(/Listing written/);
  });

  it("opens Projects.md itself", async () => {
    const onOpenPath = vi.fn();
    bridge();
    render(view({ onOpenPath }));
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /open projects\.md/i }));
    expect(onOpenPath).toHaveBeenCalledWith("/home/u/Documents/Markie/Projects.md");
  });

  it("filters everything from the search box", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "thesis");
    await waitFor(() => expect(screen.queryByText("plan.md")).not.toBeInTheDocument());
    expect(screen.getByText("ch1.md")).toBeInTheDocument();
  });

  it("says nothing matches rather than going blank", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "zzzz");
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("says the index is still being built rather than claiming there is nothing", async () => {
    bridge({ mdIndexScan: vi.fn(async () => ({ files: [], scannedAt: null })) });
    render(view());
    // Before that answer arrives it says it is organizing, which is also true
    // and also not "you have no markdown".
    expect(screen.getByRole("status").textContent).toMatch(/organizing/i);
    expect(await screen.findByText(/still finding your markdown/i)).toBeInTheDocument();
  });

  it("shows a readable slice of a huge block, and offers the rest", async () => {
    // One folder, one instant: a batch nothing can split, so it stays one
    // block and the pane has to cope with its size.
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...ROWS[0],
      path: `/home/u/Documents/Markie/f${i}.md`,
      name: `f${i}.md`,
    }));
    bridge({ mdIndexScan: vi.fn(async () => ({ files: many, scannedAt: "now" })) });
    render(view());
    await screen.findByText("f0.md");
    expect(screen.queryByText("f59.md")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show all 60 files/i }));
    expect(await screen.findByText("f59.md")).toBeInTheDocument();
  });

  it("waits rather than showing a tree built without its metadata", async () => {
    bridge({
      mdIndexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now", metaPending: true })),
    });
    render(view());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/organizing your markdown/i)
    );
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
  });

  it("surfaces a rules error without emptying the view", async () => {
    bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/p/Projects.md",
        content: "---\nmarkie_rules: [broken\n---\n",
        created: false,
        home: "/home/u",
      })),
    });
    render(view());
    expect(await screen.findByRole("alert")).toHaveTextContent(/rules error/i);
    expect(await screen.findByText("plan.md")).toBeInTheDocument();
  });

  it("labels every control it puts on screen", async () => {
    bridge();
    render(view());
    await screen.findByText("plan.md");
    for (const button of screen.getAllByRole("button")) {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      expect(name.trim(), button.outerHTML.slice(0, 120)).not.toBe("");
    }
  });

  it("marks a file the user moved so the pin is visible, not just remembered", async () => {
    bridge({
      projectsState: vi.fn(async () => ({
        pins: [{ path: "/home/u/Documents/Markie/plan.md", project: "Markie", block_id: null }],
        blocks: [],
        assignments: [],
        fingerprint: "fp",
        rulesKnownGood: null,
        rulesError: null,
      })),
    });
    render(view());
    const row = (await screen.findByText("plan.md")).closest("div.group")!;
    expect(within(row as HTMLElement).getByText(/pinned/i)).toBeInTheDocument();
  });
});

describe("buildOverviewListing", () => {
  const project = (name: string, files: number, blocks: string[]): ProjectNode => ({
    name,
    made: NOW,
    updated: NOW,
    fileCount: files,
    isUnfiled: false,
    looseFiles: [],
    blocks: blocks.map((b, i) => ({
      id: `b${i}`,
      name: b,
      made: NOW,
      updated: NOW,
      files: [],
    })),
  });

  it("writes projects with their blocks, in the order the taxonomy gave them", () => {
    const out = buildOverviewListing([project("Markie", 3, ["plans", "specs"])], NOW);
    expect(out).toContain("- **Markie** (3 files)");
    expect(out.indexOf("plans")).toBeLessThan(out.indexOf("specs"));
  });

  it("counts one file as a file", () => {
    expect(buildOverviewListing([project("Solo", 1, [])], NOW)).toContain("(1 file)");
  });

  it("says it is regenerated, so nobody edits it by hand", () => {
    expect(buildOverviewListing([], NOW)).toMatch(/regenerated/);
  });
});
