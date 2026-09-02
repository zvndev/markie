"use client";

// Projects, inside the Library panel.
//
// This replaces the old Folders tab, which listed real directories on disk,
// and it replaces the full-width Projects page that used to be its own rail
// destination. Both are gone on purpose: the point of the feature was never
// to mirror the filesystem or to fill the window with cards, it was to give
// the files a structure of Markie's own while they stay exactly where they
// are on disk. A side panel is where you keep something you navigate while
// reading, which is what this is.
//
// One list, one search field. The search matches project names and file
// names together, because "where is that thing" is one question, not two.
import { useMemo, useState } from "react";
import { useProjects } from "@/lib/use-projects";
import { compactDir } from "@/lib/path-display";
import { filterTaxonomy } from "@/lib/projects/search";
import type { FileNode, ProjectNode } from "@/lib/projects/taxonomy";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--status-blue)]";

// Every file in a project, in one flat list. The block grouping is real and
// useful at full width, but a 248px column cannot show three levels without
// becoming a stack of indentation, so the panel shows what you came for: the
// files, newest first.
function filesOf(project: ProjectNode): FileNode[] {
  const seen = new Set<string>();
  const out: FileNode[] = [];
  for (const block of project.blocks) {
    for (const f of block.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  }
  for (const f of project.looseFiles) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Most projects live in one directory, and printing that directory under every
// single file is a line of noise repeated ten times that answers a question
// nobody asked. The line earns its place only on the files that are somewhere
// else, which is exactly when you need to be told.
function commonDir(files: FileNode[]): string | null {
  if (files.length < 2) return null;
  const counts = new Map<string, number>();
  for (const f of files) counts.set(f.dir, (counts.get(f.dir) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, n] of counts) {
    if (n > bestCount) {
      best = dir;
      bestCount = n;
    }
  }
  return bestCount > 1 ? best : null;
}

export function ProjectsPanel({
  projects,
  home,
  activePath,
  onOpenPath,
  onOpenConfig,
  configPath,
  rulesError,
  scanning,
  preparing,
}: {
  projects: ProjectNode[];
  home: string;
  activePath: string | null;
  onOpenPath: (path: string) => void;
  onOpenConfig: () => void;
  configPath: string | null;
  rulesError: string | null;
  scanning: boolean;
  preparing: boolean;
}) {
  const [query, setQuery] = useState("");
  // What the user has explicitly opened or closed. Absence means "no opinion",
  // which is not the same as closed: the project holding the open document
  // defaults to open. Stored rather than derived so that a project you shut
  // stays shut.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());

  const searching = query.trim().length > 0;
  const shown = useMemo(() => filterTaxonomy(projects, query), [projects, query]);

  // Opening a document from anywhere should show you where it lives. Without
  // this the panel can be sitting right beside the open file with every
  // project shut, which reads as the panel not knowing what you are reading.
  const activeProjectKey = useMemo(() => {
    if (!activePath) return null;
    return projects.find((p) => filesOf(p).some((f) => f.path === activePath))?.key ?? null;
  }, [projects, activePath]);

  // While searching, every match is open: a hit you have to click to see is a
  // hit the search did not really give you.
  const isOpen = (key: string) => {
    if (searching) return true;
    return toggled.get(key) ?? key === activeProjectKey;
  };
  const toggle = (key: string) =>
    setToggled((prev) => new Map(prev).set(key, !isOpen(key)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search projects and files"
          aria-label="Search projects and files"
          className={`markie-overlay-field h-7 w-full rounded-md px-2 text-[12px] ${FOCUS_RING}`}
        />
      </div>

      {rulesError && (
        <p
          role="alert"
          className="mx-2 mb-1.5 shrink-0 rounded-md border border-[color:var(--status-yellow)] px-2 py-1 text-[11px] text-[color:var(--status-yellow)]"
        >
          {rulesError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {shown.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted">
            {scanning
              ? "Still finding your markdown…"
              : preparing
                ? "Working out where everything belongs…"
                : searching
                  ? "Nothing matches that."
                  : "No projects yet."}
          </p>
        ) : (
          shown.map((project) => {
            const files = filesOf(project);
            const shared = commonDir(files);
            const open = isOpen(project.key);
            return (
              <div key={project.key}>
                <button
                  type="button"
                  onClick={() => toggle(project.key)}
                  aria-expanded={open}
                  className={`flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/40 ${FOCUS_RING}`}
                >
                  <span
                    aria-hidden="true"
                    className={`shrink-0 text-[9px] text-muted transition-transform ${open ? "rotate-90" : ""}`}
                  >
                    ▶
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate text-[12.5px] ${
                      project.isUnfiled ? "text-muted" : "text-foreground"
                    }`}
                  >
                    {project.name}
                  </span>
                  <span className="shrink-0 pr-1 text-[11px] tabular-nums text-muted">
                    {project.fileCount}
                  </span>
                </button>

                {open &&
                  files.map((file) => {
                    const active = activePath === file.path;
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => onOpenPath(file.path)}
                        title={file.path}
                        className={`flex w-full flex-col items-start gap-0 rounded-md py-[3px] pl-[22px] pr-2 text-left transition-colors ${FOCUS_RING} ${
                          active ? "bg-accent text-foreground" : "hover:bg-accent/40"
                        }`}
                      >
                        <span className="w-full truncate text-[12px] text-foreground">
                          {file.name}
                        </span>
                        {file.dir !== shared && (
                          <span className="w-full truncate text-[10.5px] text-muted">
                            {compactDir(file.dir, home)}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>

      {configPath && (
        <button
          type="button"
          onClick={onOpenConfig}
          className={`shrink-0 border-t border-border px-3 py-1.5 text-left text-[11px] text-muted transition-colors hover:text-foreground ${FOCUS_RING}`}
        >
          Edit how this is organized
        </button>
      )}
    </div>
  );
}

// Mounted only while the Projects tab is the one showing, so the taxonomy over
// ~14k files is not rebuilt behind a tab nobody is looking at.
export function ProjectsPanelContainer({
  refreshKey,
  activePath,
  onOpenPath,
}: {
  refreshKey: number;
  activePath: string | null;
  onOpenPath: (path: string) => void;
}) {
  const projects = useProjects(refreshKey);
  return (
    <ProjectsPanel
      projects={projects.taxonomy?.projects ?? []}
      home={projects.home}
      activePath={activePath}
      onOpenPath={onOpenPath}
      onOpenConfig={() => projects.configPath && onOpenPath(projects.configPath)}
      configPath={projects.configPath}
      rulesError={projects.rulesError}
      scanning={projects.scanning}
      preparing={projects.preparing}
    />
  );
}
