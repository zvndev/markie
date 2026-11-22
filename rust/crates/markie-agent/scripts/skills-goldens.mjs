// Electron's Skills view rows for a fixture tree: mdindex.js gives each
// SKILL.md its tool and description, and the grouping is skills-view.tsx's
// two useMemo bodies over src/lib/skills-panel.ts and agent-files.ts.
// Run from the worktree root (node_modules symlinked):
//   node --import ./rust/scripts/ts-run/register.mjs rust/crates/markie-agent/scripts/skills-goldens.mjs
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { agentFileKind, agentFileLabel, collapseSkills, skillRootOf } from "../../../../src/lib/agent-files.ts";
import { SKILL_GROUPS, SKILLS_KIND_ORDER, canonicalFolder, skillGroupFor } from "../../../../src/lib/skills-panel.ts";

const require = createRequire(import.meta.url);
const { skillToolFor } = require("../../../../electron/mdindex.js");
const { parseFrontmatter } = require("../../../../electron/skill-frontmatter.js");

const FILES = {
  ".claude/skills/alpha/SKILL.md": "---\ndescription: Alpha does things\n---\n",
  ".claude/skills/alpha/refs/README.md": "refs",
  ".claude/skills/beta/README.md": "no SKILL.md here",
  ".claude/skills/beta/deep/notes.md": "deeper",
  ".claude/skills/loose.md": "a file directly in skills",
  ".claude/skills/Gamma/SKILL.md": "---\ndescription: >\n  Folded\n  text\n---\n",
  ".claude/CLAUDE.md": "global instructions",
  ".claude/commands/ship.md": "command",
  ".claude/agents/reviewer.md": "subagent",
  ".claude/projects/x/memory/note.md": "memory",
  ".claude/plugins/cache/p/skills/c/SKILL.md": "cached",
  ".claude/plugins/mine/skills/plug/SKILL.md": "---\ndescription: plugin skill\n---\n",
  ".claude/misc/SKILL.md": "---\ndescription: not under skills\n---\n",
  ".codex/AGENTS.md": "codex",
  ".codex/skills/tool/SKILL.md": "---\ndescription: \"Quoted: codex\"\n---\n",
  ".codex/prompts/fix.md": "prompt",
  ".cursor/rules/style.mdc": "rule",
  ".cursor/skills/cur/SKILL.md": "---\ndescription: cursor skill\n---\n",
  ".cursorrules": "legacy",
  ".gemini/GEMINI.md": "gemini",
  ".gemini/skills/gem/SKILL.md": "gem",
  ".agents/skills/uni/SKILL.md": "---\ndescription: universal\n---\n",
  ".agents/notes.md": "universal other",
  "work/app/CLAUDE.md": "project instructions",
  "work/app/AGENTS.md": "project agents",
  "work/app/.claude/skills/proj/SKILL.md": "---\ndescription: project skill\n---\n",
  "work/app/.claude/settings.md": "project claude other",
  "work/app/README.md": "not an agent file",
  "work/app/node_modules/x/CLAUDE.md": "ignored",
};

const home = realpathSync(mkdtempSync(join(tmpdir(), "skills-golden-")));
const rows = Object.entries(FILES).map(([rel, text]) => {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const row = { path, name: basename(path), dir: dirname(path) };
  if (/^skill\.md$/i.test(row.name)) {
    const value = parseFrontmatter(text).fields.description;
    row.skill = { tool: skillToolFor(path, { home, env: {}, platform: "darwin" }), description: typeof value === "string" && value.trim() ? value.trim() : null };
  }
  return row;
});

// skills-view.tsx skillsByGroup
const skillsByGroup = new Map();
{
  const perGroup = new Map();
  for (const r of rows) {
    if (agentFileKind(r.path, r.name) !== "skill") continue;
    const group = skillGroupFor(r.path, r.name, r.skill);
    if (!group) continue;
    (perGroup.get(group) ?? perGroup.set(group, []).get(group)).push(r);
  }
  for (const [group, files] of perGroup) {
    for (const { file, label } of collapseSkills(files)) {
      const folder = skillRootOf(file.path) ?? file.dir;
      const row = { key: canonicalFolder(folder, "darwin"), folder, removable: !!file.skill?.tool, group, label, openPath: file.path, description: file.skill?.description ?? null };
      (skillsByGroup.get(group) ?? skillsByGroup.set(group, []).get(group)).push(row);
    }
  }
  for (const list of skillsByGroup.values()) list.sort((a, b) => a.label.localeCompare(b.label));
}
// skills-view.tsx otherByGroup
const otherByGroup = new Map();
for (const r of rows) {
  const kind = agentFileKind(r.path, r.name);
  if (kind === "skill") continue;
  const group = skillGroupFor(r.path, r.name);
  if (!group) continue;
  const kinds = otherByGroup.get(group) ?? new Map();
  otherByGroup.set(group, kinds);
  (kinds.get(kind) ?? kinds.set(kind, []).get(kind)).push({ file: r, label: agentFileLabel(r.path, r.name) });
}
for (const kinds of otherByGroup.values()) for (const list of kinds.values()) list.sort((a, b) => a.label.localeCompare(b.label));

const rel = (p) => p.slice(home.length + 1);
const out = [];
for (const { id } of SKILL_GROUPS) {
  for (const kind of SKILLS_KIND_ORDER) {
    if (kind === "skill") {
      for (const r of skillsByGroup.get(id) ?? []) out.push({ tool: id, kind, label: r.label, path: rel(r.openPath), folder: rel(r.folder), removable: r.removable, description: r.description });
    } else {
      for (const { file, label } of otherByGroup.get(id)?.get(kind) ?? []) out.push({ tool: id, kind, label, path: rel(file.path), folder: null, removable: false, description: null });
    }
  }
}
writeFileSync(new URL("../tests/goldens/skills.json", import.meta.url), JSON.stringify({ files: Object.entries(FILES), rows: out }, null, 1) + "\n");
console.log(`${out.length} rows`);
