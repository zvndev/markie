"use client";

// The Projects destination: two levels, one search field, and a way back.
//
// This does not replace the Library panel. The Library is Recent and Folders,
// the two things you reach for when you know which document you want. Projects
// is where organizing is comfortable, and it is two levels deep because that
// is what the work is: an index of auto folders and projects, and then one of
// them opened. Nothing here touches the disk; projects, blocks and folders are
// all views over files that never move.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { shortAgo } from "@/lib/relative-time";
import { useProjects } from "@/lib/use-projects";
import { filterTaxonomy, filterProject } from "@/lib/projects/search";
import { filterFolder } from "@/lib/projects/folders";
import {
  INDEX,
  readLocation,
  resolveLocation,
  searchScope,
  writeLocation,
  type ProjectsLocation,
} from "@/lib/projects-nav";
import { FOCUS_RING } from "@/components/projects-rows";
import { ProjectsIndex } from "@/components/projects-index";
import { ProjectDetail } from "@/components/projects-detail";
import { FolderDetail } from "@/components/projects-folder";
import type { ProjectNode } from "@/lib/projects/taxonomy";

// The listing Markie writes below the overview marker in Projects.md. Plain
// enough to read in any editor, and regenerated only when the user asks.
export function buildOverviewListing(projects: ProjectNode[], now: number = Date.now()): string {
  const lines = [
    `_Written by Markie on ${new Date(now).toISOString().slice(0, 10)}. Everything below this`,
    "marker is regenerated; the rules above it are yours._",
    "",
  ];
  for (const p of projects) {
    lines.push(`- **${p.name}** (${p.fileCount} ${p.fileCount === 1 ? "file" : "files"})`);
    for (const b of p.blocks) {
      lines.push(`  - ${b.name} (${b.files.length})`);
    }
    // Loose files are the project too, and a listing that skipped them would
    // not add up to the count on the line above.
    for (const f of p.looseFiles) {
      lines.push(`  - ${f.name}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="tabular-nums text-foreground">{value.toLocaleString()}</span>{" "}
      <span className="text-muted">{label}</span>
    </span>
  );
}

function HeaderButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-7 shrink-0 rounded-md px-2.5 text-[12px] text-foreground/90 transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

// The scope lives inside the field, not only in its placeholder. A placeholder
// disappears the moment you type, which is exactly when "what am I searching"
// stops being obvious: you are two levels in, looking at a short list, and the
// question is whether the rest of your machine was considered.
function SearchField({
  query,
  onQuery,
  scope,
}: {
  query: string;
  onQuery: (value: string) => void;
  scope: { placeholder: string; label: string; badge: string };
}) {
  return (
    <div className="markie-overlay-field flex h-7 min-w-[210px] flex-1 items-center gap-1.5 px-1.5 focus-within:border-[color:var(--status-blue)]">
      <span className="shrink-0 whitespace-nowrap rounded bg-accent/70 px-1.5 py-px text-[10px] text-foreground/80">
        {scope.badge}
      </span>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            onQuery("");
          }
        }}
        placeholder={scope.placeholder}
        aria-label={scope.label}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted"
      />
      {query && (
        <button
          type="button"
          onClick={() => onQuery("")}
          aria-label="Clear search"
          className={`shrink-0 rounded px-1 text-[13px] leading-none text-muted hover:text-foreground ${FOCUS_RING}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ProjectsView({
  onOpenPath,
  refreshKey,
}: {
  onOpenPath: (path: string) => void;
  refreshKey: number;
}) {
  const projects = useProjects(refreshKey);
  const taxonomy = projects.taxonomy;
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // Where you last were, read once at mount. It is a request, not a fact: the
  // location actually rendered is resolved against the taxonomy below, so a
  // project deleted since last launch lands you at the index rather than at a
  // header naming nothing.
  const [at, setAt] = useState<ProjectsLocation>(() =>
    readLocation((k) => localStorage.getItem(k))
  );
  const [renamingProject, setRenamingProject] = useState(false);

  const allProjects = useMemo(() => taxonomy?.projects ?? [], [taxonomy]);
  const folders = projects.folders;
  const at_ = useMemo(
    () =>
      resolveLocation(at, {
        projectKeys: allProjects.map((p) => p.key),
        folderIds: folders.map((f) => f.id),
      }),
    [at, allProjects, folders]
  );

  const go = useCallback((next: ProjectsLocation) => {
    setAt(next);
    setQuery("");
    setNotice(null);
    setRenamingProject(false);
    writeLocation((k, v) => localStorage.setItem(k, v), next);
  }, []);

  // Back is a button, a breadcrumb, and the shortcut every Mac app uses for
  // going up a level. Escape does it too, unless something is being typed into.
  useEffect(() => {
    if (at_.kind === "index") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        go(INDEX);
        return;
      }
      if (e.key === "Escape" && !typing) {
        e.stopPropagation();
        go(INDEX);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at_.kind, go]);

  const activeProject = useMemo(
    () => (at_.kind === "project" ? (allProjects.find((p) => p.key === at_.key) ?? null) : null),
    [at_, allProjects]
  );
  const activeFolder = useMemo(
    () => (at_.kind === "folder" ? (folders.find((f) => f.id === at_.id) ?? null) : null),
    [at_, folders]
  );

  const pinnedPaths = useMemo(
    () =>
      new Set(
        (taxonomy?.assignmentRows ?? []).filter((r) => r.source === "pin").map((r) => r.path)
      ),
    [taxonomy]
  );
  const totalBlocks = useMemo(
    () => allProjects.reduce((n, p) => n + p.blocks.length, 0),
    [allProjects]
  );

  const indexList = useMemo(
    () => (at_.kind === "index" ? filterTaxonomy(allProjects, query) : allProjects),
    [at_.kind, allProjects, query]
  );
  const shownProject = useMemo(
    () => (activeProject ? filterProject(activeProject, query) : null),
    [activeProject, query]
  );
  const shownFolder = useMemo(
    () => (activeFolder ? filterFolder(activeFolder, query) : null),
    [activeFolder, query]
  );

  const title =
    at_.kind === "project"
      ? (activeProject?.name ?? "")
      : at_.kind === "folder"
        ? (activeFolder?.name ?? "")
        : "";
  const scope = searchScope(at_, title);

  const createProject = (name: string): string | null => {
    if (!name) return "Give the project a name.";
    const taken = allProjects.some(
      (p) => p.key.toLowerCase() === name.toLowerCase() || p.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) return "You already have a project with that name.";
    // Stay at the index rather than diving into the empty project just made.
    // The card appears at the top of the grid, which is the feedback, and the
    // next useful move is finding files to put in it, which happens in the
    // projects that already have them.
    void projects.createProject(name);
    setNotice(`Created ${name}. Move files into it from any file's ⋯ menu.`);
    return null;
  };

  const writeOverview = async () => {
    const api = getElectronAPI();
    if (!api?.projectsWriteOverview || !taxonomy) return;
    const res = await api.projectsWriteOverview({
      listing: buildOverviewListing(taxonomy.projects),
    });
    setNotice(
      res?.ok ? "Listing written to Projects.md." : (res?.error ?? "Could not write Projects.md.")
    );
  };

  if (projects.preparing || (projects.loading && !taxonomy)) {
    return (
      <Shell>
        <p role="status" className="p-6 text-[13px] text-muted">
          Organizing your markdown…
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="shrink-0 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {at_.kind === "index" ? (
            <h1 className="mr-1 text-[15px] font-semibold text-foreground">Projects</h1>
          ) : (
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => go(INDEX)}
                aria-label="Back to all projects"
                title="Back to all projects (⌘[)"
                className={`shrink-0 rounded-md px-1 text-[15px] leading-none text-muted transition-colors hover:bg-accent/40 hover:text-foreground ${FOCUS_RING}`}
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => go(INDEX)}
                className={`shrink-0 rounded-md px-1 text-[12.5px] text-muted transition-colors hover:text-foreground ${FOCUS_RING}`}
              >
                Projects
              </button>
              <span aria-hidden="true" className="shrink-0 text-[12.5px] text-muted">
                /
              </span>
              {renamingProject && activeProject ? (
                <ProjectNameField
                  project={activeProject}
                  onCommit={(value) => {
                    setRenamingProject(false);
                    if (value !== activeProject.name) {
                      void projects.renameProject(activeProject.key, value || null);
                    }
                  }}
                  onCancel={() => setRenamingProject(false)}
                />
              ) : (
                <h1 className="min-w-0 truncate px-1 text-[15px] font-semibold text-foreground">
                  {title}
                </h1>
              )}
            </nav>
          )}
          <SearchField query={query} onQuery={setQuery} scope={scope} />
          {at_.kind === "project" && activeProject && !renamingProject && (
            <HeaderButton onClick={() => setRenamingProject(true)}>Rename project</HeaderButton>
          )}
          <HeaderButton onClick={writeOverview} disabled={!taxonomy}>
            Update listing in Projects.md
          </HeaderButton>
          <HeaderButton
            onClick={() => projects.configPath && onOpenPath(projects.configPath)}
            disabled={!projects.configPath}
          >
            Open Projects.md
          </HeaderButton>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px]">
          {at_.kind === "index" && (
            <>
              <Stat value={allProjects.length} label="projects" />
              <Stat value={totalBlocks} label="blocks" />
              <Stat value={taxonomy?.totalFiles ?? 0} label="files" />
              <Stat value={taxonomy?.unfiledCount ?? 0} label="unfiled" />
              <span className="text-muted">Nothing here moves a file on disk.</span>
            </>
          )}
          {at_.kind === "project" && activeProject && (
            <>
              <Stat value={activeProject.fileCount} label="files" />
              <Stat value={activeProject.blocks.length} label="blocks" />
              <span className="text-muted" title={new Date(activeProject.updated).toLocaleString()}>
                updated {shortAgo(activeProject.updated)} ago
              </span>
              <span className="text-muted">Nothing here moves a file on disk.</span>
            </>
          )}
          {at_.kind === "folder" && activeFolder && (
            <>
              <Stat value={activeFolder.count} label="files" />
              <Stat value={activeFolder.projectCount} label="projects" />
              <span className="text-muted">{activeFolder.rule}</span>
              <span className="text-muted">
                A view, not a place: every file stays in the project it belongs to.
              </span>
            </>
          )}
        </div>

        {projects.rulesError && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-[color:var(--status-yellow)] bg-background px-2 py-1.5 text-[11.5px] text-[color:var(--status-yellow)]"
          >
            Projects.md has a rules error: {projects.rulesError}. Using the last working rules.
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2 text-[11.5px] text-muted">
            {notice}
          </p>
        )}
      </header>

      {projects.scanning ? (
        <p role="status" className="p-6 text-[13px] text-muted">
          Markie is still finding your markdown. Projects will appear as it does.
        </p>
      ) : at_.kind === "project" && shownProject ? (
        <ProjectDetail
          project={shownProject}
          allProjects={allProjects}
          pinnedPaths={pinnedPaths}
          home={projects.home}
          searching={query.trim().length > 0}
          onOpenPath={onOpenPath}
          actions={{
            pin: (path, project, blockId) => void projects.pin(path, project, blockId),
            unpin: (path) => void projects.unpin(path),
            renameBlock: (blockId, name) => void projects.rename(blockId, name),
            mergeBlock: (blockId, into) => void projects.merge(blockId, into),
          }}
        />
      ) : at_.kind === "folder" && shownFolder ? (
        <FolderDetail
          folder={shownFolder}
          home={projects.home}
          searching={query.trim().length > 0}
          onOpenPath={onOpenPath}
          onOpenProject={(key) => go({ kind: "project", key })}
        />
      ) : (
        <ProjectsIndex
          folders={folders}
          projects={indexList}
          totalProjects={allProjects.length}
          searching={query.trim().length > 0}
          onOpenProject={(key) => go({ kind: "project", key })}
          onOpenFolder={(id) => go({ kind: "folder", id })}
          onRenameProject={(key, name) => void projects.renameProject(key, name)}
          onCreateProject={createProject}
        />
      )}
    </Shell>
  );
}

// Renaming in the breadcrumb, so the name changes where the name is shown.
function ProjectNameField({
  project,
  onCommit,
  onCancel,
}: {
  project: ProjectNode;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(project.name);
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value.trim());
  };
  return (
    <input
      autoFocus
      aria-label={`Rename project ${project.name}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.stopPropagation();
          settled.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
      placeholder={project.key}
      className={`markie-overlay-field min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-[14px] ${FOCUS_RING}`}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-markie-projects-view
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
    >
      {children}
    </div>
  );
}
