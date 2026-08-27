// Assembles the full tree the UI renders: assignments (the ladder), then
// per-project block derivation (fixed blocks from fm/rules/pins first,
// clustering for the rest), then most-recent-first ordering everywhere.
import {
  assignProjects,
  UNFILED,
  type AssignmentSource,
  type EngineFile,
  type Pin,
  type ProjectAssignment,
} from "@/lib/projects/assign";
import { deriveBlocks, type BlockRecord, type PriorAssignment } from "@/lib/projects/cluster";
import type { MarkieRules } from "@/lib/projects/rules";

/**
 * Most recent first, except that Unfiled always sorts last however fresh it is.
 *
 * Unfiled is not a project competing on recency. It is the residue of every
 * file no rule could place, and it changes whenever any loose file anywhere
 * does, so it is almost always the most recently touched thing in the
 * taxonomy. Sorting it purely by recency therefore pins the one card that
 * means "Markie could not place these" to the largest, first position on the
 * page, more or less permanently.
 *
 * This deliberately overrides design spec 5.2, which asked for Unfiled to be
 * "sorted by recency like any other but visually distinguished". Being
 * visually distinguished does not help when it is also always first.
 *
 * Shared by the project grid and by the group list inside a folder, so the two
 * cannot drift apart.
 */
export function byRecencyUnfiledLast<T extends { isUnfiled: boolean; updated: number }>(
  a: T,
  b: T
): number {
  if (a.isUnfiled !== b.isUnfiled) return a.isUnfiled ? 1 : -1;
  return b.updated - a.updated;
}


export type FileNode = EngineFile;

export interface BlockNode {
  id: string;
  name: string;
  made: number;
  updated: number;
  files: FileNode[];
}

// A row in the registry's `projects` table: the user's own name for a project,
// and whether they made the project themselves. Snake_case because it crosses
// IPC exactly as SQLite hands it over, like BlockRecord.
export interface ProjectNameRecord {
  project: string;
  custom_name: string | null;
  user_created: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectNode {
  // What the engine derived and what every stored decision is keyed by: a pin,
  // a block, a rename. Renaming a project must not orphan its pins, so the key
  // never changes and only the display name does.
  key: string;
  // What the user reads: their own name if they gave one, otherwise the key.
  name: string;
  made: number;
  updated: number;
  fileCount: number;
  blocks: BlockNode[];
  // Files that never clustered with anything. They sit directly under the
  // project rather than each inside a block of one, which is a file wearing a
  // folder costume and, several hundred times over, is noise instead of
  // organization.
  looseFiles: FileNode[];
  isUnfiled: boolean;
}

export interface AssignmentRow {
  path: string;
  project: string;
  blockId: string | null;
  source: AssignmentSource;
  mtimeMs: number;
}

export interface Taxonomy {
  projects: ProjectNode[];
  totalFiles: number;
  unfiledCount: number;
  ignoredCount: number;
  assignmentRows: AssignmentRow[];
  blockUpserts: BlockRecord[];
}

// A stable id for a block fixed by name (front matter or a rule): the same
// declaration lands in the same block everywhere.
const fixedBlockId = (project: string, block: string) => `f_${project}::${block}`;

function minOf(values: number[]): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}
function maxOf(values: number[]): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function buildTaxonomy(
  files: EngineFile[],
  opts: {
    pins: Pin[];
    rules: MarkieRules;
    priorAssignments: PriorAssignment[];
    knownBlocks: BlockRecord[];
    home: string;
    // User renames, and the projects the user made rather than Markie deriving
    // them. Absent means neither has happened yet.
    projectNames?: ProjectNameRecord[];
    now?: () => number;
  }
): Taxonomy {
  const now = opts.now ?? Date.now;
  const named = new Map((opts.projectNames ?? []).map((r) => [r.project, r]));
  const displayName = (key: string) => named.get(key)?.custom_name?.trim() || key;
  const { assignments, ignored } = assignProjects(files, {
    pins: opts.pins,
    rules: opts.rules,
    home: opts.home,
  });
  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const priorByPath = new Map(opts.priorAssignments.map((p) => [p.path, p]));
  const knownById = new Map(opts.knownBlocks.map((b) => [b.block_id, b]));

  const byProject = new Map<string, ProjectAssignment[]>();
  const knownByProject = new Map<string, BlockRecord[]>();
  for (const a of assignments) {
    const arr = byProject.get(a.project);
    if (arr) arr.push(a);
    else byProject.set(a.project, [a]);
  }
  for (const b of opts.knownBlocks) {
    const arr = knownByProject.get(b.project);
    if (arr) arr.push(b);
    else knownByProject.set(b.project, [b]);
  }

  const assignmentRows: AssignmentRow[] = [];
  const blockUpserts: BlockRecord[] = [];
  const projects: ProjectNode[] = [];

  for (const [project, members] of byProject) {
    // Blocks the ladder already decided, and the files left for clustering.
    const blockFiles = new Map<string, EngineFile[]>();
    const declaredName = new Map<string, string>();
    const toCluster: EngineFile[] = [];
    const sourceByPath = new Map<string, AssignmentSource>();
    const addTo = (id: string, f: EngineFile) => {
      const arr = blockFiles.get(id);
      if (arr) arr.push(f);
      else blockFiles.set(id, [f]);
    };

    // Collected per project so a block that dissolves below can take its rows
    // back down to "no block" before they reach the caller.
    const projectRows: AssignmentRow[] = [];

    for (const a of members) {
      const f = fileByPath.get(a.path);
      if (!f) continue;
      const fixedId = a.pinnedBlockId ?? (a.fixedBlock ? fixedBlockId(project, a.fixedBlock) : null);
      if (!fixedId) {
        toCluster.push(f);
        sourceByPath.set(f.path, a.source);
        continue;
      }
      if (a.fixedBlock) declaredName.set(fixedId, a.fixedBlock);
      addTo(fixedId, f);
      projectRows.push({
        path: a.path,
        project,
        blockId: fixedId,
        source: a.source,
        mtimeMs: f.mtimeMs,
      });
    }

    // Clustering sees only this project's history: a prior assignment from
    // another project is not evidence about this one, and feeding every
    // project the whole table would be quadratic on a real index.
    const projectPriors: PriorAssignment[] = [];
    for (const f of toCluster) {
      const p = priorByPath.get(f.path);
      if (p) projectPriors.push(p);
    }
    const derived = deriveBlocks(
      project,
      toCluster,
      projectPriors,
      knownByProject.get(project) ?? [],
      opts.rules.clustering,
      now
    );
    const derivedById = new Map(derived.blocks.map((b) => [b.block_id, b]));
    for (const f of toCluster) {
      const id = derived.byPath.get(f.path) ?? null;
      if (id) addTo(id, f);
      projectRows.push({
        path: f.path,
        project,
        blockId: id,
        source: sourceByPath.get(f.path) ?? "derived",
        mtimeMs: f.mtimeMs,
      });
    }

    // Every block the tree shows gets a durable row, not only the clustered
    // ones: a rename writes to project_blocks by id, and an UPDATE against a
    // row that was never inserted is a silently discarded decision.
    const blocks: BlockNode[] = [];
    const looseFiles: FileNode[] = [];
    const dissolved = new Set<string>();
    for (const [id, entryFiles] of blockFiles) {
      const known = knownById.get(id);
      const drv = derivedById.get(id);
      // A block of one is a file with a folder drawn around it. Derived ones
      // dissolve and the file sits directly under its project. A block the
      // user named or merged, one a document declared in its own front matter,
      // and one a file was pinned into are all decisions, and a decision keeps
      // its block however small it is.
      if (entryFiles.length === 1 && drv && !known?.custom_name && !known?.merged_into) {
        looseFiles.push(entryFiles[0]);
        dissolved.add(id);
        continue;
      }
      const auto = drv?.auto_name ?? known?.auto_name ?? declaredName.get(id) ?? id;
      const times = entryFiles.map((f) => f.mtimeMs);
      const births = entryFiles.map((f) => f.birthtimeMs ?? f.mtimeMs);
      const made = minOf(births);
      const updated = maxOf(times);
      blocks.push({
        id,
        name: known?.custom_name ?? auto,
        made,
        updated,
        files: [...entryFiles].sort((a, b) => b.mtimeMs - a.mtimeMs),
      });
      blockUpserts.push({
        block_id: id,
        project,
        auto_name: auto,
        custom_name: known?.custom_name ?? null,
        merged_into: known?.merged_into ?? null,
        created_at: known?.created_at ?? new Date(made).toISOString(),
        updated_at: new Date(updated).toISOString(),
      });
    }
    blocks.sort((a, b) => b.updated - a.updated);
    looseFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const row of projectRows) {
      assignmentRows.push(
        row.blockId && dissolved.has(row.blockId) ? { ...row, blockId: null } : row
      );
    }

    const madeTimes = [
      ...blocks.map((b) => b.made),
      ...looseFiles.map((f) => f.birthtimeMs ?? f.mtimeMs),
    ];
    const updatedTimes = [...blocks.map((b) => b.updated), ...looseFiles.map((f) => f.mtimeMs)];
    projects.push({
      key: project,
      name: displayName(project),
      made: madeTimes.length ? minOf(madeTimes) : now(),
      updated: updatedTimes.length ? maxOf(updatedTimes) : now(),
      fileCount: members.length,
      blocks,
      looseFiles,
      isUnfiled: project === UNFILED,
    });
  }

  // A project the user made by hand starts with no files in it, so nothing in
  // the assignment pass can produce it. It is still a real destination: you
  // create it precisely so you can pin files into it next. Its timestamps come
  // from when it was made, not from now, so it does not jump to the top of a
  // recency-sorted list every time the taxonomy is rebuilt.
  for (const rec of opts.projectNames ?? []) {
    if (!rec.user_created || byProject.has(rec.project)) continue;
    const at = Date.parse(rec.created_at);
    const made = Number.isFinite(at) ? at : now();
    projects.push({
      key: rec.project,
      name: displayName(rec.project),
      made,
      updated: made,
      fileCount: 0,
      blocks: [],
      looseFiles: [],
      isUnfiled: false,
    });
  }

  projects.sort(byRecencyUnfiledLast);
  return {
    projects,
    totalFiles: assignments.length,
    unfiledCount: byProject.get(UNFILED)?.length ?? 0,
    ignoredCount: ignored,
    assignmentRows,
    blockUpserts,
  };
}
