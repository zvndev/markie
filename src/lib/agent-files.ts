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

// Return the tool a file belongs to, or null if it isn't an agent file.
// `path` is absolute; `name` is the basename. Matching is case-insensitive.
export function classifyAgentFile(path: string, name: string): AgentTool | null {
  const n = name.toLowerCase();
  const p = path.toLowerCase();

  if (n === "claude.md" || p.includes("/.claude/")) return "claude";
  if (n === "agents.md" || p.includes("/.codex/")) return "openai";
  if (n === "gemini.md") return "gemini";
  if (n === ".cursorrules" || p.includes("/.cursor/rules/")) return "cursor";
  return null;
}
