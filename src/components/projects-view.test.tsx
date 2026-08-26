import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// A file sitting directly in a container (~/Documents) has no project of its
// own, which is exactly how the Unfiled pile comes into existence.
const UNFILED_ROW = {
  path: "/home/u/Documents/orphan.md",
  name: "orphan.md",
  dir: "/home/u/Documents",
  mtimeMs: NOW - 4 * HOUR,
  birthtimeMs: NOW - 4 * HOUR,
  fmProject: null,
  fmBlock: null,
  repoName: null,
};

const state = (over: Record<string, unknown> = {}) => ({
  pins: [],
  blocks: [],
  projectNames: [],
  assignments: [],
  fingerprint: "fp",
  rulesKnownGood: null,
  rulesError: null,
  ...over,
});

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

// Every level below the index is one click down from it, so almost every test
// starts by walking there the way a person would.
async function openProject(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Open project ${name}` }));
}

// The header keeps navigation and search; everything else waits behind one
// quiet button, so the tests reach those actions the way a person does.
async function openHeaderMenu() {
  await userEvent.click(await screen.findByRole("button", { name: "More project actions" }));
}

beforeEach(() => {
  // The view remembers where you were, which is exactly what must not leak
  // from one test into the next.
  localStorage.clear();
});

describe("ProjectsView index", () => {
  it("lists projects most-recent-first and opens a file one level down", async () => {
    const onOpenPath = vi.fn();
    bridge();
    render(view({ onOpenPath }));
    const cards = await screen.findAllByRole("button", { name: /^Open project / });
    expect(cards[0]).toHaveAccessibleName("Open project Markie"); // newer first
    await openProject("Markie");
    await userEvent.click(await screen.findByText("plan.md"));
    expect(onOpenPath).toHaveBeenCalledWith("/home/u/Documents/Markie/plan.md");
  });

  it("does not drop you into a project you never chose", async () => {
    // The old view auto-selected one, and had to work around landing in the
    // folder holding the document Markie wrote itself. An index picks nothing,
    // so there is nothing to get wrong: every project is listed, and no file is
    // on screen until you say which project you meant.
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
    expect(await screen.findByRole("button", { name: "Open project Fresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open project Markie" })).toBeInTheDocument();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
    expect(screen.queryByText("Projects.md")).not.toBeInTheDocument();
  });

  it("shows the summary stats, and says the layer is virtual", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    const header = screen.getByRole("banner");
    expect(header.textContent).toMatch(/2\s*projects/);
    expect(header.textContent).toMatch(/5\s*files/);
    expect(header.textContent).toMatch(/0\s*unfiled/);
    expect(header.textContent).toMatch(/moves a file on disk/i);
  });

  it("filters the project list from the search box", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "thesis");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open project Markie" })).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Open project Thesis" })).toBeInTheDocument();
  });

  it("finds a project by a file inside it", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "ch1.md");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open project Markie" })).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "Open project Thesis" })).toBeInTheDocument();
  });

  it("says nothing matches rather than going blank", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    await userEvent.type(screen.getByRole("textbox", { name: /search/i }), "zzzz");
    expect(await screen.findByText(/No project or file matches that/)).toBeInTheDocument();
  });

  it("says the index is still being built rather than claiming there is nothing", async () => {
    bridge({ mdIndexScan: vi.fn(async () => ({ files: [], scannedAt: null })) });
    render(view());
    // Before that answer arrives it says it is organizing, which is also true
    // and also not "you have no markdown".
    expect(screen.getByRole("status").textContent).toMatch(/organizing/i);
    expect(await screen.findByText(/still finding your markdown/i)).toBeInTheDocument();
  });

  it("waits rather than showing a tree built without its metadata", async () => {
    bridge({
      mdIndexScan: vi.fn(async () => ({ files: ROWS, scannedAt: "now", metaPending: true })),
    });
    render(view());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/organizing your markdown/i)
    );
    expect(screen.queryByRole("button", { name: "Open project Markie" })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "Open project Markie" })).toBeInTheDocument();
  });

  it("writes a listing into Projects.md on request and says so", async () => {
    const api = bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    await openHeaderMenu();
    await userEvent.click(screen.getByRole("button", { name: /update listing/i }));
    await waitFor(() => expect(api.projectsWriteOverview).toHaveBeenCalled());
    const listing = (
      api.projectsWriteOverview as unknown as { mock: { calls: Array<[{ listing: string }]> } }
    ).mock.calls[0][0].listing;
    expect(listing).toMatch(/\*\*Markie\*\* \(3 files\)/);
    // Loose files are listed too, or the listing would not add up to the count.
    expect(listing).toMatch(/^ {2}- stray\.md$/m);
    expect(await screen.findByRole("status")).toHaveTextContent(/Listing written/);
  });

  it("opens Projects.md itself", async () => {
    const onOpenPath = vi.fn();
    bridge();
    render(view({ onOpenPath }));
    await screen.findByRole("button", { name: "Open project Markie" });
    await openHeaderMenu();
    await userEvent.click(screen.getByRole("button", { name: /open projects\.md/i }));
    expect(onOpenPath).toHaveBeenCalledWith("/home/u/Documents/Markie/Projects.md");
  });

  it("keeps the header to navigation, search, and one quiet menu", async () => {
    // Two sentence-long buttons naming a file used to sit beside the search
    // box at every level. They are the plumbing, and plumbing does not get to
    // compete with the thing people came to type in.
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    const header = screen.getByRole("banner");
    const labels = [...header.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent?.trim()
    );
    expect(labels).toEqual(["More project actions"]);
    await openHeaderMenu();
    expect(screen.getByRole("button", { name: /open projects\.md/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update listing/i })).toBeInTheDocument();
  });

  it("labels every control it puts on screen", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    for (const button of screen.getAllByRole("button")) {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      expect(name.trim(), button.outerHTML.slice(0, 120)).not.toBe("");
    }
  });

  it("keeps the rename control it hides at rest reachable from the keyboard", async () => {
    bridge();
    render(view());
    await screen.findByRole("button", { name: "Open project Markie" });
    const hidden = [...document.querySelectorAll("button")].filter((b) =>
      b.className.includes("opacity-0")
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const button of hidden) {
      expect(button.className).toMatch(/focus-visible:opacity-100/);
      expect(button.tabIndex).toBe(0);
      expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
    }
  });
});

describe("ProjectsView navigation", () => {
  it("names where you are in a breadcrumb and comes back from it", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Markie");
    await userEvent.click(screen.getByRole("button", { name: /back to all projects/i }));
    expect(await screen.findByRole("button", { name: "Open project Thesis" })).toBeInTheDocument();
  });

  it("goes back on the shortcut every Mac app uses for going up a level", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    await userEvent.keyboard("{Meta>}[[{/Meta}");
    expect(await screen.findByRole("button", { name: "Open project Thesis" })).toBeInTheDocument();
  });

  it("switches projects by going back and picking another", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /back to all projects/i }));
    await openProject("Thesis");
    expect(await screen.findByText("ch1.md")).toBeInTheDocument();
    expect(screen.queryByText("plan.md")).not.toBeInTheDocument();
  });

  it("says what the search covers, in the field, at both levels", async () => {
    bridge();
    render(view());
    expect(await screen.findByText("All projects")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search every project and file/i })).toBeInTheDocument();
    await openProject("Markie");
    expect(await screen.findByText("In Markie")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search inside Markie/i })).toBeInTheDocument();
  });

  it("searches only inside the project you are standing in", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    await userEvent.type(screen.getByRole("textbox", { name: /search inside/i }), "spec");
    await waitFor(() => expect(screen.queryByText("plan.md")).not.toBeInTheDocument());
    expect(screen.getByText("spec.md")).toBeInTheDocument();
    // A file in the other project is out of scope, however well it matches.
    expect(screen.queryByText("ch1.md")).not.toBeInTheDocument();
  });

  it("comes back to the project you were last in", async () => {
    bridge();
    const first = render(view());
    await openProject("Thesis");
    await screen.findByText("ch1.md");
    first.unmount();
    bridge();
    render(view());
    // Wait for the restore, not for the first heading to exist: the index
    // paints before the taxonomy can confirm the remembered project is real.
    expect(await screen.findByText("ch1.md")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Thesis");
  });

  it("lands at the index when the remembered project is gone", async () => {
    localStorage.setItem("markie.projects.at.v1", "project:DeletedLastWeek");
    bridge();
    render(view());
    expect(await screen.findByRole("button", { name: "Open project Markie" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Projects");
  });
});

describe("ProjectsView project level", () => {
  it("shows a file that clustered with nothing outside every block", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    const stray = await screen.findByText("stray.md");
    // Not a block of one wearing a card: it sits in the pane on its own.
    expect(stray.closest("[data-markie-project-block]")).toBeNull();
    // And it is still organizable, like any other row.
    expect(stray.closest("div.group")).not.toBeNull();
  });

  it("says what a run of loose files is, rather than leaving bare rows", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    const stray = await screen.findByText("stray.md");
    // The run is its own object: a container with the card's footprint, headed
    // by a caption that names and counts it the way a block header does.
    const run = stray.closest("[data-markie-project-loose]")!;
    expect(run.querySelector("[data-markie-project-block]")).toBeNull();
    const caption = screen.getByText("Not in a block");
    expect(caption.closest("[data-markie-project-loose]")).toBe(run);
    expect(caption.nextElementSibling!.textContent).toBe("1 file");
  });

  it("keeps every control it hides at rest reachable from the keyboard", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    // The block header's controls and metadata are a hover reveal. Anything
    // that starts at opacity-0 has to come back on focus, or the demotion has
    // quietly removed it for anyone not using a mouse.
    const hidden = [...document.querySelectorAll("button")].filter((b) =>
      b.className.includes("opacity-0")
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const button of hidden) {
      expect(button.className).toMatch(/focus-visible:opacity-100/);
      expect(button.tabIndex).toBe(0);
      expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
    }
  });

  it("starts the directory in a column rather than wherever the name ended", async () => {
    // Forty rows whose second column begins at forty different x positions is
    // a heap, not a list. The name owns a fixed share of the row so the
    // directory beside it always starts in the same place.
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    const names = [...document.querySelectorAll("[data-markie-project-file] button > span:first-child")];
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      expect(name.className).toContain("basis-[44%]");
      expect(name.className).toContain("shrink-0");
    }
  });

  it("leads with the file name and keeps the directory secondary", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    const name = await screen.findByText("plan.md");
    const row = name.closest("button")!;
    // The whole absolute path used to be printed on the row, forty identical
    // characters ahead of the one word that told the rows apart. Now the
    // shortened directory follows the name, and the full path is on the row.
    expect(row.textContent).toContain("…/Documents/Markie");
    expect(row.textContent).not.toContain("/home/u/Documents/Markie/plan.md");
    expect(row.getAttribute("title")).toBe("/home/u/Documents/Markie/plan.md");
  });

  it("orders blocks and loose files together, newest first", async () => {
    bridge();
    render(view());
    await openProject("Markie");
    await screen.findByText("stray.md");
    const pane = document.querySelector("[data-markie-projects-detail]")!;
    const text = pane.textContent ?? "";
    expect(text.indexOf("plan.md")).toBeLessThan(text.indexOf("stray.md"));
  });

  it("renames a block inline and persists the decision", async () => {
    const api = bridge();
    render(view());
    await openProject("Markie");
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
    await openProject("Markie");
    await screen.findByText("plan.md");
    await userEvent.click(screen.getAllByLabelText(/rename block/i)[0]);
    const input = screen.getByRole("textbox", { name: /block name/i });
    await userEvent.clear(input);
    await userEvent.type(input, "nope{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: /block name/i })).not.toBeInTheDocument()
    );
    expect(api.projectsBlockSet).not.toHaveBeenCalled();
    // Escape inside a field cancels the field. It does not also throw you back
    // to the index, which would lose the place you were working in.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Markie");
  });

  it("moves a file to another project from its row menu", async () => {
    const api = bridge();
    render(view());
    await openProject("Markie");
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
      projectsState: vi.fn(async () =>
        state({
          pins: [{ path: "/home/u/Documents/Markie/plan.md", project: "Markie", block_id: null }],
        })
      ),
    });
    render(view());
    await openProject("Markie");
    await screen.findByText("plan.md");
    await userEvent.click(screen.getByRole("button", { name: /organize plan\.md/i }));
    expect(screen.getByRole("button", { name: /unpin/i })).toBeInTheDocument();
  });

  it("marks a file the user moved so the pin is visible, not just remembered", async () => {
    bridge({
      projectsState: vi.fn(async () =>
        state({
          pins: [{ path: "/home/u/Documents/Markie/plan.md", project: "Markie", block_id: null }],
        })
      ),
    });
    render(view());
    await openProject("Markie");
    const row = (await screen.findByText("plan.md")).closest("div.group")!;
    expect(within(row as HTMLElement).getByText(/pinned/i)).toBeInTheDocument();
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
    await openProject("Markie");
    await screen.findByText("f0.md");
    expect(screen.queryByText("f59.md")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show all 60 files/i }));
    expect(await screen.findByText("f59.md")).toBeInTheDocument();
  });
});

describe("ProjectsView auto folders", () => {
  it("draws a view as a control, not as another project tile", async () => {
    // Two rounds of independent visual review said the folders still read as
    // containers while they shared the projects' card grammar. A chip is a
    // filter; a bordered tile in the same grid is a place.
    bridge();
    render(view());
    const chip = (await screen.findByText("Updated today")).closest("button")!;
    expect(chip.className).not.toContain("border");
    expect(chip.className).toContain("inline-flex");
    const card = (await screen.findByRole("button", { name: "Open project Markie" })).closest(
      "[data-markie-project-card]"
    )!;
    expect(card.className).toContain("border");
  });

  it("offers the three it ships, above the projects", async () => {
    bridge();
    render(view());
    expect(await screen.findByText("Updated today")).toBeInTheDocument();
    expect(screen.getByText("Updated in the past 3 days")).toBeInTheDocument();
    expect(screen.getByText("Updated in the past week")).toBeInTheDocument();
    const body = document.querySelector("[data-markie-projects-index]")!;
    const text = body.textContent ?? "";
    expect(text.indexOf("Auto folders")).toBeLessThan(text.indexOf("New project"));
  });

  it("adds the ones the user wrote into Projects.md", async () => {
    bridge({
      projectsConfig: vi.fn(async () => ({
        path: "/home/u/Documents/Markie/Projects.md",
        content: [
          "---",
          "markie_rules:",
          "  folders:",
          '    - name: Thesis chapters',
          '      match: "~/Documents/Thesis/**"',
          "---",
          "",
        ].join("\n"),
        created: false,
        home: "/home/u",
      })),
    });
    render(view());
    const chip = await screen.findByText("Thesis chapters");
    const control = chip.closest("button")!;
    expect(within(control).getByText("2")).toBeInTheDocument();
    // A chip carries its own rule, so nobody has to open it to find out what
    // it keeps, and it says where the user wrote it down.
    expect(control.getAttribute("title")).toMatch(/stored under ~\/Documents\/Thesis/);
    expect(control.getAttribute("title")).toMatch(/Defined in Projects\.md/);
  });

  it("shows a folder's files grouped by the project they are still in", async () => {
    bridge();
    render(view());
    await userEvent.click(await screen.findByText("Updated in the past week"));
    // The grouping is the explanation: the same file is in this folder and in
    // its project at once, and the heading it sits under says which.
    const group = await screen.findByRole("button", { name: "Open project Thesis" });
    const section = group.closest("[data-markie-folder-group]")!;
    expect(within(section as HTMLElement).getByText("ch1.md")).toBeInTheDocument();
    expect(screen.getByRole("banner").textContent).toMatch(/A view, not a place/i);
    // 900 hours old: outside the window, so it is not in this view at all.
    expect(screen.queryByText("stray.md")).not.toBeInTheDocument();
  });

  it("walks from a folder into the project a file belongs to", async () => {
    bridge();
    render(view());
    await userEvent.click(await screen.findByText("Updated in the past week"));
    await userEvent.click(await screen.findByRole("button", { name: "Open project Thesis" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Thesis");
    expect(screen.getByText("ch1.md")).toBeInTheDocument();
  });

  it("scopes the search to the folder you opened", async () => {
    bridge();
    render(view());
    await userEvent.click(await screen.findByText("Updated in the past week"));
    expect(await screen.findByText("In Updated in the past week")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /search inside/i }), "ch1");
    await waitFor(() => expect(screen.queryByText("plan.md")).not.toBeInTheDocument());
    expect(screen.getByText("ch1.md")).toBeInTheDocument();
  });
});

describe("ProjectsView project names", () => {
  it("renames a project from its card, and says nothing on disk moved", async () => {
    const api = bridge();
    render(view());
    await userEvent.click(
      await screen.findByRole("button", { name: "Rename project Markie" })
    );
    const input = screen.getByRole("textbox", { name: /rename project Markie/i });
    expect(screen.getByText(/Renaming changes nothing on disk/i)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "Markie app{Enter}");
    await waitFor(() =>
      expect(api.projectsProjectSet).toHaveBeenCalledWith({
        project: "Markie",
        customName: "Markie app",
      })
    );
  });

  it("renames a project from the breadcrumb it is named in", async () => {
    const api = bridge();
    render(view());
    await openProject("Thesis");
    await openHeaderMenu();
    await userEvent.click(await screen.findByRole("button", { name: /rename project/i }));
    const input = screen.getByRole("textbox", { name: /rename project Thesis/i });
    await userEvent.clear(input);
    await userEvent.type(input, "Dissertation{Enter}");
    await waitFor(() =>
      expect(api.projectsProjectSet).toHaveBeenCalledWith({
        project: "Thesis",
        customName: "Dissertation",
      })
    );
  });

  it("clearing the name hands the project back to what Markie derived", async () => {
    const api = bridge();
    render(view());
    await userEvent.click(
      await screen.findByRole("button", { name: "Rename project Markie" })
    );
    const input = screen.getByRole("textbox", { name: /rename project Markie/i });
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(api.projectsProjectSet).toHaveBeenCalledWith({
        project: "Markie",
        customName: null,
      })
    );
  });

  it("shows the name the user gave, not the one the machine derived", async () => {
    bridge({
      projectsState: vi.fn(async () =>
        state({
          projectNames: [
            {
              project: "Markie",
              custom_name: "Markie app",
              user_created: 0,
              created_at: new Date(NOW).toISOString(),
              updated_at: new Date(NOW).toISOString(),
            },
          ],
        })
      ),
    });
    render(view());
    expect(
      await screen.findByRole("button", { name: "Open project Markie app" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open project Markie" })).not.toBeInTheDocument();
  });

  it("makes a new empty project and says what to do with it", async () => {
    const api = bridge();
    render(view());
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    await userEvent.type(screen.getByRole("textbox", { name: /new project name/i }), "Q4 planning{Enter}");
    await waitFor(() => expect(api.projectsCreate).toHaveBeenCalledWith({ name: "Q4 planning" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Move files into it/i);
  });

  it("refuses a name a project already has, rather than making a second one", async () => {
    const api = bridge();
    render(view());
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    await userEvent.type(screen.getByRole("textbox", { name: /new project name/i }), "markie{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/already have a project/i);
    expect(api.projectsCreate).not.toHaveBeenCalled();
  });

  it("does not offer to rename Unfiled, which is the absence of a project", async () => {
    // Renaming it would present a system bucket as a normal one, and would
    // persist a stored name keyed on the literal "Unfiled".
    bridge({
      mdIndexScan: vi.fn(async () => ({ files: [...ROWS, UNFILED_ROW], scannedAt: "now" })),
    });
    render(view());
    expect(await screen.findByRole("button", { name: "Open project Unfiled" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename project Markie" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename project Unfiled" })
    ).not.toBeInTheDocument();
  });

  it("does not offer to rename Unfiled from inside it either", async () => {
    bridge({
      mdIndexScan: vi.fn(async () => ({ files: [...ROWS, UNFILED_ROW], scannedAt: "now" })),
    });
    render(view());
    await openProject("Unfiled");
    expect(await screen.findByText("orphan.md")).toBeInTheDocument();
    await openHeaderMenu();
    expect(screen.queryByRole("button", { name: /rename project/i })).not.toBeInTheDocument();
    // And a real project standing in the same place still offers it.
    await userEvent.click(screen.getByRole("button", { name: /back to all projects/i }));
    await openProject("Markie");
    await openHeaderMenu();
    expect(await screen.findByRole("button", { name: /rename project/i })).toBeInTheDocument();
  });

  it("never writes a file when a project is renamed or created", async () => {
    const api = bridge();
    render(view());
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    await userEvent.type(screen.getByRole("textbox", { name: /new project name/i }), "Ideas{Enter}");
    await waitFor(() => expect(api.projectsCreate).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole("button", { name: "Rename project Thesis" }));
    const input = screen.getByRole("textbox", { name: /rename project Thesis/i });
    await userEvent.clear(input);
    await userEvent.type(input, "Dissertation{Enter}");
    await waitFor(() => expect(api.projectsProjectSet).toHaveBeenCalled());
    // The whole point of a virtual project is that naming one is not a
    // filesystem operation.
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(api.saveFileAs).not.toHaveBeenCalled();
    expect(api.renameFile).not.toHaveBeenCalled();
    expect(api.wsRename).not.toHaveBeenCalled();
  });
});

describe("buildOverviewListing", () => {
  const project = (name: string, files: number, blocks: string[]): ProjectNode => ({
    key: name,
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
