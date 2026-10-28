// The Skills panel's vocabulary: which tool a skill belongs to, and one key
// per skill folder however it was spelled.
//
// Kept out of the component because every one of these is a plain question
// with a plain answer, and because the grouping in particular is easy to get
// subtly wrong: the panel groups by the *tool whose folder the skill lives in*,
// which is not the same question as "which tool wrote this file" that
// classifyAgentFile answers for instruction files.
import { classifyAgentFile, isCachedAgentPath, type AgentKind } from "@/lib/agent-files";
import type { MdRow } from "@/lib/electron";

// ── Tools ──

export type SkillGroupId = "claude" | "codex" | "cursor" | "gemini" | "universal";

export const SKILL_GROUPS: { id: SkillGroupId; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "gemini", label: "Gemini" },
  { id: "universal", label: "Universal" },
];

// Skills first, because they are what this panel is for. Everything under them
// starts folded: an agent's instruction files and saved notes are still worth
// reaching, but they are not what you came to look at.
export const SKILLS_KIND_ORDER: AgentKind[] = [
  "skill",
  "instructions",
  "command",
  "agent",
  "memory",
  "other",
];

export const SKILLS_KIND_OPEN: AgentKind = "skill";

// Which tool's folder a file sits in.
//
// A SKILL.md the index scanned since the field existed says so itself: main
// decides from the roots it was configured with (CLAUDE_CONFIG_DIR, CODEX_HOME
// and the conventional folders), which a path cannot. A Codex home moved to
// ~/.config/codex has no /.codex/ in it, and reading the path alone dropped
// every skill installed there by hand. A null tool is main saying the folder
// is no tool's root, which is what a project folder is; the path markers
// decide that the way they always did, and decide rows too old for the field.
//
// classifyAgentFile knows about the instruction files and the two config
// folders that predate skills; the other three tools only ever appear here as
// a skills folder, so they are matched on the folder itself.
export function skillGroupFor(
  path: string,
  name: string,
  skill?: MdRow["skill"]
): SkillGroupId | null {
  // A clone under a tool's cache (~/.codex/vendor_imports, plugins/cache) is
  // inside that tool's root, so main labels it with the tool; it is still a
  // cache, not an install, and stays out whatever the label says.
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (isCachedAgentPath(p)) return null;
  if (skill?.tool) return skill.tool;
  const tool = classifyAgentFile(path, name);
  if (tool) return tool === "openai" ? "codex" : tool;
  if (p.includes("/.cursor/")) return "cursor";
  if (p.includes("/.gemini/")) return "gemini";
  if (p.includes("/.agents/")) return "universal";
  return null;
}

// ── Folders ──

/**
 * One key per folder, however it was spelled.
 *
 * The registry canonicalizes a Windows path to lower case at its own boundary
 * and the markdown index hands back whatever the filesystem said, so folding
 * separators alone gave one installed skill two keys and drew it as two rows.
 * Case is folded only where the filesystem folds it.
 */
export function canonicalFolder(path: string, platform: string): string {
  const folded = String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return platform === "win32" ? folded.toLowerCase() : folded;
}
