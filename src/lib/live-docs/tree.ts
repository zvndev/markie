// The Live Docs area's file tree (super-nightly, step M3), built from the
// flat, project-relative listing main sends (electron/live-docs-projects.cjs).
// Main has already left out .git and node_modules; this only shapes and sorts.
import type { LiveDocsTreeEntry } from "@/lib/electron";

export interface LiveDocsTreeNode {
  name: string;
  /** Path inside the project, "/"-separated: the only name main accepts for a file. */
  path: string;
  kind: LiveDocsTreeEntry["kind"];
  children: LiveDocsTreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortNodes(nodes: LiveDocsTreeNode[]) {
  nodes.sort((a, b) => {
    const folderFirst = Number(b.kind === "dir") - Number(a.kind === "dir");
    return folderFirst || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  for (const node of nodes) if (node.children.length) sortNodes(node.children);
}

/** Folders first, then names in natural order ("p2" before "p10"), at every level. */
export function buildProjectTree(entries: readonly LiveDocsTreeEntry[]): LiveDocsTreeNode[] {
  const root: LiveDocsTreeNode = { name: "", path: "", kind: "dir", children: [] };
  const byPath = new Map<string, LiveDocsTreeNode>([["", root]]);
  // A listing cut short at main's cap can name a file whose folder row was
  // never sent; the folder is made up here so the file still has a place.
  const folder = (folderPath: string): LiveDocsTreeNode => {
    const known = byPath.get(folderPath);
    if (known) return known;
    const slash = folderPath.lastIndexOf("/");
    const parent = folder(slash < 0 ? "" : folderPath.slice(0, slash));
    const node: LiveDocsTreeNode = { name: folderPath.slice(slash + 1), path: folderPath, kind: "dir", children: [] };
    byPath.set(folderPath, node);
    parent.children.push(node);
    return node;
  };
  for (const entry of entries) {
    if (!entry.path || byPath.has(entry.path)) continue;
    if (entry.kind === "dir") { folder(entry.path); continue; }
    const slash = entry.path.lastIndexOf("/");
    const parent = folder(slash < 0 ? "" : entry.path.slice(0, slash));
    const node: LiveDocsTreeNode = { name: entry.path.slice(slash + 1), path: entry.path, kind: entry.kind, children: [] };
    byPath.set(entry.path, node);
    parent.children.push(node);
  }
  sortNodes(root.children);
  return root.children;
}

/** The folders open when a project first shows: the way down to its pages. */
export function initiallyExpanded(entries: readonly LiveDocsTreeEntry[]): Set<string> {
  const folders = new Set(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path));
  return new Set(["site", "site/pages"].filter((folderPath) => folders.has(folderPath)));
}

export function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

/**
 * Markdown and Darkmown files get the Markdown grammar; everything else
 * (.skin, .js, .json, .css) is edited as plain text, without Markdown
 * formatting behavior getting in the way.
 */
export function editsAsMarkdown(filePath: string): boolean {
  return /\.(?:wd|md|markdown|mdx)$/i.test(filePath);
}
