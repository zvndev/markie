import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Catalog,
  CatalogSkill,
  ElectronAPI,
  InstalledSkill,
  MdRow,
  MdScanResult,
  SkillSource,
} from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import { SkillsView } from "./skills-view";

const HOME = "/Users/me";

const mdRow = (path: string): MdRow => {
  const segments = path.split("/");
  return {
    path,
    name: segments[segments.length - 1],
    dir: segments.slice(0, -1).join("/"),
    mtimeMs: 1,
  };
};

const scan = (files: MdRow[]): MdScanResult => ({ files, scannedAt: "2026-09-07T12:00:00.000Z" });

const source = (id: string, over: Partial<SkillSource> = {}): SkillSource => {
  const [owner, repo] = id.split("/");
  return {
    id,
    owner,
    repo,
    ref: "main",
    commit: "41bbe19d",
    fetchedAt: "2026-09-07T12:00:00.000Z",
    builtin: true,
    error: null,
    ...over,
  };
};

const skill = (over: Partial<CatalogSkill> = {}): CatalogSkill => ({
  id: "anthropics/skills/pdf",
  source: "anthropics/skills",
  skillPath: "pdf",
  name: "pdf",
  description: "Fill in and read PDF forms.",
  license: "MIT",
  compatibility: "Claude Code, Codex",
  allowedTools: "Bash(git:*) Read",
  metadata: {},
  files: [],
  folderHash: "a".repeat(64),
  installedTo: [],
  ...over,
});

const installedSkill = (over: Partial<InstalledSkill> = {}): InstalledSkill => ({
  name: "pdf",
  target: "claude",
  path: `${HOME}/.claude/skills/pdf`,
  description: "Fill in and read PDF forms.",
  source: "anthropics/skills",
  folderHash: "a".repeat(64),
  updateAvailable: false,
  installedByMarkie: true,
  ...over,
});

const catalog = (over: Partial<Catalog> = {}): Catalog => ({
  sources: [source("anthropics/skills")],
  skills: [skill()],
  ...over,
});

function renderSkills(overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({
    mdIndexScan: vi.fn(async () => scan([])),
    mdIndexStars: vi.fn(async () => []),
    ...overrides,
  } as Partial<ElectronAPI>);
  const onOpenPath = vi.fn();
  render(<SkillsView onOpenPath={onOpenPath} activePath={null} />);
  return { api, onOpenPath };
}

const openDiscover = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Discover" }));
};

/** The Discover row for one catalog id. Rows carry the id, not a label. */
const catalogRow = (id: string) =>
  document.querySelector(`[data-skills-row="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  localStorage.clear();
});

describe("the two tabs", () => {
  it("opens on Installed and moves to Discover", async () => {
    const user = userEvent.setup();
    renderSkills({
      mdIndexScan: vi.fn(async () => scan([mdRow(`${HOME}/.claude/skills/pdf/SKILL.md`)])),
      skillsCatalogList: vi.fn(async () => catalog()),
    });

    expect(await screen.findByText("pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Installed" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await openDiscover(user);
    expect(await screen.findByText("Fill in and read PDF forms.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discover" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("opens on the tab it was left on", async () => {
    localStorage.setItem("markie.skills.tab.v1", "discover");
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()) });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Discover" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
  });

  it("remembers the tab it was moved to", async () => {
    const user = userEvent.setup();
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()) });
    await openDiscover(user);
    expect(localStorage.getItem("markie.skills.tab.v1")).toBe("discover");
  });
});

describe("Installed", () => {
  const rows = [
    mdRow(`${HOME}/.claude/skills/pdf/SKILL.md`),
    mdRow(`${HOME}/.claude/skills/pdf/references/forms.md`),
    mdRow(`${HOME}/.cursor/skills/notes/SKILL.md`),
    mdRow(`${HOME}/.agents/skills/shared/SKILL.md`),
    mdRow(`${HOME}/.claude/CLAUDE.md`),
  ];

  it("groups every tool's skills folder, including the three Markie only just started reading", async () => {
    renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)) });

    expect(await screen.findByText("pdf")).toBeInTheDocument();
    for (const label of ["Claude", "Cursor", "Universal"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("shared")).toBeInTheDocument();
  });

  it("folds a skill folder to one row", async () => {
    renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)) });
    await screen.findByText("pdf");
    // Two files in the pdf folder, one row, and the row says so.
    expect(screen.getAllByText("pdf")).toHaveLength(1);
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("shows a skill Markie installed with its source and its description", async () => {
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled: vi.fn(async () => [installedSkill()]),
    });
    expect(await screen.findByText("from anthropics/skills")).toBeInTheDocument();
    expect(screen.getByText("Fill in and read PDF forms.")).toBeInTheDocument();
  });

  it("says when an update is waiting instead", async () => {
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled: vi.fn(async () => [installedSkill({ updateAvailable: true })]),
    });
    expect(await screen.findByText("update available")).toBeInTheDocument();
    expect(screen.queryByText("from anthropics/skills")).not.toBeInTheDocument();
  });

  it("offers Remove only for the folders Markie wrote", async () => {
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled: vi.fn(async () => [installedSkill()]),
    });
    expect(await screen.findByRole("button", { name: "Remove pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove notes" })).not.toBeInTheDocument();
  });

  it("opens the SKILL.md, not the folder", async () => {
    const user = userEvent.setup();
    const { onOpenPath } = renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)) });
    await user.click(await screen.findByText("notes"));
    expect(onOpenPath).toHaveBeenCalledWith(`${HOME}/.cursor/skills/notes/SKILL.md`);
  });

  it("reveals the skill in the file manager", async () => {
    const user = userEvent.setup();
    const revealFile = vi.fn(async () => ({ ok: true }));
    renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)), revealFile });
    await user.click(await screen.findByRole("button", { name: "Show in Finder: pdf" }));
    expect(revealFile).toHaveBeenCalledWith(`${HOME}/.claude/skills/pdf/SKILL.md`);
  });

  it("updates through the catalog entry the install came from, then re-reads the list", async () => {
    const user = userEvent.setup();
    const skillsInstall = vi.fn(async () => ({ installed: [], errors: [] }));
    const skillsInstalled = vi.fn(async () => [installedSkill({ updateAvailable: true })]);
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled,
      skillsInstall,
      skillsCatalogList: vi.fn(async () =>
        catalog({
          skills: [
            skill({
              installedTo: [
                { target: "claude", path: `${HOME}/.claude/skills/pdf`, upToDate: false },
              ],
            }),
          ],
        })
      ),
    });

    await user.click(await screen.findByRole("button", { name: "Update pdf" }));
    expect(skillsInstall).toHaveBeenCalledWith("anthropics/skills/pdf", ["claude"]);
    await waitFor(() => expect(skillsInstalled).toHaveBeenCalledTimes(2));
  });

  it("asks before removing, then removes by target and name and re-reads the list", async () => {
    const user = userEvent.setup();
    const skillsRemove = vi.fn(async () => ({ ok: true }));
    const skillsInstalled = vi.fn(async () => [installedSkill()]);
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled,
      skillsRemove,
    });

    await user.click(await screen.findByRole("button", { name: "Remove pdf" }));
    expect(skillsRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm removing pdf" }));
    expect(skillsRemove).toHaveBeenCalledWith("claude", "pdf");
    await waitFor(() => expect(skillsInstalled).toHaveBeenCalledTimes(2));
  });

  it("says why a removal was refused rather than pretending it worked", async () => {
    const user = userEvent.setup();
    renderSkills({
      mdIndexScan: vi.fn(async () => scan(rows)),
      skillsInstalled: vi.fn(async () => [installedSkill()]),
      skillsRemove: vi.fn(async () => ({ ok: false, error: "Markie did not install that folder." })),
    });
    await user.click(await screen.findByRole("button", { name: "Remove pdf" }));
    await user.click(screen.getByRole("button", { name: "Confirm removing pdf" }));
    expect(await screen.findByText("Markie did not install that folder.")).toBeInTheDocument();
  });

  it("opens with Skills showing and everything else folded", async () => {
    renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)) });
    await screen.findByText("pdf");
    // Three tools have skills here, and every one of those sections is open.
    const open = screen.getAllByRole("button", { name: /Skills/ });
    expect(open).toHaveLength(3);
    for (const section of open) expect(section).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Instructions/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("CLAUDE.md")).not.toBeInTheDocument();
  });
});

describe("Discover", () => {
  it("lists what is downloaded, with source, licence and where it is installed", async () => {
    const user = userEvent.setup();
    renderSkills({
      skillsCatalogList: vi.fn(async () =>
        catalog({
          skills: [
            skill({
              license: "Complete terms: All Rights Reserved",
              installedTo: [
                { target: "claude", path: `${HOME}/.claude/skills/pdf`, upToDate: true },
              ],
            }),
          ],
        })
      ),
    });
    await openDiscover(user);

    await screen.findByText("pdf");
    const row = catalogRow("anthropics/skills/pdf") as HTMLElement;
    expect(within(row).getByText("anthropics/skills")).toBeInTheDocument();
    expect(within(row).getByText("Proprietary")).toBeInTheDocument();
    expect(within(row).getByText("Claude Code")).toBeInTheDocument();
  });

  it("filters the loaded catalog by name and description as you type", async () => {
    const user = userEvent.setup();
    renderSkills({
      skillsCatalogList: vi.fn(async () =>
        catalog({
          skills: [
            skill(),
            skill({
              id: "anthropics/skills/xlsx",
              skillPath: "xlsx",
              name: "xlsx",
              description: "Read and write spreadsheets.",
            }),
          ],
        })
      ),
    });
    await openDiscover(user);
    await screen.findByText("pdf");

    await user.type(screen.getByLabelText("Search skills"), "spreadsheet");
    await waitFor(() => expect(screen.queryByText("pdf")).not.toBeInTheDocument());
    expect(screen.getByText("xlsx")).toBeInTheDocument();
  });

  it("widens the search to skills.sh after the debounce", async () => {
    const user = userEvent.setup();
    const skillsSearch = vi.fn(async () => [
      { id: "obra/superpowers/brainstorming", name: "brainstorming", source: "obra/superpowers", installs: 812 },
    ]);
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()), skillsSearch });
    await openDiscover(user);
    await screen.findByText("pdf");

    await user.type(screen.getByLabelText("Search skills"), "brain");
    expect(await screen.findByText("From skills.sh")).toBeInTheDocument();
    expect(screen.getByText("brainstorming")).toBeInTheDocument();
    expect(screen.getByText("812 installs")).toBeInTheDocument();
    expect(skillsSearch).toHaveBeenCalledWith("brain");
  });

  it("leaves skills.sh alone for a single character", async () => {
    const user = userEvent.setup();
    const skillsSearch = vi.fn(async () => []);
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()), skillsSearch });
    await openDiscover(user);
    await screen.findByText("pdf");

    await user.type(screen.getByLabelText("Search skills"), "p");
    await new Promise((r) => setTimeout(r, 400));
    expect(skillsSearch).not.toHaveBeenCalled();
  });

  it("simply has no skills.sh group when the search fails", async () => {
    const user = userEvent.setup();
    renderSkills({
      skillsCatalogList: vi.fn(async () => catalog()),
      skillsSearch: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    await openDiscover(user);
    await screen.findByText("pdf");

    await user.type(screen.getByLabelText("Search skills"), "brain");
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByText("From skills.sh")).not.toBeInTheDocument();
  });

  it("adds the repository behind a skills.sh hit before opening it", async () => {
    const user = userEvent.setup();
    const hit = {
      id: "obra/superpowers/brainstorming",
      name: "brainstorming",
      source: "obra/superpowers",
      installs: 812,
    };
    const skillsCatalogAddSource = vi.fn(async () =>
      catalog({
        sources: [source("anthropics/skills"), source("obra/superpowers", { builtin: false })],
        skills: [skill(), skill({ id: hit.id, source: hit.source, skillPath: "brainstorming", name: "brainstorming" })],
      })
    );
    renderSkills({
      skillsCatalogList: vi.fn(async () => catalog()),
      skillsSearch: vi.fn(async () => [hit]),
      skillsCatalogAddSource,
      skillsRead: vi.fn(async () => ({ body: "How to brainstorm.", files: [] })),
    });
    await openDiscover(user);
    await screen.findByText("pdf");
    await user.type(screen.getByLabelText("Search skills"), "brain");

    await user.click(await screen.findByText("brainstorming"));
    expect(skillsCatalogAddSource).toHaveBeenCalledWith("obra/superpowers");
    expect(await screen.findByRole("button", { name: "‹ Back to skills" })).toBeInTheDocument();
  });

  it("refreshes on demand", async () => {
    const user = userEvent.setup();
    const skillsCatalogRefresh = vi.fn(async () => catalog());
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()), skillsCatalogRefresh });
    await openDiscover(user);
    await screen.findByText("pdf");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(skillsCatalogRefresh).toHaveBeenCalledWith();
  });

  it("shows a source's own error where the source is named", async () => {
    const user = userEvent.setup();
    renderSkills({
      skillsCatalogList: vi.fn(async () =>
        catalog({
          sources: [source("anthropics/skills", { error: "GitHub answered 403." })],
        })
      ),
    });
    await openDiscover(user);
    expect(await screen.findByText("anthropics/skills: GitHub answered 403.")).toBeInTheDocument();
  });
});

describe("adding a repository", () => {
  it("refuses a name main would silently drop, and says why", async () => {
    const user = userEvent.setup();
    const skillsCatalogAddSource = vi.fn(async () => catalog());
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()), skillsCatalogAddSource });
    await openDiscover(user);

    await user.click(await screen.findByRole("button", { name: "+ repository" }));
    await user.type(screen.getByLabelText("Repository to add"), "anthropics");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(skillsCatalogAddSource).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("owner/repo");
  });

  it("adds one that is shaped right", async () => {
    const user = userEvent.setup();
    const skillsCatalogAddSource = vi.fn(async () =>
      catalog({ sources: [source("anthropics/skills"), source("zvndev/skills", { builtin: false })] })
    );
    renderSkills({ skillsCatalogList: vi.fn(async () => catalog()), skillsCatalogAddSource });
    await openDiscover(user);

    await user.click(await screen.findByRole("button", { name: "+ repository" }));
    await user.type(screen.getByLabelText("Repository to add"), "zvndev/skills");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(skillsCatalogAddSource).toHaveBeenCalledWith("zvndev/skills");
    expect(await screen.findByRole("button", { name: "Remove zvndev/skills" })).toBeInTheDocument();
  });

  it("only offers to remove the sources the user added", async () => {
    const user = userEvent.setup();
    renderSkills({
      skillsCatalogList: vi.fn(async () =>
        catalog({ sources: [source("anthropics/skills"), source("zvndev/skills", { builtin: false })] })
      ),
      skillsCatalogRemoveSource: vi.fn(async () => catalog()),
    });
    await openDiscover(user);
    expect(await screen.findByRole("button", { name: "Remove zvndev/skills" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove anthropics/skills" })
    ).not.toBeInTheDocument();
  });
});

describe("one skill, in full", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await openDiscover(user);
    await screen.findByText("pdf");
    await user.click(catalogRow("anthropics/skills/pdf") as HTMLElement);
  };

  const detailApi = (over: Partial<ElectronAPI> = {}): Partial<ElectronAPI> =>
    ({
    skillsCatalogList: vi.fn(async () => catalog()),
    skillsRead: vi.fn(async () => ({
      body: "Use this skill to fill in PDF forms.",
      files: [
        { path: "SKILL.md", size: 7513, executable: false },
        { path: "scripts/extract.py", size: 2048, executable: true },
      ],
    })),
      wsRoots: vi.fn(async () => ["/Users/me/Work/Bevrly"]),
      ...over,
    }) as Partial<ElectronAPI>;

  it("renders the SKILL.md body, its metadata and its files", async () => {
    const user = userEvent.setup();
    renderSkills(detailApi());
    await open(user);

    expect(await screen.findByText("Use this skill to fill in PDF forms.")).toBeInTheDocument();
    expect(screen.getByText("Claude Code, Codex")).toBeInTheDocument();
    expect(screen.getByText("Tools: Bash(git:*) Read")).toBeInTheDocument();
    expect(screen.getByText("scripts/extract.py")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("comes back to the list", async () => {
    const user = userEvent.setup();
    renderSkills(detailApi());
    await open(user);
    await user.click(await screen.findByRole("button", { name: "‹ Back to skills" }));
    expect(await screen.findByLabelText("Search skills")).toBeInTheDocument();
  });

  it("adds to the targets that are ticked, Claude Code being the one that starts ticked", async () => {
    const user = userEvent.setup();
    const skillsInstall = vi.fn(async () => ({
      installed: [{ target: "claude" as const, path: `${HOME}/.claude/skills/pdf` }],
      errors: [],
    }));
    renderSkills(detailApi({ skillsInstall }));
    await open(user);

    await user.click(await screen.findByRole("checkbox", { name: "Codex" }));
    await user.click(screen.getByRole("button", { name: "Add skill" }));

    expect(skillsInstall).toHaveBeenCalledWith("anthropics/skills/pdf", ["claude", "codex"]);
    expect(await screen.findByText("Added to")).toBeInTheDocument();
  });

  it("installs into a workspace root when Project is ticked", async () => {
    const user = userEvent.setup();
    const skillsInstall = vi.fn(async () => ({ installed: [], errors: [] }));
    renderSkills(detailApi({ skillsInstall }));
    await open(user);

    await user.click(await screen.findByRole("checkbox", { name: "Claude Code" }));
    await user.click(screen.getByRole("checkbox", { name: "Project" }));
    await user.click(screen.getByRole("button", { name: "Add skill" }));

    expect(skillsInstall).toHaveBeenCalledWith("anthropics/skills/pdf", [
      { project: "/Users/me/Work/Bevrly" },
    ]);
  });

  it("remembers the targets that were ticked last time", async () => {
    localStorage.setItem("markie.skills.targets.v1", JSON.stringify(["cursor"]));
    const user = userEvent.setup();
    renderSkills(detailApi());
    await open(user);

    expect(await screen.findByRole("checkbox", { name: "Cursor" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
  });

  it("writes the tick back so the next skill opens the same way", async () => {
    const user = userEvent.setup();
    renderSkills(detailApi());
    await open(user);
    await user.click(await screen.findByRole("checkbox", { name: "Gemini" }));
    expect(JSON.parse(localStorage.getItem("markie.skills.targets.v1") ?? "[]")).toEqual([
      "claude",
      "gemini",
    ]);
  });

  it("says Update when every ticked target holds an older copy already", async () => {
    const user = userEvent.setup();
    renderSkills(
      detailApi({
        skillsCatalogList: vi.fn(async () =>
          catalog({
            skills: [
              skill({
                installedTo: [
                  { target: "claude", path: `${HOME}/.claude/skills/pdf`, upToDate: false },
                ],
              }),
            ],
          })
        ),
      })
    );
    await open(user);
    expect(await screen.findByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("shows the message main gave for a folder it refused to overwrite", async () => {
    const user = userEvent.setup();
    const message = `There is already a folder at ${HOME}/.claude/skills/pdf that Markie did not install.`;
    renderSkills(
      detailApi({
        skillsInstall: vi.fn(async () => ({
          installed: [],
          errors: [{ target: "claude" as const, error: "exists" as const, message }],
        })),
      })
    );
    await open(user);
    await user.click(await screen.findByRole("button", { name: "Add skill" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
