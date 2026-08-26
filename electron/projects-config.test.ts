import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PROJECTS_MD,
  OVERVIEW_MARKER,
  ensureProjectsConfig,
  writeOverviewSection,
} from "./projects-config.js";

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
