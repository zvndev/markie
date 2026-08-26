// The user-editable half of the taxonomy: path rules living in Projects.md
// front matter under markie_rules. Parsed with js-yaml (renderer-only
// dependency, already vendored), validated to a strict shape, and NEVER
// allowed to take the view down: a malformed document parses to an error the
// caller pairs with the last known-good rules.
import { load } from "js-yaml";
import { splitFrontMatter } from "@/lib/front-matter";

export interface ProjectRule {
  match: string;
  project: string;
  block?: string;
}

export interface ClusteringTunables {
  gapHours: number;
  minFiles: number;
  maxBlocksPerProject: number;
  bulkMinFiles: number; // bulk-write guard: cluster size threshold
  bulkWindowMinutes: number; // bulk-write guard: mtime spread threshold
  maxBlockShare: number; // concentration guard: share of a project one block may hold
  maxBlockFiles: number; // concentration guard: absolute file ceiling for a block
}

export interface MarkieRules {
  version: 1;
  clustering: ClusteringTunables;
  rules: ProjectRule[];
  ignore: string[];
  // Places whose contents are not the user's work: an inbox, an application's
  // state directory. Hidden from the taxonomy exactly like `ignore`, but kept
  // as its own list so the shipped defaults can change without overwriting the
  // globs a user wrote by hand.
  dumpingGrounds: string[];
  // Directories that HOLD projects rather than being one. Additive to the
  // structural defaults; `notContainers` takes them back out again.
  containers: string[];
  notContainers: string[];
}

export const DEFAULT_CLUSTERING: ClusteringTunables = {
  gapHours: 24,
  minFiles: 1,
  maxBlocksPerProject: 30,
  // git clone / checkout / unzip stamp many files with near-identical mtimes;
  // a cluster this large and this tight is a bulk event, not a work session
  // (Spec 5.4).
  bulkMinFiles: 50,
  bulkWindowMinutes: 15,
  // A block holding most of its project is a bucket, not a unit of work, and
  // reads as "Markie did not organize this". Anything over these gets broken
  // up by folder (Spec 5.9 measures the same two numbers as a release gate).
  maxBlockShare: 0.4,
  maxBlockFiles: 500,
};

// A directory nobody writes their work in. `~/Downloads` is an inbox: an
// unzipped handoff bundle there is a folder somebody sent, not a project the
// user started. A hidden directory directly under home is an application's or
// an agent's state: the index walks into `~/.claude/skills` and `~/.codex` on
// purpose, because the Skills view reads them, but a tool's vendored plugin
// documentation is not the user's work and does not belong in his project
// tree. Both stay in Browse and in Skills; only the project tree is spared
// them, and both are globs the user can delete.
export const DEFAULT_DUMPING_GROUNDS: string[] = ["~/Downloads/**", "~/.*/**"];

const EMPTY_RULES: MarkieRules = {
  version: 1,
  clustering: DEFAULT_CLUSTERING,
  rules: [],
  ignore: [],
  dumpingGrounds: DEFAULT_DUMPING_GROUNDS,
  containers: [],
  notContainers: [],
};

export function parseRules(markdown: string): {
  rules: MarkieRules | null;
  error: string | null;
} {
  const { frontMatter } = splitFrontMatter(String(markdown ?? ""));
  if (!frontMatter) return { rules: EMPTY_RULES, error: null };
  const yamlBody = frontMatter
    .replace(/^---\r?\n/, "")
    .replace(/\r?\n(?:---|\.\.\.)(?:\r?\n)?$/, "");
  let doc: unknown;
  try {
    doc = load(yamlBody);
  } catch (err) {
    return { rules: null, error: err instanceof Error ? err.message : String(err) };
  }
  const raw = (doc as { markie_rules?: unknown } | null)?.markie_rules;
  if (raw == null) return { rules: EMPTY_RULES, error: null };
  if (typeof raw !== "object") {
    return { rules: null, error: "markie_rules must be a mapping" };
  }
  const r = raw as Record<string, unknown>;

  const clustering: ClusteringTunables = { ...DEFAULT_CLUSTERING };
  if (typeof r.clustering === "object" && r.clustering !== null) {
    const c = r.clustering as Record<string, unknown>;
    if (typeof c.gap_hours === "number" && c.gap_hours > 0) clustering.gapHours = c.gap_hours;
    if (typeof c.min_files === "number" && c.min_files >= 1) clustering.minFiles = c.min_files;
    if (typeof c.max_blocks_per_project === "number" && c.max_blocks_per_project >= 1) {
      clustering.maxBlocksPerProject = c.max_blocks_per_project;
    }
    if (typeof c.bulk_min_files === "number" && c.bulk_min_files >= 2) {
      clustering.bulkMinFiles = c.bulk_min_files;
    }
    if (typeof c.bulk_window_minutes === "number" && c.bulk_window_minutes > 0) {
      clustering.bulkWindowMinutes = c.bulk_window_minutes;
    }
    if (typeof c.max_block_share === "number" && c.max_block_share > 0 && c.max_block_share <= 1) {
      clustering.maxBlockShare = c.max_block_share;
    }
    if (typeof c.max_block_files === "number" && c.max_block_files >= 1) {
      clustering.maxBlockFiles = c.max_block_files;
    }
  }

  const rules: ProjectRule[] = [];
  if (r.rules !== undefined && r.rules !== null) {
    if (!Array.isArray(r.rules)) return { rules: null, error: "rules must be a list" };
    for (const [i, item] of (r.rules as unknown[]).entries()) {
      const o = item as Record<string, unknown> | null;
      if (!o || typeof o.match !== "string" || !o.match.trim()) {
        return { rules: null, error: `rule ${i + 1} needs a match pattern` };
      }
      if (typeof o.project !== "string" || !o.project.trim()) {
        return { rules: null, error: `rule ${i + 1} needs a project` };
      }
      rules.push({
        match: o.match,
        project: o.project,
        ...(typeof o.block === "string" && o.block.trim() ? { block: o.block } : {}),
      });
    }
  }

  const globList = (key: string): { list: string[] | null; error: string | null } => {
    const value = r[key];
    if (value === undefined || value === null) return { list: null, error: null };
    if (!Array.isArray(value)) return { list: null, error: `${key} must be a list` };
    const out: string[] = [];
    for (const g of value as unknown[]) {
      if (typeof g === "string" && g.trim()) out.push(g);
    }
    return { list: out, error: null };
  };

  const lists: Record<string, string[]> = {};
  // An ABSENT key means "whatever Markie ships"; a present one, even an empty
  // one, is the user's answer and replaces it. That is what lets the shipped
  // dumping grounds arrive for someone whose document predates them.
  for (const [key, fallback] of [
    ["ignore", [] as string[]],
    ["dumping_grounds", DEFAULT_DUMPING_GROUNDS],
    ["containers", [] as string[]],
    ["not_containers", [] as string[]],
  ] as Array<[string, string[]]>) {
    const { list, error } = globList(key);
    if (error) return { rules: null, error };
    lists[key] = list ?? fallback;
  }

  return {
    rules: {
      version: 1,
      clustering,
      rules,
      ignore: lists.ignore,
      dumpingGrounds: lists.dumping_grounds,
      containers: lists.containers,
      notContainers: lists.not_containers,
    },
    error: null,
  };
}

// Minimal glob: ~ expansion, * within a segment, ** across segments.
// Everything else is literal, including the characters a real folder name is
// allowed to contain (`?` and `+` in "Q&A?" or "C++" would otherwise become
// quantifiers). Backslashes normalize to / before matching so Windows paths
// behave.
export function compileGlob(pattern: string, home: string): RegExp {
  let p = pattern;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = home + "/" + p.slice(2);
  const esc = (s: string) => s.replace(/[.?+^${}()|[\]\\]/g, "\\$&");
  let out = "";
  let i = 0;
  while (i < p.length) {
    if (p.startsWith("**", i)) {
      out += ".*";
      i += 2;
      if (p[i] === "/") i += 1; // "**/" swallows the separator
    } else if (p[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += esc(p[i]);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const normalize = (p: string) => p.replace(/\\/g, "/");

function substitute(
  value: string,
  file: { dir: string; repoName: string | null }
): string | null {
  let out = value;
  if (out.includes("{repo}")) {
    if (!file.repoName) return null; // rule cannot apply without a repo
    out = out.split("{repo}").join(file.repoName);
  }
  if (out.includes("{folder}")) {
    const segs = normalize(file.dir).split("/").filter(Boolean);
    const folder = segs[segs.length - 1] ?? "";
    if (!folder) return null;
    out = out.split("{folder}").join(folder);
  }
  return out;
}

export function applyRules(
  rules: MarkieRules,
  file: { path: string; dir: string; repoName: string | null },
  home: string
): { project: string; block: string | null } | { ignored: true } | null {
  const p = normalize(file.path);
  const h = normalize(home);
  for (const g of rules.ignore) {
    if (compileGlob(normalize(g), h).test(p)) return { ignored: true };
  }
  for (const g of rules.dumpingGrounds) {
    if (compileGlob(normalize(g), h).test(p)) return { ignored: true };
  }
  for (const rule of rules.rules) {
    if (!compileGlob(normalize(rule.match), h).test(p)) continue;
    const project = substitute(rule.project, file);
    if (project === null) continue; // substitution unavailable: fall through
    const block = rule.block ? substitute(rule.block, file) : null;
    return { project, block };
  }
  return null;
}
