// The locked precedence ladder, first match wins:
//   1. manual pin  2. front matter  3. path rule  4. derived fallback.
// Derivation here decides only the PROJECT; block derivation (clustering)
// runs later, per project, in cluster.ts.
import { applyRules, type MarkieRules } from "@/lib/projects/rules";

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
function containers(home: string): string[] {
  const h = norm(home).replace(/\/+$/, "");
  return [h, `${h}/Desktop`, `${h}/Documents`, `${h}/Downloads`];
}

// The highest ancestor of `dir` that sits directly under a container, or null
// (a file living directly in a container has no project of its own). Deeper
// containers win: ~/Documents/Thesis resolves against ~/Documents, not
// against ~, so the project is "Thesis" and not "Documents".
export function containerChild(dir: string, home: string): string | null {
  const d = norm(dir).replace(/\/+$/, "");
  let best: string | null = null;
  let bestContainerLen = -1;
  for (const c of containers(home)) {
    if (d === c) return null; // the file sits directly in a container
    if (!d.startsWith(c + "/")) continue;
    const rest = d.slice(c.length + 1);
    const first = rest.split("/").filter(Boolean)[0] ?? null;
    if (first && c.length > bestContainerLen) {
      best = first;
      bestContainerLen = c.length;
    }
  }
  return best;
}

export function assignProjects(
  files: EngineFile[],
  opts: { pins: Pin[]; rules: MarkieRules; home: string }
): { assignments: ProjectAssignment[]; ignored: number } {
  const pinByPath = new Map(opts.pins.map((p) => [p.path, p]));
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
    const project = file.repoName ?? containerChild(file.dir, opts.home) ?? UNFILED;
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
