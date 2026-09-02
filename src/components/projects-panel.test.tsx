import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsPanel } from "@/components/projects-panel";
import type { ProjectNode } from "@/lib/projects/taxonomy";

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

const PROJECTS: ProjectNode[] = [
  {
    key: "Markie",
    name: "Markie",
    made: NOW - 5 * HOUR,
    updated: NOW,
    fileCount: 3,
    isUnfiled: false,
    looseFiles: [file("stray.md", "/Users/test/code/markie", 2)],
    blocks: [
      {
        id: "b1",
        name: "release",
        made: NOW - 5 * HOUR,
        updated: NOW,
        files: [file("plan.md", "/Users/test/code/markie", 0), file("spec.md", "/Users/test/code/markie", 1)],
      },
    ],
  },
  {
    key: "Thesis",
    name: "Thesis",
    made: NOW - 100 * HOUR,
    updated: NOW - 50 * HOUR,
    fileCount: 1,
    isUnfiled: false,
    looseFiles: [file("ch1.md", "/Users/test/Documents/thesis", 50)],
    blocks: [],
  },
  {
    key: "__unfiled__",
    name: "Unfiled",
    made: NOW - 3 * HOUR,
    updated: NOW - 3 * HOUR,
    fileCount: 1,
    isUnfiled: true,
    looseFiles: [file("scratch.md", "/Users/test", 3)],
    blocks: [],
  },
];

function panel(props: Partial<React.ComponentProps<typeof ProjectsPanel>> = {}) {
  return (
    <ProjectsPanel
      projects={PROJECTS}
      home="/Users/test"
      activePath={null}
      onOpenPath={vi.fn()}
      onOpenConfig={vi.fn()}
      configPath="/Users/test/Markie/Projects.md"
      rulesError={null}
      scanning={false}
      preparing={false}
      {...props}
    />
  );
}

describe("ProjectsPanel", () => {
  it("lists projects collapsed, so the panel opens as a list and not a wall", async () => {
    render(panel());
    expect(await screen.findByRole("button", { name: /Markie/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByRole("button", { name: /plan\.md/ })).toBeNull();
  });

  it("expands a project to its files, newest first", async () => {
    render(panel());
    await userEvent.click(screen.getByRole("button", { name: /Markie/ }));
    const names = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((t) => t.includes(".md"));
    expect(names[0]).toContain("plan.md");
    expect(names[1]).toContain("spec.md");
    expect(names[2]).toContain("stray.md");
  });

  it("searches project names and file names with one field", async () => {
    render(panel());
    const search = screen.getByLabelText("Search projects and files");

    // A file name reaches its project without the project being named.
    await userEvent.type(search, "ch1");
    expect(screen.getByRole("button", { name: /Thesis/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^▶?\s*Markie/ })).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "markie");
    expect(screen.getByRole("button", { name: /Markie/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Thesis/ })).toBeNull();
  });

  it("opens every match while searching, since a hit you must click is not a hit", async () => {
    render(panel());
    await userEvent.type(screen.getByLabelText("Search projects and files"), "spec");
    expect(screen.getByRole("button", { name: /spec\.md/ })).toBeInTheDocument();
  });

  it("says so when nothing matches rather than showing an empty list", async () => {
    render(panel());
    await userEvent.type(screen.getByLabelText("Search projects and files"), "zzzz");
    expect(screen.getByText("Nothing matches that.")).toBeInTheDocument();
  });

  it("opens the file that was clicked", async () => {
    const onOpenPath = vi.fn();
    render(panel({ onOpenPath }));
    await userEvent.click(screen.getByRole("button", { name: /Thesis/ }));
    await userEvent.click(screen.getByRole("button", { name: /ch1\.md/ }));
    expect(onOpenPath).toHaveBeenCalledWith("/Users/test/Documents/thesis/ch1.md");
  });

  it("names a directory only where it differs from the rest of the project", async () => {
    // Printing the same directory under all three Markie files is a line of
    // noise repeated three times. The full path is still on the row for
    // anyone who wants it.
    render(panel());
    await userEvent.click(screen.getByRole("button", { name: /Markie/ }));
    const row = screen.getByRole("button", { name: /plan\.md/ });
    expect(row.textContent).toBe("plan.md");
    expect(row).toHaveAttribute("title", "/Users/test/code/markie/plan.md");
  });

  it("names the directory of a file that sits apart from its project", async () => {
    const scattered: ProjectNode[] = [
      {
        ...PROJECTS[0],
        looseFiles: [
          file("stray.md", "/Users/test/code/markie", 2),
          file("elsewhere.md", "/Users/test/Desktop", 4),
        ],
        blocks: [],
        fileCount: 2,
      },
    ];
    render(panel({ projects: scattered }));
    await userEvent.click(screen.getByRole("button", { name: /Markie/ }));
    expect(
      within(screen.getByRole("button", { name: /elsewhere\.md/ })).getByText("~/Desktop")
    ).toBeInTheDocument();
  });

  it("opens the project holding the document you are reading", async () => {
    // The panel sitting beside an open file with everything shut reads as a
    // panel that does not know what you are looking at.
    render(panel({ activePath: "/Users/test/Documents/thesis/ch1.md" }));
    expect(await screen.findByRole("button", { name: /ch1\.md/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thesis/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("button", { name: /Markie/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("marks the open document so you can see where you are", async () => {
    render(panel({ activePath: "/Users/test/Documents/thesis/ch1.md" }));
    expect((await screen.findByRole("button", { name: /ch1\.md/ })).className).toContain(
      "bg-accent"
    );
  });

  it("distinguishes scanning from having no projects", () => {
    const { unmount } = render(panel({ projects: [], scanning: true }));
    expect(screen.getByText("Still finding your markdown…")).toBeInTheDocument();
    unmount();
    render(panel({ projects: [], scanning: false }));
    expect(screen.getByText("No projects yet.")).toBeInTheDocument();
  });

  it("surfaces a broken Projects.md instead of silently ignoring the rules", () => {
    render(panel({ rulesError: "Projects.md line 4: unknown rule" }));
    expect(screen.getByRole("alert")).toHaveTextContent("unknown rule");
  });

  it("offers the config file, which is where the organizing is actually edited", async () => {
    const onOpenConfig = vi.fn();
    render(panel({ onOpenConfig }));
    await userEvent.click(screen.getByRole("button", { name: "Edit how this is organized" }));
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
  });

  it("hides the config link when there is no config file to open", () => {
    render(panel({ configPath: null }));
    expect(screen.queryByRole("button", { name: "Edit how this is organized" })).toBeNull();
  });
});
