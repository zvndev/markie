import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, MdRow, MdScanResult } from "@/lib/electron";
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

beforeEach(() => {
  localStorage.clear();
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
    // Two files in the pdf folder, one row.
    expect(screen.getAllByText("pdf")).toHaveLength(1);
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
    const reveal = await screen.findByRole("button", { name: "Show in Finder: pdf" });
    // "Finder" on its own read as a noun in a row of verbs.
    expect(reveal).toHaveTextContent("Show in Finder");
    await user.click(reveal);
    expect(revealFile).toHaveBeenCalledWith(`${HOME}/.claude/skills/pdf/SKILL.md`);
  });

  it("groups a skill in a moved Codex home by what main says, and shows its description", async () => {
    const user = userEvent.setup();
    // Nothing in this path says Codex; the row does.
    const path = "/home/me/.config/codex/skills/x/SKILL.md";
    renderSkills({
      mdIndexScan: vi.fn(async () =>
        scan([{ ...mdRow(path), skill: { tool: "codex", description: "Does x" } }])
      ),
    });
    expect(await screen.findByText("x")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Does x")).toBeInTheDocument();
    // A description the index supplied is one the filter can find.
    await user.type(screen.getByLabelText("Filter skills and agent files"), "does");
    expect(screen.getByText("x")).toBeInTheDocument();
  });

  it("shows nothing for that path when the row does not carry the field", async () => {
    renderSkills({
      mdIndexScan: vi.fn(async () => scan([mdRow("/home/me/.config/codex/skills/x/SKILL.md")])),
    });
    expect(await screen.findByText(/No agent files found/)).toBeInTheDocument();
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

  it("ignores a tab remembered from when there was a Discover tab", async () => {
    localStorage.setItem("markie.skills.tab.v1", "discover");
    renderSkills({ mdIndexScan: vi.fn(async () => scan(rows)) });
    expect(await screen.findByText("pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discover" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Installed" })).not.toBeInTheDocument();
  });
});
