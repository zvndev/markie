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
}

export interface MarkieRules {
  version: 1;
  clustering: ClusteringTunables;
  rules: ProjectRule[];
  ignore: string[];
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
};

const EMPTY_RULES: MarkieRules = {
  version: 1,
  clustering: DEFAULT_CLUSTERING,
  rules: [],
  ignore: [],
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

  const ignore: string[] = [];
  if (r.ignore !== undefined && r.ignore !== null) {
    if (!Array.isArray(r.ignore)) return { rules: null, error: "ignore must be a list" };
    for (const g of r.ignore as unknown[]) {
      if (typeof g === "string" && g.trim()) ignore.push(g);
    }
  }

  return { rules: { version: 1, clustering, rules, ignore }, error: null };
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
  for (const rule of rules.rules) {
    if (!compileGlob(normalize(rule.match), h).test(p)) continue;
    const project = substitute(rule.project, file);
    if (project === null) continue; // substitution unavailable: fall through
    const block = rule.block ? substitute(rule.block, file) : null;
    return { project, block };
  }
  return null;
}
