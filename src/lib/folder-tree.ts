// Turns a flat list of markdown files into a folder tree worth reading.
//
// Browse used to list one row per distinct directory, which meant a project
// with markdown in ten subfolders produced ten sibling rows, each printing the
// same long prefix. Ten rows for one project is not a list of places, it is the
// file list again with worse names.
//
// This builds a real tree and then collapses runs of folders that hold nothing
// but a single subfolder, so the path from a root down to the first interesting
// point reads as one row: "ZVN/Medusa" rather than "Users", "Users/kirby",
// "Users/kirby/Desktop", and so on down. It is what a file explorer does, and
// what makes a root actually look like a root.

export interface FileEntry {
  path: string;
  name: string;
  dir: string;
  mtimeMs: number;
}

export interface FolderNode {
  // Absolute path of the folder this node stands for.
  path: string;
  // What to print. Several segments when a chain was collapsed into one row.
  label: string;
  // Markdown sitting directly in this folder.
  files: FileEntry[];
  children: FolderNode[];
  // Markdown at or below this folder, which is the number worth showing: a
  // count of what you would find by opening it, not of one level.
  total: number;
  // When anything at or below this folder last changed, so sorting by Updated
  // can put a folder where its newest file would go. 0 when it holds nothing.
  latestMtimeMs: number;
}

const SEPARATOR = /[\\/]/;

// Every ancestor of `dir`, shortest first, spelled the way `dir` spells it:
// the separators and the root ("/", "C:\", "\\server\share") are the row's
// own, so a node's path is one you can open and one that equals a row's `dir`.
// Joining segments with "/" wrote C:\work as C:/work, which no row's dir ever
// matched, so a starred folder on Windows filtered its own files out.
function ancestorsOf(dir: string): { segment: string; path: string }[] {
  const out: { segment: string; path: string }[] = [];
  let start = 0;
  for (let i = 0; i <= dir.length; i += 1) {
    const atEnd = i === dir.length;
    if (!atEnd && !SEPARATOR.test(dir[i])) continue;
    if (i > start) {
      const segment = dir.slice(start, i);
      // A drive letter keeps its separator: "C:" alone names the drive's
      // current folder, not its root.
      const drive = out.length === 0 && !atEnd && /^[A-Za-z]:$/.test(segment);
      out.push({ segment, path: dir.slice(0, drive ? i + 1 : i) });
    }
    start = i + 1;
  }
  return out;
}

interface Building {
  path: string;
  segment: string;
  files: FileEntry[];
  children: Map<string, Building>;
}

export function buildFolderTree(rows: readonly FileEntry[]): FolderNode[] {
  const roots = new Map<string, Building>();

  for (const row of rows) {
    const ancestors = ancestorsOf(row.dir);
    if (ancestors.length === 0) continue;

    let level = roots;
    let node: Building | undefined;
    for (const { segment, path } of ancestors) {
      let next = level.get(segment);
      if (!next) {
        next = { path, segment, files: [], children: new Map() };
        level.set(segment, next);
      }
      node = next;
      level = next.children;
    }
    node?.files.push(row);
  }

  return [...roots.values()].map(collapse).sort(byLabel);
}

// A folder holding no markdown of its own and exactly one subfolder is not a
// place, it is a step on the way to one. Fold it into its child.
function collapse(node: Building): FolderNode {
  let current = node;
  let label = node.segment;
  while (current.files.length === 0 && current.children.size === 1) {
    const [only] = current.children.values();
    label = `${label}/${only.segment}`;
    current = only;
  }

  const children = [...current.children.values()].map(collapse).sort(byLabel);
  const files = [...current.files].sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: current.path,
    label,
    files,
    children,
    total: files.length + children.reduce((sum, c) => sum + c.total, 0),
    latestMtimeMs: newest(files, children),
  };
}

// A loop rather than Math.max(...files): the indexer will hand us up to 200,000
// files (electron/mdindex.js), and one folder holding a large share of them is
// enough arguments to blow the call stack before Browse renders anything.
function newest(files: readonly FileEntry[], children: readonly FolderNode[]): number {
  let latest = 0;
  for (const f of files) if (f.mtimeMs > latest) latest = f.mtimeMs;
  for (const c of children) if (c.latestMtimeMs > latest) latest = c.latestMtimeMs;
  return latest;
}

const byLabel = (a: FolderNode, b: FolderNode) => a.label.localeCompare(b.label);

// Every folder on the way to a file, so a filter can open the tree to its
// matches instead of leaving them buried behind closed rows.
export function pathsToFiles(nodes: readonly FolderNode[]): string[] {
  const open: string[] = [];
  const walk = (node: FolderNode) => {
    if (node.total > 0) open.push(node.path);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return open;
}

// Counts every folder the tree would draw, used to decide whether opening
// everything for a filter is reasonable.
export function countNodes(nodes: readonly FolderNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

// Where Browse opens to when nobody has told it otherwise.
//
// Everything used to start closed, so the panel's first offer was a row you had
// to click before it said anything. Open each root, and keep walking while a
// folder holds exactly one thing, because a folder with one thing in it is a
// step on the way somewhere rather than a place to stop. The first folder that
// offers a choice is opened too, so its contents are what you land on.
//
// Collapsing usually puts that branch at the root already; the walk is here for
// the shapes it does not, and so the rule holds wherever it is called.
export function initialOpenSet(nodes: readonly FolderNode[]): Set<string> {
  const open = new Set<string>();
  for (const root of nodes) {
    let node: FolderNode | undefined = root;
    while (node) {
      open.add(node.path);
      if (node.files.length + node.children.length !== 1) break;
      node = node.children[0];
    }
  }
  return open;
}

// The remembered open set, reconciled with the tree in front of it. Collapsing
// renames the nodes when branches appear or disappear: a remembered
// `/home/me/work` becomes a child of a brand-new `/home/me` the day
// `/home/me/downloads` is indexed, and a set that does not name the new root
// used to leave everything under it collapsed. So a folder is open when the set
// names it, or when something the set names sits below it and nobody closed
// it by hand. The closed set is what tells a folder the user shut with an open
// child inside it from a folder the user has never seen.
export function openWithAncestors(
  open: ReadonlySet<string>,
  closed: ReadonlySet<string>,
  nodes: readonly FolderNode[]
): Set<string> {
  const result = new Set(open);
  // Collapsing also folds a folder into a deeper node when it is down to one
  // thing: the day /home/me/work/notes empties, /home/me/work stops being a
  // node and what it held sits under /home/me/work/docs. A remembered path
  // that names no node opens the topmost node beneath it, which is where that
  // folder went.
  const present = new Set<string>();
  const collect = (node: FolderNode) => {
    present.add(node.path);
    node.children.forEach(collect);
  };
  nodes.forEach(collect);
  const folded = [...open].filter((p) => !present.has(p));
  const foldedInto = (node: FolderNode, parent: FolderNode | null) =>
    folded.some((p) => isUnder(node.path, p) && !(parent && isUnder(parent.path, p)));
  // Whether this node, or anything beneath it, is in the open set.
  const visit = (node: FolderNode, parent: FolderNode | null): boolean => {
    let below = false;
    for (const child of node.children) if (visit(child, node)) below = true;
    const named = open.has(node.path) || foldedInto(node, parent);
    if (named || (below && !closed.has(node.path))) result.add(node.path);
    return named || below;
  };
  for (const root of nodes) visit(root, null);
  return result;
}

// Is `path` strictly inside the folder `dir`, on either kind of path?
function isUnder(path: string, dir: string): boolean {
  return path.length > dir.length && path.startsWith(dir) && SEPARATOR.test(path[dir.length]);
}

export type SortOrder = "name" | "updated";

// Build order is already by name, so only "updated" has work to do: files by
// their own time, folders by the newest file anywhere beneath them. Names break
// ties, otherwise two files saved in the same second swap places on a rescan.
export function sortTree(nodes: readonly FolderNode[], order: SortOrder): FolderNode[] {
  if (order === "name") return [...nodes];
  return [...nodes]
    .sort((a, b) => b.latestMtimeMs - a.latestMtimeMs || a.label.localeCompare(b.label))
    .map((node) => ({
      ...node,
      files: [...node.files].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name)),
      children: sortTree(node.children, order),
    }));
}
