// Pure helpers for the Markie MCP server: path guarding, query matching, and
// agent-file classification. Kept dependency-light and side-effect-free so they
// can be unit-tested in isolation (node --test lib.test.mjs).
import { resolve, join, sep } from "node:path";
// Self-contained scan rules (no ../electron dependency — see scan.mjs header).
import { isExcludedDir, allowlist } from "./scan.mjs";

export const MD_RE = /\.(md|markdown|mdx)$/i;

// Display order + labels for grouped skills — mirrors src/lib/agent-files.ts.
export const AGENT_TOOLS = [
  { id: "claude", label: "Claude" },
  { id: "openai", label: "OpenAI · Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "cursor", label: "Cursor" },
];

function relSegments(full, home) {
  const rel =
    full === home
      ? ""
      : full.startsWith(home + sep)
        ? full.slice(home.length + 1)
        : full;
  return rel.split(sep).filter(Boolean);
}

// The allowlisted root (e.g. ~/.claude/skills, ~/.codex) containing `full`, or
// null. Inside such a root the leading dot-dir is permitted; deeper vendored or
// hidden dirs are still pruned.
function allowRootFor(full, home) {
  return (
    allowlist(home).find((a) => full === a || full.startsWith(a + sep)) || null
  );
}

// Validate a path for read/write. Returns { ok, path } or { ok:false, error }.
// Mirrors what the device index would surface: markdown extension, under home,
// and no excluded/hidden ancestor segment (except the allowlisted skill roots).
export function guardPath(input, home) {
  if (!input || typeof input !== "string") {
    return { ok: false, error: "path is required" };
  }
  let full = input;
  if (full === "~") full = home;
  else if (full.startsWith("~/")) full = join(home, full.slice(2));
  full = resolve(full);

  if (!MD_RE.test(full)) {
    return { ok: false, error: "only .md, .markdown, or .mdx files are allowed" };
  }
  if (full !== home && !full.startsWith(home + sep)) {
    return { ok: false, error: "path must be inside your home folder" };
  }

  const dirSegs = relSegments(full, home).slice(0, -1); // drop the filename
  const root = allowRootFor(full, home);
  const skip = root ? relSegments(root, home).length : 0;
  for (const s of dirSegs.slice(skip)) {
    if (isExcludedDir(s)) {
      return { ok: false, error: `refused: "${s}" is an excluded directory` };
    }
  }
  return { ok: true, path: full };
}

// Case-insensitive substring match on a scan row's name or path. Empty → all.
export function matchQuery(row, query) {
  const q = (query || "").toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) || row.path.toLowerCase().includes(q)
  );
}

// Which agent tool a file belongs to, or null. Mirrors src/lib/agent-files.ts.
export function classifyAgentFile(path, name) {
  const n = name.toLowerCase();
  const p = path.toLowerCase();
  if (n === "claude.md" || p.includes("/.claude/")) return "claude";
  if (n === "agents.md" || p.includes("/.codex/")) return "openai";
  if (n === "gemini.md") return "gemini";
  if (n === ".cursorrules" || p.includes("/.cursor/rules/")) return "cursor";
  return null;
}

// Group scan rows into agent tools (display order), dropping empty groups.
export function groupSkills(rows) {
  const byTool = new Map();
  for (const r of rows) {
    const tool = classifyAgentFile(r.path, r.name);
    if (!tool) continue;
    const arr = byTool.get(tool);
    if (arr) arr.push(r);
    else byTool.set(tool, [r]);
  }
  return AGENT_TOOLS.map((t) => ({
    id: t.id,
    label: t.label,
    files: (byTool.get(t.id) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
  })).filter((g) => g.files.length > 0);
}
