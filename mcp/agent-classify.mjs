// The ONE definition of "which agent tool does this file belong to", shared by
// the app (src/lib/agent-files.ts imports this) and the MCP server (lib.mjs).
// It lives in mcp/ because the MCP server ships as an extraResource and must
// stay import-isolated for packaging: the app may reach in, the reverse is
// forbidden (see the scan.mjs header for the breakage that taught us).
//
// Keeping two copies is what caused the bug this replaces: the cache filter was
// added on the app side only, so markie_list_skills kept returning thousands of
// other people's cloned plugin READMEs that the Skills panel already hid.

// Folders that hold copies of somebody else's files.
//
// ~/.claude/plugins/cache and plugins/marketplaces are cloned plugin repos.
// Nothing in a cache is authored here, so nothing in a cache belongs in a list
// of your agent files.
export const CACHED_SEGMENTS = [
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
export function isCachedAgentPath(path) {
  const p = String(path).toLowerCase().replace(/\\/g, "/");
  return CACHED_SEGMENTS.some((segment) => p.includes(segment));
}

// Return the tool a file belongs to, or null if it isn't an agent file.
// `path` is absolute; `name` is the basename. Matching is case-insensitive, and
// backslashes are normalized so a Windows path classifies like a POSIX one.
export function classifyAgentFile(path, name) {
  const n = String(name).toLowerCase();
  const p = String(path).toLowerCase().replace(/\\/g, "/");

  if (isCachedAgentPath(p)) return null;

  if (n === "claude.md" || p.includes("/.claude/")) return "claude";
  if (n === "agents.md" || p.includes("/.codex/")) return "openai";
  if (n === "gemini.md") return "gemini";
  if (n === ".cursorrules" || p.includes("/.cursor/rules/")) return "cursor";
  return null;
}
