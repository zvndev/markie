// Work-session clustering: files edited close together in time form one block.
// Everything here is tunable (Projects.md markie_rules.clustering) because this
// WILL be tuned against real data, and everything is stable: once a file has a
// block id, re-derivation moves it only when the file itself moved. User
// renames live in the registry (custom_name) and merges (merged_into) are
// honored here by routing membership to the target.
import type { ClusteringTunables } from "@/lib/projects/rules";
import type { EngineFile } from "@/lib/projects/assign";

export interface PriorAssignment {
  path: string;
  block_id: string | null;
  mtime_ms: number;
}

export interface BlockRecord {
  block_id: string;
  project: string;
  auto_name: string;
  custom_name: string | null;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

export interface DerivedBlocks {
  byPath: Map<string, string>;
  blocks: BlockRecord[];
}

// Math.min/max take their arguments on the stack, and a block here can hold
// thousands of files. Spreading that is a crash waiting for a big enough
// project, so both extremes are folded instead.
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

// Deterministic id: same project + same founding member = same id across
// machines and reruns, so decisions keyed to it stay attached.
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, "0");
}

const mintId = (project: string, founder: EngineFile) =>
  `b_${hash8(`${project}:${founder.path}:${Math.round(founder.mtimeMs)}`)}`;

// Follow merged_into chains (bounded, cycles tolerated by the bound).
function resolveMerge(id: string, byId: Map<string, BlockRecord>): string {
  let cur = id;
  for (let i = 0; i < 20; i++) {
    const rec = byId.get(cur);
    if (!rec || !rec.merged_into) return cur;
    cur = rec.merged_into;
  }
  return cur;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

const segments = (dir: string) => dir.replace(/\\/g, "/").split("/").filter(Boolean);

// The deepest directory every file in the project shares. Block names are
// "relative to the project root" (Spec 5.4), and this is that root: without
// it, a project whose files all live in one folder would name every block
// after that same folder, which says nothing.
export function commonRootDepth(files: EngineFile[]): number {
  if (!files.length) return 0;
  let root = segments(files[0].dir);
  for (const f of files) {
    const segs = segments(f.dir);
    let i = 0;
    while (i < root.length && i < segs.length && root[i] === segs[i]) i++;
    root = root.slice(0, i);
  }
  return root.length;
}

// The file's first directory segment below the project root, or null when it
// sits at the root itself.
function branch(file: EngineFile, rootDepth: number): string | null {
  return segments(file.dir)[rootDepth] ?? null;
}

// The branch most of this cluster lives in, when one covers at least half of
// it. Files sitting at the project root have no branch and vote for nothing,
// but they still count towards the half.
function dominantBranch(files: EngineFile[], rootDepth: number): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const b = branch(f, rootDepth);
    if (!b) continue;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [folder, n] of counts) {
    if (n > bestN) {
      best = folder;
      bestN = n;
    }
  }
  return best !== null && bestN * 2 >= files.length ? best : null;
}

// What this block could be called, best first.
export function blockNameCandidates(
  members: EngineFile[],
  rootDepth: number,
  now: () => number
): string[] {
  const out: string[] = [];
  // A block whose files all live under one folder is that folder's work, even
  // when the folder is several levels below the project root. Without this a
  // path-split block would be named after the branch it was split out of, so
  // every sibling would come back with the same name.
  const shared = commonRootDepth(members);
  if (shared > rootDepth) {
    const own = segments(members[0].dir)[shared - 1];
    if (own) out.push(own);
  }
  const dom = dominantBranch(members, rootDepth);
  if (dom) out.push(dom);
  let newest: EngineFile | null = null;
  for (const f of members) if (!newest || f.mtimeMs > newest.mtimeMs) newest = f;
  if (newest) out.push(stem(newest.name));
  out.push(`Work session ${new Date(now()).toISOString().slice(0, 10)}`);
  return out.filter(Boolean);
}

// Blocks are named after work, so a project with four sessions in its docs
// folder should read "docs", "release notes", "organized workspace", not
// "docs", "docs (2)", "docs (3)". A name already spoken for falls through to
// the next thing this block could truthfully be called; the numbered suffix
// survives only as the last resort, for when every candidate is taken.
export function pickBlockName(candidates: string[], taken: Set<string>): string {
  for (const c of candidates) if (!taken.has(c)) return c;
  const base = candidates[0] ?? "Work session";
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base} (${n++})`;
  return name;
}

// Greedy gap clustering over mtime, newest first.
function clusterByGap(files: EngineFile[], gapMs: number): EngineFile[][] {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const clusters: EngineFile[][] = [];
  let current: EngineFile[] = [];
  let lastMtime: number | null = null;
  for (const f of sorted) {
    if (lastMtime !== null && lastMtime - f.mtimeMs > gapMs) {
      clusters.push(current);
      current = [];
    }
    current.push(f);
    lastMtime = f.mtimeMs;
  }
  if (current.length) clusters.push(current);
  return clusters;
}

// A run of one-file blocks reads as noise, not as work. `min_files` is the
// user's lever on that: anything below it is folded into whichever neighbour
// in time is closer. Clusters arrive newest-first, so the neighbours are the
// entries either side.
function absorbSmallClusters(clusters: EngineFile[][], minFiles: number): EngineFile[][] {
  if (minFiles <= 1 || clusters.length < 2) return clusters;
  const out = clusters.map((c) => [...c]);
  const alive = out.map(() => true);
  for (let i = 0; i < out.length; i++) {
    if (!alive[i] || out[i].length >= minFiles) continue;
    let prev = i - 1;
    while (prev >= 0 && !alive[prev]) prev--;
    let next = i + 1;
    while (next < out.length && !alive[next]) next++;
    const mine = maxOf(out[i].map((f) => f.mtimeMs));
    const prevDist =
      prev >= 0 ? Math.abs(minOf(out[prev].map((f) => f.mtimeMs)) - mine) : Infinity;
    const nextDist =
      next < out.length ? Math.abs(mine - maxOf(out[next].map((f) => f.mtimeMs))) : Infinity;
    if (prevDist === Infinity && nextDist === Infinity) continue;
    const target = prevDist <= nextDist ? prev : next;
    out[target].push(...out[i]);
    alive[i] = false;
  }
  return out.filter((_, i) => alive[i]);
}

// Bulk-write guard (Spec 5.4): git clone, checkout, and archive extraction
// stamp many files with near-identical mtimes (and birthtimes), so a fresh
// clone would collapse into one enormous "session". A cluster that large and
// that tight is a bulk event; time is meaningless there, so it is split into
// path-based blocks instead. Files edited individually later migrate out
// through normal incremental re-derivation.
function isBulkCluster(cluster: EngineFile[], t: ClusteringTunables): boolean {
  if (cluster.length < t.bulkMinFiles) return false;
  const times = cluster.map((f) => f.mtimeMs);
  return maxOf(times) - minOf(times) <= t.bulkWindowMinutes * 60_000;
}

// Break an oversized cluster up by folder, descending until the pieces are
// small enough or the paths run out of anything left to distinguish them.
//
// One level is not enough on real data: a cloned repo whose markdown all sits
// under `packages/` splits into exactly one group called `packages`, which is
// the same enormous block with a folder's name on it. Descending fixes that,
// and stopping as soon as a group is under the limit keeps folders that are
// already a sensible size in one piece.
export function splitOversizedByPath(
  cluster: EngineFile[],
  depth: number,
  limit: number
): EngineFile[][] {
  if (cluster.length <= limit) return [cluster];
  const groups = new Map<string, EngineFile[]>();
  for (const f of cluster) {
    const key = segments(f.dir)[depth] ?? ".";
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }
  if (groups.size <= 1) {
    // Nothing distinguishes these files at this depth. Either they all sit at
    // the deepest shared folder (no split is possible), or they share one more
    // segment and the answer is further down.
    if (groups.has(".")) return [cluster];
    return splitOversizedByPath(cluster, depth + 1, limit);
  }
  const out: EngineFile[][] = [];
  for (const g of groups.values()) out.push(...splitOversizedByPath(g, depth + 1, limit));
  return out;
}

// How many files one block may hold before it stops reading as a unit of work.
// Projects too small for the concentration rule to mean anything are left
// alone: three files edited together are one session, not three blocks.
export function concentrationLimit(projectSize: number, t: ClusteringTunables): number {
  if (projectSize < CONCENTRATION_MIN_PROJECT) return Infinity;
  return Math.max(1, Math.min(t.maxBlockFiles, Math.floor(projectSize * t.maxBlockShare)));
}

const CONCENTRATION_MIN_PROJECT = 10;

// The last resort when folders cannot tell a bucket apart: cut it at its own
// widest pauses. A long unbroken run of edits IS one session by the gap rule,
// but 367 files in one folder is not something anyone navigates, and the
// rhythm of the writing is the only signal left once the paths are identical.
// Files stamped at the exact same instant cannot be separated at all, and are
// left alone rather than chopped arbitrarily.
export function splitByLargestGaps(cluster: EngineFile[], limit: number): EngineFile[][] {
  if (cluster.length <= limit) return [cluster];
  const sorted = [...cluster].sort((a, b) => b.mtimeMs - a.mtimeMs);
  let pieces: EngineFile[][] = [sorted];
  for (let guard = 0; guard < cluster.length; guard++) {
    let worstIndex = -1;
    let worstSize = limit;
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].length > worstSize) {
        worstSize = pieces[i].length;
        worstIndex = i;
      }
    }
    if (worstIndex === -1) break;
    const piece = pieces[worstIndex];
    // Widest pause wins, and an even run of edits (every gap identical) is cut
    // down the middle rather than at whichever gap happened to come first:
    // that tie-break is the difference between two halves and a shower of
    // one-file blocks.
    const middle = piece.length / 2;
    let cutAt = -1;
    let widest = -1;
    let bestOffset = Infinity;
    for (let i = 1; i < piece.length; i++) {
      const gap = piece[i - 1].mtimeMs - piece[i].mtimeMs;
      const offset = Math.abs(i - middle);
      if (gap > widest || (gap === widest && offset < bestOffset)) {
        widest = gap;
        cutAt = i;
        bestOffset = offset;
      }
    }
    if (cutAt <= 0 || widest <= 0) break; // every file shares one instant
    pieces = [
      ...pieces.slice(0, worstIndex),
      piece.slice(0, cutAt),
      piece.slice(cutAt),
      ...pieces.slice(worstIndex + 1),
    ];
  }
  return pieces;
}

// How many path segments two clusters share. Higher means the two are more
// plainly the same corner of the project, which is what makes merging them
// read as one thing rather than as a filing accident.
function sharedDepth(a: EngineFile[], b: EngineFile[]): number {
  const sa = segments(a[0].dir);
  const sb = segments(b[0].dir);
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return i;
}

// Splitting for concentration and capping the block count pull in opposite
// directions, and both are release gates. Once the pieces are small enough,
// fold the most closely related ones back together until the project is a
// list someone can read, never letting a fold recreate a bucket.
export function mergeToBlockCap(
  clusters: EngineFile[][],
  cap: number,
  limit: number
): EngineFile[][] {
  let out = clusters.filter((c) => c.length > 0);
  while (out.length > cap) {
    let bestA = -1;
    let bestB = -1;
    let bestDepth = -1;
    let bestSize = Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const size = out[i].length + out[j].length;
        if (size > limit) continue;
        const depth = sharedDepth(out[i], out[j]);
        if (depth > bestDepth || (depth === bestDepth && size < bestSize)) {
          bestA = i;
          bestB = j;
          bestDepth = depth;
          bestSize = size;
        }
      }
    }
    if (bestA === -1) break; // nothing can fold without making a bucket again
    const merged = [...out[bestA], ...out[bestB]];
    out = out.filter((_, i) => i !== bestA && i !== bestB);
    out.push(merged);
  }
  return out;
}

// One pass of "turn a project's files into blocks": sessions by time, small
// sessions folded in, buckets broken up by folder and then by pauses, and the
// result folded back down to a readable number of blocks.
function clusterProjectFiles(
  files: EngineFile[],
  gapMs: number,
  t: ClusteringTunables,
  rootDepth: number
): EngineFile[][] {
  const limit = concentrationLimit(files.length, t);
  const out: EngineFile[][] = [];
  for (const cluster of absorbSmallClusters(clusterByGap(files, gapMs), t.minFiles)) {
    // A bulk write has no time signal at all, so it is split by path however
    // small it is; anything else is split only once it grows into a bucket.
    const clusterLimit = isBulkCluster(cluster, t)
      ? Math.min(limit, cluster.length - 1)
      : limit;
    for (const piece of splitOversizedByPath(cluster, rootDepth, clusterLimit)) {
      out.push(...splitByLargestGaps(piece, clusterLimit));
    }
  }
  return mergeToBlockCap(out, t.maxBlocksPerProject, limit);
}

export function deriveBlocks(
  project: string,
  files: EngineFile[],
  prior: PriorAssignment[],
  knownBlocks: BlockRecord[],
  tunables: ClusteringTunables,
  now: () => number = Date.now
): DerivedBlocks {
  const byId = new Map(knownBlocks.map((b) => [b.block_id, b]));
  const priorByPath = new Map(prior.map((p) => [p.path, p]));
  const byPath = new Map<string, string>();
  const rootDepth = commonRootDepth(files);

  // 1. Stability pass: unchanged files stay where they were.
  const pool: EngineFile[] = [];
  const members = new Map<string, EngineFile[]>(); // blockId -> members
  for (const f of files) {
    const p = priorByPath.get(f.path);
    if (p && p.block_id && p.mtime_ms === f.mtimeMs && byId.has(p.block_id)) {
      const target = resolveMerge(p.block_id, byId);
      byPath.set(f.path, target);
      const arr = members.get(target) ?? [];
      arr.push(f);
      members.set(target, arr);
    } else {
      pool.push(f);
    }
  }

  // 2. New/changed files join the nearest existing block whose time range is
  //    within the gap, else pool for fresh clustering.
  const gapMs = tunables.gapHours * 3600_000;
  const ranges = new Map<string, { min: number; max: number }>();
  for (const [id, m] of members) {
    const times = m.map((x) => x.mtimeMs);
    ranges.set(id, { min: minOf(times), max: maxOf(times) });
  }
  const stillPool: EngineFile[] = [];
  for (const f of pool) {
    let joined: string | null = null;
    let bestDist = Infinity;
    for (const [id, r] of ranges) {
      const dist =
        f.mtimeMs >= r.min && f.mtimeMs <= r.max
          ? 0
          : Math.min(Math.abs(f.mtimeMs - r.min), Math.abs(f.mtimeMs - r.max));
      if (dist <= gapMs && dist < bestDist) {
        joined = id;
        bestDist = dist;
      }
    }
    if (joined) {
      byPath.set(f.path, joined);
      const arr = members.get(joined) ?? [];
      arr.push(f);
      members.set(joined, arr);
      const r = ranges.get(joined)!;
      ranges.set(joined, {
        min: Math.min(r.min, f.mtimeMs),
        max: Math.max(r.max, f.mtimeMs),
      });
    } else {
      stillPool.push(f);
    }
  }

  // 3. Fresh clustering for the remainder (bulk-write guarded).
  for (const cluster of clusterProjectFiles(stillPool, gapMs, tunables, rootDepth)) {
    const founder = cluster[cluster.length - 1]; // oldest member founds it
    const id = mintId(project, founder);
    for (const f of cluster) byPath.set(f.path, id);
    members.set(id, [...(members.get(id) ?? []), ...cluster]);
  }

  // 4. Adaptive cap: if the project holds too many blocks, recluster
  //    EVERYTHING with doubled gaps until under the cap, adopting old ids by
  //    majority overlap so renames stay attached.
  let effectiveGap = gapMs;
  let finalMembers = members;
  while (finalMembers.size > tunables.maxBlocksPerProject) {
    effectiveGap *= 2;
    const reclustered = clusterProjectFiles(files, effectiveGap, tunables, rootDepth);
    const adopted = new Map<string, EngineFile[]>();
    for (const cluster of reclustered) {
      // Which old id covers most of this cluster?
      const votes = new Map<string, number>();
      for (const f of cluster) {
        const old = byPath.get(f.path);
        if (old) votes.set(old, (votes.get(old) ?? 0) + 1);
      }
      let bestId: string | null = null;
      let bestVotes = 0;
      for (const [id, n] of votes) {
        if (n > bestVotes) {
          bestId = id;
          bestVotes = n;
        }
      }
      const founder = cluster[cluster.length - 1];
      const id = bestId && bestVotes * 2 >= cluster.length ? bestId : mintId(project, founder);
      adopted.set(id, [...(adopted.get(id) ?? []), ...cluster]);
    }
    if (adopted.size >= finalMembers.size) {
      // Doubling stopped helping (a bulk split holds the count up); widening
      // further would only churn ids for no gain.
      finalMembers = adopted;
      break;
    }
    finalMembers = adopted;
    if (effectiveGap > 365 * 24 * 3600_000) break; // never loop forever
  }
  byPath.clear();
  for (const [id, m] of finalMembers) for (const f of m) byPath.set(f.path, id);

  // 5. Materialize block records (upserts). Names: keep the existing auto_name
  //    for known ids (naming stability); name new ids from members.
  const seenNames = new Set<string>();
  const blocks: BlockRecord[] = [];
  const ordered = [...finalMembers.entries()].sort(
    (a, b) => maxOf(a[1].map((f) => f.mtimeMs)) - maxOf(b[1].map((f) => f.mtimeMs))
  );
  for (const [id, m] of ordered) {
    const known = byId.get(id);
    const name = known
      ? known.auto_name
      : pickBlockName(blockNameCandidates(m, rootDepth, now), seenNames);
    seenNames.add(name);
    const times = m.map((f) => f.mtimeMs);
    const births = m.map((f) => f.birthtimeMs ?? f.mtimeMs);
    blocks.push({
      block_id: id,
      project,
      auto_name: name,
      custom_name: known ? known.custom_name : null,
      merged_into: known ? known.merged_into : null,
      created_at: known
        ? known.created_at
        : new Date(m.length ? minOf(births) : now()).toISOString(),
      updated_at: new Date(m.length ? maxOf(times) : now()).toISOString(),
    });
  }
  return { byPath, blocks };
}
