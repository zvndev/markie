import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PROJECTS_MD,
  OVERVIEW_MARKER,
  ensureProjectsConfig as ensureProjectsConfigJs,
  writeOverviewSection,
} from "./projects-config.js";

// The CommonJS option bag loses `dir` to inference because it has no default.
// Name it here rather than add a .d.ts for a main-process-only module.
const ensureProjectsConfig = ensureProjectsConfigJs as unknown as (opts: {
  dir: string;
}) => { path: string; content: string; created: boolean };

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markie-projcfg-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ensureProjectsConfig", () => {
  it("creates Projects.md with the default template once", () => {
    const dir = tmp();
    const first = ensureProjectsConfig({ dir });
    expect(first.created).toBe(true);
    expect(first.path).toBe(path.join(dir, "Projects.md"));
    expect(first.content).toContain("markie_rules");
    const second = ensureProjectsConfig({ dir });
    expect(second.created).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("never overwrites an existing document", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "Projects.md"), "user content");
    expect(ensureProjectsConfig({ dir }).content).toBe("user content");
  });

  it("creates the workspace root when it does not exist yet", () => {
    const dir = path.join(tmp(), "nested", "Markie");
    expect(ensureProjectsConfig({ dir }).created).toBe(true);
    expect(fs.existsSync(path.join(dir, "Projects.md"))).toBe(true);
  });
});

describe("the default template", () => {
  it("carries an overview marker for the listing to land on", () => {
    expect(DEFAULT_PROJECTS_MD).toContain(OVERVIEW_MARKER);
  });

  it("explains the precedence a user would otherwise have to guess", () => {
    expect(DEFAULT_PROJECTS_MD).toMatch(/front matter/);
    expect(DEFAULT_PROJECTS_MD).toMatch(/\{repo\}/);
    expect(DEFAULT_PROJECTS_MD).toMatch(/ignore/);
  });

  // The places Markie leaves out of the tree by default are the places a user
  // is most likely to disagree about, so they are written down where he can
  // read them and delete a line, not buried in the engine.
  it("names the dumping grounds and the container levers it ships with", () => {
    expect(DEFAULT_PROJECTS_MD).toMatch(/dumping_grounds/);
    expect(DEFAULT_PROJECTS_MD).toMatch(/~\/Downloads\/\*\*/);
    expect(DEFAULT_PROJECTS_MD).toMatch(/not_containers/);
  });

  // The template is the front matter the engine will parse back: a typo here
  // reaches every new user as a rules error banner.
  it("parses as the rules it advertises", async () => {
    const { parseRules } = await import("../src/lib/projects/rules");
    const parsed = parseRules(DEFAULT_PROJECTS_MD);
    expect(parsed.error).toBeNull();
    expect(parsed.rules?.dumpingGrounds).toEqual(["~/Downloads/**", "~/.*/**"]);
    expect(parsed.rules?.clustering.gapHours).toBe(24);
  });
});

describe("writeOverviewSection", () => {
  it("replaces everything below the marker", () => {
    const doc = `---\nmarkie_rules: {}\n---\n# Projects\n\n${OVERVIEW_MARKER}\nold listing\n`;
    const next = writeOverviewSection(doc, "- ProjectA (3 files)\n");
    expect(next).toContain(`${OVERVIEW_MARKER}\n- ProjectA (3 files)\n`);
    expect(next).not.toContain("old listing");
  });

  it("keeps every byte above the marker, rules included", () => {
    const doc = `---\nmarkie_rules:\n  rules:\n    - match: "~/x/**"\n      project: X\n---\n# Mine\n\n${OVERVIEW_MARKER}\nold\n`;
    const next = writeOverviewSection(doc, "new\n");
    expect(next.slice(0, next.indexOf(OVERVIEW_MARKER))).toBe(
      doc.slice(0, doc.indexOf(OVERVIEW_MARKER))
    );
  });

  it("appends the marker when missing", () => {
    const doc = "---\nmarkie_rules: {}\n---\n# Projects\n";
    const next = writeOverviewSection(doc, "- P (1 file)\n");
    expect(next).toMatch(/<!-- markie:overview -->\n- P \(1 file\)\n$/);
  });

  it("is idempotent when run twice with the same listing", () => {
    const doc = `# Projects\n\n${OVERVIEW_MARKER}\nold\n`;
    const once = writeOverviewSection(doc, "listing\n");
    expect(writeOverviewSection(once, "listing\n")).toBe(once);
  });
});
