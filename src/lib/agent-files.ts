// Classify a markdown/agent file by which tool's convention it follows, so the
// Skills/Agents panel can group device-wide agent instruction + skill files.
// Pure + dependency-free so it's trivially unit-testable.

export type AgentTool = "claude" | "openai" | "gemini" | "cursor";

export interface AgentToolMeta {
  id: AgentTool;
  label: string;
}

// Display order + labels for the grouped Skills panel.
export const AGENT_TOOLS: AgentToolMeta[] = [
  { id: "claude", label: "Claude" },
  { id: "openai", label: "OpenAI · Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "cursor", label: "Cursor" },
];

// What a file is *for*, which is a different question from which tool wrote it.
// One flat list of everything under ~/.claude is unreadable; a skill, a
// subagent definition and a saved session transcript have nothing in common
// beyond living in the same folder.
export type AgentKind =
  | "instructions"
  | "skill"
  | "command"
  | "agent"
  | "memory"
  | "other";

export interface AgentKindMeta {
  id: AgentKind;
  label: string;
  // Starts folded in the panel.
  collapsed?: boolean;
}

export const AGENT_KINDS: AgentKindMeta[] = [
  { id: "instructions", label: "Instructions" },
  { id: "skill", label: "Skills" },
  { id: "command", label: "Commands" },
  { id: "agent", label: "Subagents" },
  // Machine-written records rather than things you author, so they start
  // folded: still reachable, no longer the bulk of what you scroll past.
  { id: "memory", label: "Memory & notes", collapsed: true },
  { id: "other", label: "Other", collapsed: true },
];

// Folders that hold copies of somebody else's files.
//
// ~/.claude/plugins/cache and plugins/marketplaces are cloned plugin repos:
// on this machine they alone are 1,543 of the 3,782 markdown files under
// ~/.claude, so the panel was mostly other people's READMEs. Nothing in a
// cache is authored here, so nothing in a cache belongs in a list of your
// agent files.
const CACHED_SEGMENTS = [
  "/plugins/cache/",
  "/plugins/marketplaces/",
  "/bundled-marketplaces/",
  "/vendor_imports/",
  "/.tmp/",
  "/tmp/",
  "/node_modules/",
  "/.git/",
  "/caches/",
  "/.cache/",
  "/.trash/",
  "/.removed-skills/",
  "/backups/",
  "/shell-snapshots/",
  "/paste-cache/",
  "/browser-profiles/",
  "/file-history/",
];

// True for a file that is a copy, a build artifact, or a scratch record rather
// than something written on purpose.
export function isCachedAgentPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\\/g, "/");
  return CACHED_SEGMENTS.some((segment) => p.includes(segment));
}

// Return the tool a file belongs to, or null if it isn't an agent file.
// `path` is absolute; `name` is the basename. Matching is case-insensitive.
export function classifyAgentFile(path: string, name: string): AgentTool | null {
  const n = name.toLowerCase();
  const p = path.toLowerCase().replace(/\\/g, "/");

  if (isCachedAgentPath(p)) return null;

  if (n === "claude.md" || p.includes("/.claude/")) return "claude";
  if (n === "agents.md" || p.includes("/.codex/")) return "openai";
  if (n === "gemini.md") return "gemini";
  if (n === ".cursorrules" || p.includes("/.cursor/rules/")) return "cursor";
  return null;
}

// What the file is for. Keyed off the conventional folder layout of each tool.
export function agentFileKind(path: string, name: string): AgentKind {
  const n = name.toLowerCase();
  const p = path.toLowerCase().replace(/\\/g, "/");

  // The top-level instruction files, wherever they sit: a repo's CLAUDE.md is
  // the same kind of thing as the global one.
  if (n === "claude.md" || n === "agents.md" || n === "gemini.md" || n === ".cursorrules") {
    return "instructions";
  }

  if (p.includes("/skills/")) return "skill";
  if (p.includes("/commands/") || p.includes("/prompts/")) return "command";
  if (p.includes("/agents/")) return "agent";
  if (
    p.includes("/agent-memory/") ||
    p.includes("/memory/") ||
    p.includes("/projects/") ||
    p.includes("/sessions/") ||
    p.includes("/transcripts/") ||
    p.includes("/plans/") ||
    p.includes("/tasks/") ||
    p.includes("/jobs/")
  ) {
    return "memory";
  }
  if (p.includes("/.cursor/rules/")) return "instructions";
  return "other";
}

// A skill lives at <skills>/<name>/SKILL.md, so every row would otherwise read
// "SKILL.md" and the actual name would only appear in the grey path beneath.
export function agentFileLabel(path: string, name: string): string {
  const n = name.toLowerCase();
  if (n !== "skill.md" && n !== "readme.md") return name;
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const parent = segments[segments.length - 2];
  return parent ? `${parent}/${name}` : name;
}


// A skill is a folder, not a file.
//
// ~/.codex/skills/vercel-react-best-practices holds 67 markdown files: one
// SKILL.md and 66 reference documents it draws on. Listing all 67 is the same
// complaint as the folder browser showing ten rows for one project. One skill
// is one row; its supporting documents are reachable by opening the folder.
export function skillRootOf(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  const marker = p.toLowerCase().lastIndexOf("/skills/");
  if (marker === -1) return null;
  const after = p.slice(marker + "/skills/".length);
  const name = after.split("/")[0];
  // A markdown file sitting directly in skills/ is its own thing, not a folder.
  if (!name || !after.includes("/")) return null;
  return `${p.slice(0, marker)}/skills/${name}`;
}

// The file a skill row opens: its SKILL.md, or the shallowest markdown it has
// if it does not follow the convention.
export function skillEntry<T extends { path: string; name: string }>(files: readonly T[]): T {
  const named = files.find((f) => f.name.toLowerCase() === "skill.md");
  if (named) return named;
  const depth = (f: T) => f.path.split(/[\\/]/).length;
  return [...files].sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path))[0];
}

// Collapses every file inside one skill folder down to a single entry, and
// reports how many were folded in so the row can say so.
export function collapseSkills<T extends { path: string; name: string }>(
  files: readonly T[]
): { file: T; label: string; contains: number }[] {
  const bySkill = new Map<string, T[]>();
  const loose: T[] = [];
  for (const f of files) {
    const root = skillRootOf(f.path);
    if (!root) {
      loose.push(f);
      continue;
    }
    const arr = bySkill.get(root);
    if (arr) arr.push(f);
    else bySkill.set(root, [f]);
  }
  const rows = [...bySkill.entries()].map(([root, group]) => ({
    file: skillEntry(group),
    label: root.split("/").pop() ?? root,
    contains: group.length,
  }));
  for (const f of loose) rows.push({ file: f, label: f.name, contains: 1 });
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}
