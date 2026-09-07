// The Skills panel's vocabulary: which tool a skill belongs to, how a target
// and a licence are named on screen, and the two preferences the panel keeps.
//
// Kept out of the component because every one of these is a plain question
// with a plain answer, and because the grouping in particular is easy to get
// subtly wrong: the panel groups by the *tool whose folder the skill lives in*,
// which is not the same question as "which tool wrote this file" that
// classifyAgentFile answers for instruction files.
import { classifyAgentFile, isCachedAgentPath, type AgentKind } from "@/lib/agent-files";
import type { CatalogSkill, MdRow, SearchHit, SkillSource, SkillTarget } from "@/lib/electron";

// ── The two tabs ──

export type SkillsTab = "installed" | "discover";

export const SKILLS_TAB_KEY = "markie.skills.tab.v1";
export const SKILLS_TARGETS_KEY = "markie.skills.targets.v1";

// Installed is the default: it is the answer to "what do my agents have",
// which is the question you open this panel with. Discover is where you go on
// purpose.
export function initialSkillsTab(read: (key: string) => string | null): SkillsTab {
  try {
    return read(SKILLS_TAB_KEY) === "discover" ? "discover" : "installed";
  } catch {
    // localStorage throws outright in a private window or with site data
    // blocked, and a remembered tab is not worth an unmounted panel.
    return "installed";
  }
}

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
  if (skill?.tool) return skill.tool;
  const tool = classifyAgentFile(path, name);
  if (tool) return tool === "openai" ? "codex" : tool;
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (isCachedAgentPath(p)) return null;
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

// ── Targets ──

const TARGET_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  universal: "Universal",
};

/** The string main stores a target as, and the identity the panel compares on. */
export function targetKey(target: SkillTarget): string {
  return typeof target === "string" ? target : `project:${target.project}`;
}

export function targetLabel(target: SkillTarget): string {
  if (typeof target === "string") return TARGET_LABELS[target] ?? target;
  const segments = target.project.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? target.project;
}

// A project install lands in that project's own .claude/skills, so it belongs
// under Claude. The row says which project, because that is the part the group
// heading cannot.
export function groupForTarget(target: SkillTarget): SkillGroupId {
  return typeof target === "string" ? target : "claude";
}

/** Claude Code, until the user says otherwise. */
export function readRememberedTargets(read: (key: string) => string | null): SkillTarget[] {
  let raw: string | null = null;
  try {
    raw = read(SKILLS_TARGETS_KEY);
  } catch {
    return ["claude"];
  }
  if (!raw) return ["claude"];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ["claude"];
    const out: SkillTarget[] = [];
    for (const entry of parsed) {
      if (typeof entry === "string" && entry in TARGET_LABELS) out.push(entry as SkillTarget);
      else if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { project?: unknown }).project === "string"
      ) {
        out.push({ project: (entry as { project: string }).project });
      }
    }
    return out.length > 0 ? out : ["claude"];
  } catch {
    return ["claude"];
  }
}

export function writeRememberedTargets(
  write: (key: string, value: string) => void,
  targets: SkillTarget[]
): void {
  try {
    write(SKILLS_TARGETS_KEY, JSON.stringify(targets));
  } catch {
    /* a preference that will not save is not worth a broken install */
  }
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and 1 more". */
export function formatDestinations(targets: SkillTarget[]): string {
  const names = targets.map(targetLabel);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// The button says what it is about to do to which place. "Add skill" left the
// user to remember what they had ticked three rows above it.
export function installLabel(targets: SkillTarget[], updating: boolean): string {
  if (targets.length === 0) return "Add skill";
  if (targets.length === 1) {
    return updating ? `Update in ${targetLabel(targets[0])}` : `Add to ${targetLabel(targets[0])}`;
  }
  return updating ? `Update in ${targets.length} targets` : `Add to ${targets.length} targets`;
}

/** What a target means, for the two nobody can infer from the name. */
export const UNIVERSAL_HINT = "~/.agents/skills, read by every tool that looks there";
export const PROJECT_HINT = "this workspace's .claude/skills folder";

// ── Rows ──

// The badge under a catalog row. A repository that ships no LICENSE says so
// rather than pretending: "License in repo" is the honest answer when the
// front matter is silent, and anything that reads as "you may not copy this"
// gets one word so it cannot be skimmed past.
export function licenseBadge(license: string | null | undefined): string {
  const text = String(license ?? "").trim();
  if (!text) return "License in repo";
  const lower = text.toLowerCase();
  if (lower.includes("proprietary") || lower.includes("all rights reserved")) {
    return "Proprietary";
  }
  return text;
}

/** Said once, in the detail pane, where there is room to act on it. */
export const LICENSE_NOTE = "Review the licence before installing";

export const PROPRIETARY_NOTE =
  "The repository states this skill is proprietary. Read its licence before you use it.";

// A licence name reads as a badge. A sentence does not: "Complete terms in
// LICENSE.txt" is what anthropics/skills writes, and one of those under every
// row in the catalog was the loudest thing on the list. Rows keep the name or
// nothing; the sentence is represented in the detail pane by LICENSE_NOTE.
const LICENSE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.+ -]{0,19}$/;

export function licenseChip(license: string | null | undefined): string | null {
  const badge = licenseBadge(license);
  if (badge === "Proprietary") return badge;
  if (badge === "License in repo") return null;
  return LICENSE_NAME_RE.test(badge) ? badge : null;
}

export function matchesSkill(
  skill: Pick<CatalogSkill, "name" | "description">,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.name.toLowerCase().includes(q) ||
    String(skill.description ?? "").toLowerCase().includes(q)
  );
}

export function formatSize(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Resolving a skills.sh hit ──
//
// skills.sh names the pdf skill `anthropics/skills/pdf`. Discovery finds it in
// that repository's `skills/` container and calls it
// `anthropics/skills/skills/pdf`. The two ids are not the same string and never
// were, so a hit has to be matched against the catalog by what it is (this
// source, this skill folder) rather than looked up by id.

/** The skill part of a hit's id: "anthropics/skills/pdf" over "anthropics/skills" is "pdf". */
export function hitSkillKey(hit: Pick<SearchHit, "id" | "source" | "name">): string {
  const id = String(hit.id ?? "");
  const source = String(hit.source ?? "");
  const rest = source && id.startsWith(`${source}/`) ? id.slice(source.length + 1) : id;
  const last = rest.split(/[\\/]/).filter(Boolean).pop();
  return String(last || hit.name || "").toLowerCase();
}

export function resolveHit(
  hit: Pick<SearchHit, "id" | "source" | "name">,
  skills: CatalogSkill[]
): CatalogSkill | null {
  const wanted = new Set([hitSkillKey(hit), String(hit.name ?? "").toLowerCase()].filter(Boolean));
  if (wanted.size === 0) return null;
  const same = skills.filter((skill) => skill.source === hit.source);
  // The folder is the identity skills.sh indexes, so it is asked first across
  // the whole source; a skill that merely shares the name is the fallback.
  const byFolder = same.find((skill) => {
    const folder = String(skill.skillPath ?? "").split(/[\\/]/).filter(Boolean).pop();
    return wanted.has(String(folder ?? "").toLowerCase());
  });
  if (byFolder) return byFolder;
  return same.find((skill) => wanted.has(skill.name.toLowerCase())) ?? null;
}

// ── When the catalog was last fetched ──

export function newestFetchedAt(sources: Pick<SkillSource, "fetchedAt">[]): number | null {
  let newest: number | null = null;
  for (const source of sources) {
    if (!source.fetchedAt) continue;
    const at = Date.parse(source.fetchedAt);
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

export function describeChecked(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "Catalog updated just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Catalog updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Catalog updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `Catalog updated ${days} day${days === 1 ? "" : "s"} ago`;
}

// ── Adding a source ──

// The same shape the main process accepts, so the panel refuses what main
// would silently drop. Main answers an unparseable name with the unchanged
// catalog and no error at all, which on screen reads as the button being dead.
export const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function ownerRepoError(value: string): string | null {
  const text = value.trim();
  if (!text) return "Type a repository, like anthropics/skills.";
  if (!OWNER_REPO_RE.test(text)) {
    return "That is not an owner/repo name. Try anthropics/skills.";
  }
  return null;
}
