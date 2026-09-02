// Searching the taxonomy: one query over project names and file names at
// once, because "where is that thing" is one question. The Projects panel is
// the only caller; the per-project and landing-page variants went with the
// full-width page they were written for.
import type { BlockNode, FileNode, ProjectNode } from "@/lib/projects/taxonomy";

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
