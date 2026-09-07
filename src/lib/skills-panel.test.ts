import { describe, expect, it } from "vitest";
import type { CatalogSkill } from "@/lib/electron";
import {
  SKILLS_TAB_KEY,
  SKILLS_TARGETS_KEY,
  canonicalFolder,
  describeChecked,
  formatDestinations,
  formatSize,
  hitSkillKey,
  groupForTarget,
  initialSkillsTab,
  installLabel,
  licenseBadge,
  licenseChip,
  matchesSkill,
  newestFetchedAt,
  ownerRepoError,
  readRememberedTargets,
  resolveHit,
  skillGroupFor,
  targetKey,
  targetLabel,
  writeRememberedTargets,
} from "@/lib/skills-panel";

const reader = (store: Record<string, string>) => (key: string) => store[key] ?? null;

describe("which tab opens", () => {
  it("opens Installed when nothing is stored", () => {
    expect(initialSkillsTab(reader({}))).toBe("installed");
  });

  it("remembers Discover", () => {
    expect(initialSkillsTab(reader({ [SKILLS_TAB_KEY]: "discover" }))).toBe("discover");
  });

  it("ignores a value that is not a tab", () => {
    expect(initialSkillsTab(reader({ [SKILLS_TAB_KEY]: "catalogue" }))).toBe("installed");
  });

  it("survives storage that throws", () => {
    expect(
      initialSkillsTab(() => {
        throw new Error("site data blocked");
      })
    ).toBe("installed");
  });
});

describe("which tool a file belongs to", () => {
  it("reads the four folders the panel already knew", () => {
    expect(skillGroupFor("/home/me/.claude/skills/pdf/SKILL.md", "SKILL.md")).toBe("claude");
    expect(skillGroupFor("/home/me/.codex/skills/pdf/SKILL.md", "SKILL.md")).toBe("codex");
    expect(skillGroupFor("/home/me/.cursor/rules/house.md", "house.md")).toBe("cursor");
    expect(skillGroupFor("/home/me/work/GEMINI.md", "GEMINI.md")).toBe("gemini");
  });

  it("reads the three skill folders classifyAgentFile predates", () => {
    expect(skillGroupFor("/home/me/.cursor/skills/pdf/SKILL.md", "SKILL.md")).toBe("cursor");
    expect(skillGroupFor("/home/me/.gemini/skills/pdf/SKILL.md", "SKILL.md")).toBe("gemini");
    expect(skillGroupFor("/home/me/.agents/skills/pdf/SKILL.md", "SKILL.md")).toBe("universal");
  });

  it("calls Codex Codex, not OpenAI", () => {
    expect(skillGroupFor("/home/me/work/AGENTS.md", "AGENTS.md")).toBe("codex");
  });

  it("still drops a cached copy of someone else's repository", () => {
    expect(
      skillGroupFor("/home/me/.claude/plugins/cache/x/.agents/skills/pdf/SKILL.md", "SKILL.md")
    ).toBeNull();
  });

  it("classifies a Windows path the way it classifies a POSIX one", () => {
    expect(skillGroupFor("C:\\Users\\me\\.agents\\skills\\pdf\\SKILL.md", "SKILL.md")).toBe(
      "universal"
    );
  });

  it("says nothing about a file that is not an agent file", () => {
    expect(skillGroupFor("/home/me/notes/today.md", "today.md")).toBeNull();
  });

  it("takes the tool main decided from its roots, where the path says nothing", () => {
    // CODEX_HOME moved to ~/.config/codex: there is no /.codex/ to read.
    const path = "/home/me/.config/codex/skills/x/SKILL.md";
    expect(skillGroupFor(path, "SKILL.md", { tool: "codex", description: "Does x" })).toBe("codex");
    // Pinned so the fallback stays visible: a row without the field is
    // classified by its path, and this path classifies as nothing.
    expect(skillGroupFor(path, "SKILL.md")).toBeNull();
  });

  it("keeps a project skill under Claude when main calls it no tool's", () => {
    expect(
      skillGroupFor("/home/me/work/app/.claude/skills/x/SKILL.md", "SKILL.md", {
        tool: null,
        description: null,
      })
    ).toBe("claude");
  });
});

describe("targets", () => {
  it("names a tool and a project", () => {
    expect(targetLabel("claude")).toBe("Claude Code");
    expect(targetLabel("universal")).toBe("Universal");
    expect(targetLabel({ project: "/Users/me/Work/Bevrly" })).toBe("Bevrly");
  });

  it("keys a project by its path, so two projects are two targets", () => {
    expect(targetKey({ project: "/a/one" })).toBe("project:/a/one");
    expect(targetKey({ project: "/a/one" })).not.toBe(targetKey({ project: "/a/two" }));
  });

  it("files a project install under Claude, which is whose folder it lands in", () => {
    expect(groupForTarget({ project: "/a/one" })).toBe("claude");
    expect(groupForTarget("cursor")).toBe("cursor");
  });
});

describe("the remembered targets", () => {
  it("starts at Claude Code", () => {
    expect(readRememberedTargets(reader({}))).toEqual(["claude"]);
  });

  it("reads back what was written", () => {
    const store: Record<string, string> = {};
    writeRememberedTargets((k, v) => {
      store[k] = v;
    }, ["codex", { project: "/a/one" }]);
    expect(readRememberedTargets(reader(store))).toEqual(["codex", { project: "/a/one" }]);
  });

  it("drops entries that are not targets rather than passing them to main", () => {
    const store = { [SKILLS_TARGETS_KEY]: '["claude","emacs",{"nope":1}]' };
    expect(readRememberedTargets(reader(store))).toEqual(["claude"]);
  });

  it("falls back to Claude Code on unreadable storage", () => {
    expect(readRememberedTargets(reader({ [SKILLS_TARGETS_KEY]: "{oh no" }))).toEqual(["claude"]);
  });
});

describe("the licence badge", () => {
  it("says Proprietary for anything that reads as one", () => {
    expect(licenseBadge("Proprietary")).toBe("Proprietary");
    expect(licenseBadge("Complete license terms: All Rights Reserved")).toBe("Proprietary");
  });

  it("shows the licence it was given", () => {
    expect(licenseBadge("MIT")).toBe("MIT");
  });

  it("does not claim a licence the front matter never stated", () => {
    expect(licenseBadge(null)).toBe("License in repo");
    expect(licenseBadge("   ")).toBe("License in repo");
  });
});

describe("filtering the loaded catalog", () => {
  const skill = { name: "pdf", description: "Fill in and read PDF forms." };

  it("matches the name", () => {
    expect(matchesSkill(skill, "PD")).toBe(true);
  });

  it("matches the description too, which is where the useful words are", () => {
    expect(matchesSkill(skill, "forms")).toBe(true);
  });

  it("keeps everything for an empty query", () => {
    expect(matchesSkill(skill, "  ")).toBe(true);
  });

  it("drops what does not match", () => {
    expect(matchesSkill(skill, "spreadsheet")).toBe(false);
  });
});

describe("when the catalog was last checked", () => {
  const at = Date.parse("2026-09-07T12:00:00.000Z");

  it("takes the newest of the sources", () => {
    expect(
      newestFetchedAt([
        { fetchedAt: "2026-09-07T11:00:00.000Z" },
        { fetchedAt: "2026-09-07T12:00:00.000Z" },
        { fetchedAt: null },
      ])
    ).toBe(at);
  });

  it("has nothing to say when no source was ever fetched", () => {
    expect(newestFetchedAt([{ fetchedAt: null }])).toBeNull();
    expect(describeChecked(null, at)).toBeNull();
  });

  it("reads in minutes, hours and days", () => {
    // It says what was updated: "checked" on its own named nothing.
    expect(describeChecked(at, at + 20_000)).toBe("Catalog updated just now");
    expect(describeChecked(at, at + 40 * 60_000)).toBe("Catalog updated 40 min ago");
    expect(describeChecked(at, at + 60 * 60_000)).toBe("Catalog updated 1 hour ago");
    expect(describeChecked(at, at + 5 * 60 * 60_000)).toBe("Catalog updated 5 hours ago");
    expect(describeChecked(at, at + 48 * 60 * 60_000)).toBe("Catalog updated 2 days ago");
  });
});

describe("adding a repository", () => {
  it("accepts what the main process accepts", () => {
    expect(ownerRepoError("anthropics/skills")).toBeNull();
    expect(ownerRepoError("  obra/superpowers  ")).toBeNull();
  });

  it("refuses what main would silently drop, and says why", () => {
    expect(ownerRepoError("")).toMatch(/anthropics\/skills/);
    expect(ownerRepoError("anthropics")).toMatch(/owner\/repo/);
    expect(ownerRepoError("https://github.com/anthropics/skills")).toMatch(/owner\/repo/);
    expect(ownerRepoError("anthropics/skills/pdf")).toMatch(/owner\/repo/);
  });
});

describe("file sizes", () => {
  it("reads at a glance", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(820)).toBe("820 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(120 * 1024)).toBe("120 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("one key per folder", () => {
  it("folds separators and trailing slashes on every platform", () => {
    expect(canonicalFolder("/Users/me/.claude/skills/pdf/", "darwin")).toBe(
      "/Users/me/.claude/skills/pdf"
    );
  });

  it("folds case on Windows, where the registry stores paths lower and the index does not", () => {
    expect(canonicalFolder("C:\\Users\\Me\\.claude\\skills\\pdf", "win32")).toBe(
      canonicalFolder("c:/users/me/.claude/skills/pdf", "win32")
    );
  });

  it("keeps case everywhere else, where two spellings are two folders", () => {
    expect(canonicalFolder("/Users/me/.claude/skills/PDF", "darwin")).not.toBe(
      canonicalFolder("/Users/me/.claude/skills/pdf", "darwin")
    );
  });
});

describe("resolving a skills.sh hit", () => {
  const entry = (over: Partial<CatalogSkill> = {}): CatalogSkill => ({
    id: "anthropics/skills/skills/pdf",
    source: "anthropics/skills",
    skillPath: "skills/pdf",
    name: "pdf",
    description: "Fill in and read PDF forms.",
    license: null,
    compatibility: null,
    allowedTools: null,
    metadata: {},
    files: [],
    folderHash: "a".repeat(64),
    installedTo: [],
    ...over,
  });

  const hit = {
    id: "anthropics/skills/pdf",
    name: "pdf",
    source: "anthropics/skills",
    installs: 812,
  };

  it("reads the skill out of a hit's id", () => {
    expect(hitSkillKey(hit)).toBe("pdf");
    expect(hitSkillKey({ id: "obra/superpowers/a/b/deep", name: "deep", source: "obra/superpowers" }))
      .toBe("deep");
  });

  it("matches the real shapes: a hit id is not a catalog id", () => {
    const found = resolveHit(hit, [entry()]);
    expect(found?.id).toBe("anthropics/skills/skills/pdf");
  });

  it("never crosses sources", () => {
    expect(resolveHit(hit, [entry({ source: "openai/skills" })])).toBeNull();
  });

  it("matches a skill whose folder and name differ", () => {
    const found = resolveHit(
      { id: "obra/superpowers/brainstorming", name: "brainstorming", source: "obra/superpowers" },
      [
        entry({
          id: "obra/superpowers/skills/brainstorm",
          source: "obra/superpowers",
          skillPath: "skills/brainstorm",
          name: "brainstorming",
        }),
      ]
    );
    expect(found?.name).toBe("brainstorming");
  });

  it("prefers the folder that carries the hit's name over a skill that merely shares it", () => {
    const found = resolveHit(hit, [
      entry({ id: "anthropics/skills/skills/pdf-legacy", skillPath: "skills/pdf-legacy", name: "pdf" }),
      entry(),
    ]);
    expect(found?.id).toBe("anthropics/skills/skills/pdf");
  });

  it("says nothing rather than guessing", () => {
    expect(resolveHit(hit, [entry({ skillPath: "skills/xlsx", name: "xlsx" })])).toBeNull();
    expect(resolveHit(hit, [])).toBeNull();
  });
});

describe("what the button is about to do", () => {
  it("names the one place, or counts them", () => {
    expect(installLabel(["claude"], false)).toBe("Add to Claude Code");
    expect(installLabel(["claude", "codex"], false)).toBe("Add to 2 targets");
    expect(installLabel(["claude"], true)).toBe("Update in Claude Code");
    expect(installLabel(["claude", "codex"], true)).toBe("Update in 2 targets");
  });

  it("falls back when nothing is picked", () => {
    expect(installLabel([], false)).toBe("Add skill");
  });
});

describe("where else a skill lives", () => {
  it("names up to two and counts the rest", () => {
    expect(formatDestinations([])).toBe("");
    expect(formatDestinations(["claude"])).toBe("Claude Code");
    expect(formatDestinations(["claude", "codex"])).toBe("Claude Code and Codex");
    expect(formatDestinations(["claude", "codex", "cursor"])).toBe(
      "Claude Code, Codex and 1 more"
    );
    expect(formatDestinations(["claude", "codex", "cursor", "gemini"])).toBe(
      "Claude Code, Codex and 2 more"
    );
  });
});

describe("the licence chip on a catalog row", () => {
  it("keeps a licence name", () => {
    expect(licenseChip("MIT")).toBe("MIT");
    expect(licenseChip("Apache-2.0")).toBe("Apache-2.0");
  });

  it("keeps the one word that matters", () => {
    expect(licenseChip("All Rights Reserved")).toBe("Proprietary");
  });

  it("drops a sentence, which is what anthropics/skills writes", () => {
    expect(licenseChip("Complete terms in LICENSE.txt")).toBeNull();
  });

  it("has nothing to say when the front matter did not", () => {
    expect(licenseChip(null)).toBeNull();
  });
});
