"use client";

// The Files tab, rebuilt on the virtual taxonomy. Project > block > file, with
// counts and how long ago each was touched, most-recent-first throughout.
// Nothing here creates a folder: these groups are a view over files that stay
// exactly where they are on disk.
import { useMemo, useState } from "react";
import { shortAgo } from "@/lib/relative-time";
import type { BlockNode, ProjectNode, Taxonomy } from "@/lib/projects/taxonomy";

interface ProjectsTreeProps {
  taxonomy: Taxonomy | null;
  activePath: string | null;
  onOpenPath: (path: string) => void;
  filter: string;
  // The index is still being walked, so "nothing here" would be a lie.
  scanning?: boolean;
  loading?: boolean;
}

// How many projects open themselves on first paint. Two is the current piece
// of work and the one before it; more and the panel opens as a wall.
const AUTO_OPEN_PROJECTS = 2;

function Count({ n }: { n: number }) {
  return (
    <span className="shrink-0 text-[9px] tabular-nums text-muted" aria-hidden="true">
      {n}
    </span>
  );
}

function When({ ms }: { ms: number }) {
  return (
    <span className="shrink-0 text-[9px] tabular-nums text-muted" title={new Date(ms).toLocaleString()}>
      {shortAgo(ms)}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="w-3 shrink-0 text-muted" aria-hidden="true">
      {open ? "▾" : "▸"}
    </span>
  );
}

function FileRow({
  name,
  path,
  mtimeMs,
  active,
  onOpen,
}: {
  name: string;
  path: string;
  mtimeMs: number;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={path}
      data-markie-project-file={path}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--status-blue)] ${
        active ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/30"
      }`}
      style={{ paddingLeft: 32 }}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <When ms={mtimeMs} />
    </button>
  );
}

function BlockSection({
  block,
  open,
  onToggle,
  activePath,
  onOpenPath,
}: {
  block: BlockNode;
  open: boolean;
  onToggle: () => void;
  activePath: string | null;
  onOpenPath: (path: string) => void;
}) {
  return (
    <div data-markie-project-block={block.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] text-foreground/80 transition-colors hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--status-blue)]"
        style={{ paddingLeft: 18 }}
      >
        <Chevron open={open} />
        <span className="min-w-0 flex-1 truncate">{block.name}</span>
        <Count n={block.files.length} />
        <When ms={block.updated} />
      </button>
      {open &&
        block.files.map((f) => (
          <FileRow
            key={f.path}
            name={f.name}
            path={f.path}
            mtimeMs={f.mtimeMs}
            active={f.path === activePath}
            onOpen={() => onOpenPath(f.path)}
          />
        ))}
    </div>
  );
}

function ProjectSection({
  project,
  openProjects,
  openBlocks,
  toggleProject,
  toggleBlock,
  activePath,
  onOpenPath,
}: {
  project: ProjectNode;
  openProjects: Set<string>;
  openBlocks: Set<string>;
  toggleProject: (name: string) => void;
  toggleBlock: (id: string) => void;
  activePath: string | null;
  onOpenPath: (path: string) => void;
}) {
  const open = openProjects.has(project.name);
  return (
    <div data-markie-project={project.name} className="mb-0.5">
      <button
        type="button"
        onClick={() => toggleProject(project.name)}
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px] transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--status-blue)] ${
          project.isUnfiled ? "text-muted" : "font-medium text-foreground"
        }`}
      >
        <Chevron open={open} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <Count n={project.fileCount} />
        <When ms={project.updated} />
      </button>
      {open &&
        project.blocks.map((b) => (
          <BlockSection
            key={b.id}
            block={b}
            open={openBlocks.has(b.id)}
            onToggle={() => toggleBlock(b.id)}
            activePath={activePath}
            onOpenPath={onOpenPath}
          />
        ))}
    </div>
  );
}

// A project matches wholesale on its own name; otherwise it keeps the blocks
// and files that match, so a search shows answers rather than headings.
export function filterTaxonomy(projects: ProjectNode[], filter: string): ProjectNode[] {
  const q = filter.trim().toLowerCase();
  if (!q) return projects;
  const out: ProjectNode[] = [];
  for (const p of projects) {
    if (p.name.toLowerCase().includes(q)) {
      out.push(p);
      continue;
    }
    const blocks: BlockNode[] = [];
    for (const b of p.blocks) {
      if (b.name.toLowerCase().includes(q)) {
        blocks.push(b);
        continue;
      }
      const files = b.files.filter(
        (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
      );
      if (files.length) blocks.push({ ...b, files });
    }
    if (blocks.length) {
      out.push({ ...p, blocks, fileCount: blocks.reduce((n, b) => n + b.files.length, 0) });
    }
  }
  return out;
}

export function ProjectsTree({
  taxonomy,
  activePath,
  onOpenPath,
  filter,
  scanning,
  loading,
}: ProjectsTreeProps) {
  const projects = useMemo(
    () => filterTaxonomy(taxonomy?.projects ?? [], filter),
    [taxonomy, filter]
  );

  // Seeded from the taxonomy rather than stored: the most recent work is what
  // you came back for, and three clicks to reach it is two too many.
  const seedProjects = useMemo(
    () => new Set((taxonomy?.projects ?? []).slice(0, AUTO_OPEN_PROJECTS).map((p) => p.name)),
    [taxonomy]
  );
  const seedBlocks = useMemo(() => {
    const first = taxonomy?.projects?.[0];
    return new Set(first?.blocks[0] ? [first.blocks[0].id] : []);
  }, [taxonomy]);

  // One map of explicit user choices layered over the seed, rather than a set
  // per direction: "the user closed the project that opens itself" and "the
  // user opened one that does not" are the same fact with different signs.
  const [choice, setChoice] = useState<Map<string, boolean>>(new Map());
  const searching = filter.trim().length > 0;
  const toggle = (key: string, seeded: boolean) =>
    setChoice((prev) => new Map(prev).set(key, !(prev.get(key) ?? seeded)));

  const openProjects = useMemo(() => {
    const open = new Set<string>();
    for (const p of projects) {
      if (searching || (choice.get(`p:${p.name}`) ?? seedProjects.has(p.name))) open.add(p.name);
    }
    return open;
  }, [projects, searching, choice, seedProjects]);
  const openBlocks = useMemo(() => {
    const open = new Set<string>();
    for (const p of projects) {
      for (const b of p.blocks) {
        if (searching || (choice.get(`b:${b.id}`) ?? seedBlocks.has(b.id))) open.add(b.id);
      }
    }
    return open;
  }, [projects, searching, choice, seedBlocks]);

  const toggleProject = (name: string) => toggle(`p:${name}`, seedProjects.has(name));
  const toggleBlock = (id: string) => toggle(`b:${id}`, seedBlocks.has(id));

  if (loading && !taxonomy) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted" role="status">
        Organizing your markdown…
      </div>
    );
  }
  if (scanning) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted" role="status">
        Markie is still finding your markdown. Projects will appear as it does.
      </div>
    );
  }
  if (!projects.length) {
    return (
      <div className="px-3 py-4 text-[12px] text-muted">
        {searching
          ? `Nothing matches "${filter.trim()}".`
          : "No markdown to organize yet. Open a file and Markie will start grouping your work."}
      </div>
    );
  }

  return (
    <div data-markie-projects-tree>
      {projects.map((p) => (
        <ProjectSection
          key={p.name}
          project={p}
          openProjects={openProjects}
          openBlocks={openBlocks}
          toggleProject={toggleProject}
          toggleBlock={toggleBlock}
          activePath={activePath}
          onOpenPath={onOpenPath}
        />
      ))}
    </div>
  );
}
