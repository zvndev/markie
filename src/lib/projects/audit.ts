// The release gate for the organization engine, expressed as pure functions so
// it can be tested without a database and run from a script against the real
// one. Spec 5.9 defines the thresholds; nothing here may relax them, and the
// script that calls this only supplies I/O.
import type { ProjectNode, Taxonomy } from "@/lib/projects/taxonomy";

export interface LargestBlock {
  name: string;
  files: number;
  sharePct: number;
}

export interface AuditProjectRow {
  name: string;
  files: number;
  blocks: number;
  largestBlock: LargestBlock | null;
  updated: string;
}

export interface AuditReport {
  generatedAt: string;
  // Rows read out of the index.
  indexedFiles: number;
  // Rows the engine actually placed. Lower than indexedFiles when the config
  // document ignores paths, which is why the shares below use this one.
  organizedFiles: number;
  ignoredFiles: number;
  engineMs: number;
  projects: number;
  blocks: number;
  unfiled: number;
  unfiledPct: number;
  singletonBlocks: number;
  singletonBlockPct: number;
  // Files sitting directly under a project because nothing clustered with
  // them. These used to be blocks of one, and this number is where that noise
  // went: it is the count to watch now, not the singleton share.
  looseFiles: number;
  looseFilePct: number;
  rulesError: string | null;
  top20: AuditProjectRow[];
  largestBlocks: Array<{ project: string; files: number; largest: LargestBlock }>;
}

export interface GateFailure {
  gate: "unfiled" | "block-cap" | "concentration-share" | "concentration-ceiling";
  message: string;
}

// Spec 5.9. These are the gate, not a preference: tune the heuristic to meet
// them, never the other way around.
export const AUDIT_GATES = {
  unfiledPct: 20,
  concentrationShare: 0.4,
  concentrationMinProject: 10,
  blockCeiling: 500,
} as const;

const pct = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : 0;

export function largestBlockOf(project: ProjectNode): LargestBlock | null {
  let best: ProjectNode["blocks"][number] | null = null;
  for (const b of project.blocks) {
    if (!best || b.files.length > best.files.length) best = b;
  }
  if (!best) return null;
  return {
    // BlockNode.name is already custom_name ?? auto_name, so this is the name
    // the user would actually read in the tree.
    name: best.name,
    files: best.files.length,
    sharePct: pct(best.files.length, project.fileCount),
  };
}

export function buildAuditReport(
  taxonomy: Taxonomy,
  opts: {
    indexedFiles: number;
    engineMs: number;
    rulesError: string | null;
    now?: () => number;
  }
): AuditReport {
  const now = opts.now ?? Date.now;
  const blocks = taxonomy.projects.reduce((n, p) => n + p.blocks.length, 0);
  const singletons = taxonomy.projects.reduce(
    (n, p) => n + p.blocks.filter((b) => b.files.length === 1).length,
    0
  );
  const loose = taxonomy.projects.reduce((n, p) => n + p.looseFiles.length, 0);
  return {
    generatedAt: new Date(now()).toISOString(),
    indexedFiles: opts.indexedFiles,
    organizedFiles: taxonomy.totalFiles,
    ignoredFiles: taxonomy.ignoredCount,
    engineMs: opts.engineMs,
    projects: taxonomy.projects.length,
    blocks,
    unfiled: taxonomy.unfiledCount,
    unfiledPct: pct(taxonomy.unfiledCount, taxonomy.totalFiles),
    singletonBlocks: singletons,
    singletonBlockPct: pct(singletons, blocks),
    looseFiles: loose,
    looseFilePct: pct(loose, taxonomy.totalFiles),
    rulesError: opts.rulesError,
    top20: taxonomy.projects.slice(0, 20).map((p) => ({
      name: p.name,
      files: p.fileCount,
      blocks: p.blocks.length,
      largestBlock: largestBlockOf(p),
      updated: new Date(p.updated).toISOString(),
    })),
    largestBlocks: taxonomy.projects
      .map((p) => ({ project: p.name, files: p.fileCount, largest: largestBlockOf(p) }))
      .filter((e): e is { project: string; files: number; largest: LargestBlock } => !!e.largest)
      .sort((a, b) => b.largest.files - a.largest.files)
      .slice(0, 20),
  };
}

export function evaluateGates(
  taxonomy: Taxonomy,
  report: AuditReport,
  maxBlocksPerProject: number
): GateFailure[] {
  const failures: GateFailure[] = [];
  if (report.unfiledPct >= AUDIT_GATES.unfiledPct) {
    failures.push({
      gate: "unfiled",
      message: `unfiled ${report.unfiledPct}% of ${report.organizedFiles} organized files (must be under ${AUDIT_GATES.unfiledPct}%)`,
    });
  }
  const over = taxonomy.projects.filter((p) => p.blocks.length > maxBlocksPerProject);
  if (over.length) {
    failures.push({
      gate: "block-cap",
      message: `${over.length} project(s) exceed the ${maxBlocksPerProject} block cap after adaptation: ${over
        .slice(0, 5)
        .map((p) => `${p.name} (${p.blocks.length})`)
        .join(", ")}`,
    });
  }
  // A bulk write (clone, checkout, unzip) stamps thousands of files with the
  // same minute. Without this pair of guards it lands as one giant "session"
  // that the counts above cannot see anything wrong with.
  for (const project of taxonomy.projects) {
    const lb = largestBlockOf(project);
    if (!lb) continue;
    if (
      project.fileCount >= AUDIT_GATES.concentrationMinProject &&
      lb.files > project.fileCount * AUDIT_GATES.concentrationShare
    ) {
      failures.push({
        gate: "concentration-share",
        message: `block "${lb.name}" holds ${lb.files}/${project.fileCount} files (${lb.sharePct}%) of project "${project.name}" (max ${AUDIT_GATES.concentrationShare * 100}%)`,
      });
    }
    if (lb.files > AUDIT_GATES.blockCeiling) {
      failures.push({
        gate: "concentration-ceiling",
        message: `block "${lb.name}" in project "${project.name}" holds ${lb.files} files (ceiling ${AUDIT_GATES.blockCeiling})`,
      });
    }
  }
  return failures;
}
