// The locked precedence ladder, first match wins:
//   1. manual pin  2. front matter  3. path rule  4. derived fallback.
// Derivation here decides only the PROJECT; block derivation (clustering)
// runs later, per project, in cluster.ts.
import { applyRules, compileGlob, type MarkieRules } from "@/lib/projects/rules";

export interface EngineFile {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
  birthtimeMs: number | null;
  fmProject: string | null;
  fmBlock: string | null;
  repoName: string | null;
}

export interface Pin {
  path: string;
  project: string;
  block_id: string | null;
}

export type AssignmentSource = "pin" | "frontmatter" | "rule" | "derived";

export interface ProjectAssignment {
  path: string;
  project: string;
  fixedBlock: string | null;
  pinnedBlockId: string | null;
  source: AssignmentSource;
}

export const UNFILED = "Unfiled";

const norm = (p: string) => p.replace(/\\/g, "/");

// The directories whose direct children are project-shaped. A file living
// DIRECTLY in one of these has no project of its own.
const DEFAULT_CONTAINER_NAMES = ["Desktop", "Documents", "Downloads"];

const trim = (p: string) => norm(p).replace(/\/+$/, "");

function defaultContainers(home: string): Set<string> {
  const h = trim(home);
  return new Set([h, ...DEFAULT_CONTAINER_NAMES.map((n) => `${h}/${n}`)]);
}

// How many different repositories have to live under a directory before it is
// a place you keep projects rather than a project. Two sibling checkouts can
// be one piece of work; a third says the directory is a shelf.
export const CONTAINER_MIN_REPOS = 3;

// How far below home the search for shelves goes. A container is structural
// and sits near the top of a home directory; six levels down you are inside
// somebody's work, and counting there would only cost time.
const MAX_CONTAINER_DEPTH = 6;

function relSegments(dir: string, home: string): string[] | null {
  const d = trim(dir);
  const h = trim(home);
  if (d === h) return [];
  if (!d.startsWith(h + "/")) return null;
  return d.slice(h.length + 1).split("/").filter(Boolean);
}

// Directories holding several different repositories, found by walking what is
// actually on this disk rather than by knowing anybody's folder names.
export function discoverContainers(files: EngineFile[], home: string): Set<string> {
  const h = trim(home);
  const reposUnder = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.repoName) continue;
    const segs = relSegments(file.dir, home);
    if (!segs) continue;
    let at = h;
    for (let i = 0; i < segs.length && i < MAX_CONTAINER_DEPTH; i++) {
      let seen = reposUnder.get(at);
      if (!seen) {
        seen = new Set();
        reposUnder.set(at, seen);
      }
      seen.add(file.repoName);
      at = `${at}/${segs[i]}`;
    }
  }
  const out = new Set<string>();
  for (const [dir, repos] of reposUnder) {
    if (repos.size >= CONTAINER_MIN_REPOS) out.add(dir);
  }
  return out;
}

// The project a path falls in: walk down from home stepping through every
// directory that holds projects rather than being one, and stop at the first
// that is a project itself. Deeper containers therefore win on their own,
// without a special case: ~/Documents/Thesis resolves against ~/Documents, so
// the project is "Thesis" and not "Documents", and ~/Desktop/Coding/ZVN/research
// keeps walking past two shelves to reach the folder the work is actually in.
// A file sitting directly in a container has no project of its own.
export function containerChild(
  dir: string,
  home: string,
  isContainer: (dirPath: string) => boolean = () => false
): string | null {
  const segs = relSegments(dir, home);
  if (!segs) return null;
  const h = trim(home);
  const defaults = defaultContainers(h);
  const container = (d: string) => defaults.has(d) || isContainer(d);
  let at = h;
  for (const seg of segs) {
    if (!container(at)) break;
    at = `${at}/${seg}`;
  }
  if (at === h || container(at)) return null;
  return at.slice(at.lastIndexOf("/") + 1);
}

export function assignProjects(
  files: EngineFile[],
  opts: { pins: Pin[]; rules: MarkieRules; home: string }
): { assignments: ProjectAssignment[]; ignored: number } {
  const pinByPath = new Map(opts.pins.map((p) => [p.path, p]));
  const discovered = discoverContainers(files, opts.home);
  const extra = opts.rules.containers.map((g) => compileGlob(g, opts.home));
  const exempt = opts.rules.notContainers.map((g) => compileGlob(g, opts.home));
  const isContainer = (dirPath: string) => {
    if (exempt.some((re) => re.test(dirPath))) return false;
    return discovered.has(dirPath) || extra.some((re) => re.test(dirPath));
  };
  const out: ProjectAssignment[] = [];
  let ignored = 0;
  for (const file of files) {
    const pin = pinByPath.get(file.path);
    if (pin) {
      out.push({
        path: file.path,
        project: pin.project,
        fixedBlock: null,
        pinnedBlockId: pin.block_id,
        source: "pin",
      });
      continue;
    }
    if (file.fmProject) {
      out.push({
        path: file.path,
        project: file.fmProject,
        fixedBlock: file.fmBlock,
        pinnedBlockId: null,
        source: "frontmatter",
      });
      continue;
    }
    const ruled = applyRules(opts.rules, file, opts.home);
    if (ruled && "ignored" in ruled) {
      ignored += 1;
      continue;
    }
    if (ruled) {
      out.push({
        path: file.path,
        project: ruled.project,
        fixedBlock: ruled.block,
        pinnedBlockId: null,
        source: "rule",
      });
      continue;
    }
    const project = file.repoName ?? containerChild(file.dir, opts.home, isContainer) ?? UNFILED;
    out.push({
      path: file.path,
      project,
      fixedBlock: null,
      pinnedBlockId: null,
      source: "derived",
    });
  }
  return { assignments: out, ignored };
}
