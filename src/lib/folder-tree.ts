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
}

const SEPARATOR = /[\\/]/;

function segmentsOf(dir: string): string[] {
  return dir.split(SEPARATOR).filter(Boolean);
}

// Windows paths start "C:\", POSIX paths start "/". Preserved so a node's path
// is still a path you can open.
function prefixOf(dir: string): string {
  return dir.startsWith("/") ? "/" : "";
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
    const segments = segmentsOf(row.dir);
    if (segments.length === 0) continue;
    const prefix = prefixOf(row.dir);

    let level = roots;
    let node: Building | undefined;
    let walked = "";
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : `${prefix}${segment}`;
      let next = level.get(segment);
      if (!next) {
        next = { path: walked, segment, files: [], children: new Map() };
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
  };
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
