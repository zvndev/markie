// Searching the taxonomy. Lifted out of the old Library tree component when
// that tree was removed: the behavior is navigation, not a widget, and both
// levels of the Projects view need it.
import type { BlockNode, FileNode, ProjectNode } from "@/lib/projects/taxonomy";

// Where to land, and what to open first. Sorting by recency alone opens
// whatever was written last, and right after setup that is the workspace
// folder holding one file: Projects.md, which Markie wrote itself. Landing
// there shows the organization feature organizing nothing. Unfiled is skipped
// for the same reason: it is the pile of things Markie could not place.
// Nothing is hidden by this, and the fallbacks mean a workspace that really
// does hold one file still lands somewhere.
export function substantialProjects(projects: ProjectNode[]): ProjectNode[] {
  const real = projects.filter((p) => !p.isUnfiled && p.fileCount > 1);
  if (real.length) return real;
  const placed = projects.filter((p) => !p.isUnfiled);
  return placed.length ? placed : projects;
}

// A project matches wholesale on its own name; otherwise it keeps the blocks
// and files that match, so a search shows answers rather than headings. The
// derived key counts too: a project renamed to "Markie" is still findable by
// the repository name the user knows it by.
export function filterTaxonomy(projects: ProjectNode[], filter: string): ProjectNode[] {
  const q = filter.trim().toLowerCase();
  if (!q) return projects;
  const out: ProjectNode[] = [];
  const hit = (f: FileNode) =>
    f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  for (const p of projects) {
    if (p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) {
      out.push(p);
      continue;
    }
    const blocks: BlockNode[] = [];
    for (const b of p.blocks) {
      if (b.name.toLowerCase().includes(q)) {
        blocks.push(b);
        continue;
      }
      const files = b.files.filter(hit);
      if (files.length) blocks.push({ ...b, files });
    }
    const looseFiles = p.looseFiles.filter(hit);
    if (blocks.length || looseFiles.length) {
      out.push({
        ...p,
        blocks,
        looseFiles,
        fileCount: blocks.reduce((n, b) => n + b.files.length, looseFiles.length),
      });
    }
  }
  return out;
}

// Searching inside one project. The project's own name is not a match here:
// you are already in it, so matching it would show every file it holds and
// answer a question nobody asked.
export function filterProject(project: ProjectNode, filter: string): ProjectNode {
  const q = filter.trim().toLowerCase();
  if (!q) return project;
  const hit = (f: FileNode) =>
    f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  const blocks: BlockNode[] = [];
  for (const b of project.blocks) {
    if (b.name.toLowerCase().includes(q)) {
      blocks.push(b);
      continue;
    }
    const files = b.files.filter(hit);
    if (files.length) blocks.push({ ...b, files });
  }
  const looseFiles = project.looseFiles.filter(hit);
  return {
    ...project,
    blocks,
    looseFiles,
    fileCount: blocks.reduce((n, b) => n + b.files.length, looseFiles.length),
  };
}
