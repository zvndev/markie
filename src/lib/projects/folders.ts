// Auto folders: saved questions about the whole index.
//
// A folder is a VIEW, never a container. Nothing here moves a file, changes an
// assignment, or takes a file out of the project it belongs to. "Updated today"
// and "alt-ui" can both hold the same file at the same time, which is why every
// folder carries its files already grouped by the project they still live in:
// the grouping is the explanation.
import { compileGlob, type FolderRule } from "@/lib/projects/rules";
import { byRecencyUnfiledLast, type FileNode, type ProjectNode } from "@/lib/projects/taxonomy";

export interface FolderProjectGroup {
  projectKey: string;
  projectName: string;
  isUnfiled: boolean;
  updated: number;
  files: FileNode[];
}

export interface FolderNode {
  id: string;
  name: string;
  // False for the three Markie ships, true for anything out of Projects.md.
  custom: boolean;
  // The folder's own rule, in words, for its header. A grouping nobody can
  // explain is a grouping nobody trusts.
  rule: string;
  count: number;
  projectCount: number;
  updated: number;
  groups: FolderProjectGroup[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The three that ship. Deliberately nested: midnight today is never more than
// a day ago, so every file in "today" is also in the three-day and the week
// folder. A file that appeared in the narrow folder and vanished from the wide
// one would read as a bug in the counts.
export const BUILTIN_FOLDER_NAMES = [
  "Updated today",
  "Updated in the past 3 days",
  "Updated in the past week",
] as const;

function windowWords(ms: number): string {
  if (ms % DAY_MS === 0) {
    const days = ms / DAY_MS;
    if (days === 1) return "the last day";
    if (days === 7) return "the last 7 days";
    return `the last ${days} days`;
  }
  const hours = Math.round(ms / HOUR_MS);
  return `the last ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function describeFolder(rule: { withinMs: number | null; match: string | null }): string {
  const parts: string[] = [];
  if (rule.withinMs !== null) parts.push(`edited in ${windowWords(rule.withinMs)}`);
  if (rule.match) parts.push(`stored under ${rule.match}`);
  if (!parts.length) return "Every file Markie has indexed.";
  return `Files ${parts.join(" and ")}.`;
}

interface Matcher {
  id: string;
  name: string;
  custom: boolean;
  rule: string;
  since: number | null;
  glob: RegExp | null;
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "folder";

// User folders are matched to built-ins by name, so redefining "Updated today"
// with a different window replaces it instead of leaving two rows that claim
// the same thing. That is the whole escape hatch for the shipped three, and it
// costs no extra syntax.
export function buildMatchers(
  custom: FolderRule[],
  opts: { now: number; home: string }
): Matcher[] {
  const midnight = startOfDay(opts.now);
  const out: Matcher[] = [
    { id: "today", name: BUILTIN_FOLDER_NAMES[0], custom: false, rule: "Files edited since midnight.", since: midnight, glob: null },
    { id: "days3", name: BUILTIN_FOLDER_NAMES[1], custom: false, rule: describeFolder({ withinMs: 3 * DAY_MS, match: null }), since: opts.now - 3 * DAY_MS, glob: null },
    { id: "week", name: BUILTIN_FOLDER_NAMES[2], custom: false, rule: describeFolder({ withinMs: 7 * DAY_MS, match: null }), since: opts.now - 7 * DAY_MS, glob: null },
  ];
  const byName = new Map(out.map((m, i) => [m.name.toLowerCase(), i]));
  const used = new Set(out.map((m) => m.id));
  for (const rule of custom) {
    const next: Matcher = {
      id: "",
      name: rule.name,
      custom: true,
      rule: describeFolder(rule),
      since: rule.withinMs === null ? null : opts.now - rule.withinMs,
      glob: rule.match ? compileGlob(rule.match.replace(/\\/g, "/"), opts.home.replace(/\\/g, "/")) : null,
    };
    // Only the built-ins can be replaced by name, and only once. Two user
    // folders that happen to share a name are two folders: the second was
    // typed on purpose, and silently overwriting the first would lose it.
    const replaces = byName.get(rule.name.toLowerCase());
    if (replaces !== undefined) {
      byName.delete(rule.name.toLowerCase());
      next.id = out[replaces].id;
      out[replaces] = next;
      continue;
    }
    // Two user folders may legitimately share a name shape ("Specs" twice);
    // the second gets its own id rather than silently overwriting the first.
    let id = `u-${slug(rule.name)}`;
    let n = 2;
    while (used.has(id)) id = `u-${slug(rule.name)}-${n++}`;
    used.add(id);
    next.id = id;
    out.push(next);
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, "/");

export function computeFolders(
  projects: ProjectNode[],
  custom: FolderRule[],
  opts: { now: number; home: string }
): FolderNode[] {
  const matchers = buildMatchers(custom, opts);
  const groups = matchers.map(() => new Map<string, FolderProjectGroup>());

  for (const project of projects) {
    const files: FileNode[] = [];
    for (const block of project.blocks) files.push(...block.files);
    files.push(...project.looseFiles);
    if (!files.length) continue;
    for (const file of files) {
      const path = norm(file.path);
      for (let i = 0; i < matchers.length; i++) {
        const m = matchers[i];
        if (m.since !== null && file.mtimeMs < m.since) continue;
        if (m.glob && !m.glob.test(path)) continue;
        let group = groups[i].get(project.key);
        if (!group) {
          group = {
            projectKey: project.key,
            projectName: project.name,
            isUnfiled: project.isUnfiled,
            updated: 0,
            files: [],
          };
          groups[i].set(project.key, group);
        }
        group.files.push(file);
        if (file.mtimeMs > group.updated) group.updated = file.mtimeMs;
      }
    }
  }

  return matchers.map((m, i) => {
    const list = [...groups[i].values()];
    for (const g of list) g.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    list.sort(byRecencyUnfiledLast);
    let count = 0;
    let updated = 0;
    for (const g of list) {
      count += g.files.length;
      if (g.updated > updated) updated = g.updated;
    }
    return {
      id: m.id,
      name: m.name,
      custom: m.custom,
      rule: m.rule,
      count,
      projectCount: list.length,
      updated,
      groups: list,
    };
  });
}

// Search inside one folder: the same "name or path" test the project search
// uses, applied to the groups so an empty project group drops out entirely.
export function filterFolder(folder: FolderNode, filter: string): FolderNode {
  const q = filter.trim().toLowerCase();
  if (!q) return folder;
  const groups: FolderProjectGroup[] = [];
  let count = 0;
  for (const g of folder.groups) {
    const wholeProject = g.projectName.toLowerCase().includes(q);
    const files = wholeProject
      ? g.files
      : g.files.filter(
          (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
        );
    if (!files.length) continue;
    groups.push({ ...g, files });
    count += files.length;
  }
  return { ...folder, groups, count, projectCount: groups.length };
}
