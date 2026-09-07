import { describe, expect, it } from "vitest";
import {
  SKILLS_TAB_KEY,
  SKILLS_TARGETS_KEY,
  describeChecked,
  formatSize,
  groupForTarget,
  initialSkillsTab,
  licenseBadge,
  matchesSkill,
  newestFetchedAt,
  ownerRepoError,
  readRememberedTargets,
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
    expect(describeChecked(at, at + 20_000)).toBe("checked just now");
    expect(describeChecked(at, at + 40 * 60_000)).toBe("checked 40 min ago");
    expect(describeChecked(at, at + 60 * 60_000)).toBe("checked 1 hour ago");
    expect(describeChecked(at, at + 5 * 60 * 60_000)).toBe("checked 5 hours ago");
    expect(describeChecked(at, at + 48 * 60 * 60_000)).toBe("checked 2 days ago");
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
