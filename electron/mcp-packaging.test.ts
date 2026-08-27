// The MCP server ships as an extraResource with an EXPLICIT file filter, so a
// new module inside mcp/ is invisible to the packaged app unless someone
// remembers to widen the filter. Nothing remembered: conventions.mjs and
// agent-classify.mjs would have shipped missing, and the server would have died
// on its first import with the app looking fine in dev.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = require("../electron-builder.config.cjs") as {
  extraResources: { from: string; to: string; filter: string[] }[];
};

describe("mcp extraResources filter", () => {
  const mcpResource = config.extraResources.find((r) => r.from === "mcp");

  it("copies mcp/ into Resources/mcp", () => {
    expect(mcpResource).toBeDefined();
    expect(mcpResource!.to).toBe("mcp");
  });

  it("names every runtime module in mcp/, and no test file", () => {
    const onDisk = readdirSync(join(REPO_ROOT, "mcp"))
      .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
      .sort();
    const filtered = mcpResource!.filter.filter((f) => f.endsWith(".mjs")).sort();
    expect(filtered).toEqual(onDisk);
    expect(mcpResource!.filter).toContain("package.json");
    expect(mcpResource!.filter.some((f) => f.includes(".test."))).toBe(false);
  });
});

// The Claude Code plugin is the mcp/ directory itself (marketplace.json points
// its source at ./mcp), and Claude Code discovers skills at <pluginRoot>/skills
// with no manifest entry. That layout is what installed plugins on disk use, so
// the skill only reaches users if it stays exactly there.
describe("markie-conventions plugin skill", () => {
  const SKILL = join(REPO_ROOT, "mcp", "skills", "markie-conventions", "SKILL.md");

  it("sits at the plugin root the marketplace points at", () => {
    const marketplace = require("../.claude-plugin/marketplace.json") as {
      plugins: { name: string; source: string }[];
    };
    const entry = marketplace.plugins.find((x) => x.name === "markie");
    expect(entry?.source).toBe("./mcp");
    expect(readdirSync(join(REPO_ROOT, "mcp", "skills"))).toContain(
      "markie-conventions"
    );
  });

  it("carries the front matter Claude Code needs to surface it", () => {
    const text = readFileSync(SKILL, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    expect(fm).not.toBeNull();
    expect(fm![1]).toMatch(/^name: markie-conventions$/m);
    expect(fm![1]).toMatch(/^description: \S.*markie_write_md/m);
  });

  it("teaches the conventions the MCP instructions teach", async () => {
    const text = readFileSync(SKILL, "utf8");
    expect(text).toContain("markie_find_md");
    expect(text).toContain("markie_open_in_markie");
    expect(text).toMatch(/project: bevrly/);
    expect(text).toMatch(/block: checkout-redesign/);
    expect(text).toMatch(/not the date/);
    // Prose the user may read: no em-dashes.
    expect(text).not.toContain("—");
  });
});
