"use client";

// The full-width organization surface. This does not replace the Library
// panel: it is where organizing is comfortable (a wide layout, the whole
// hierarchy, timestamps, drag targets), while the panel stays the quick
// navigator. Nothing here touches the disk: projects and blocks are a view
// over files that never move.
import { useMemo, useRef, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { longAgo, shortAgo } from "@/lib/relative-time";
import { useProjects } from "@/lib/use-projects";
import { filterTaxonomy, substantialProjects } from "@/components/projects-tree";
import type { BlockNode, FileNode, ProjectNode, Taxonomy } from "@/lib/projects/taxonomy";

// A project can hold thousands of files, and the detail pane renders every
// block of the selected one at once. Measured on the owner's real index, that
// was 11,168 rows in the DOM for a single project. Blocks open to a readable
// slice and say how many more there are.
const FILES_SHOWN = 40;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--status-blue)]";

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
      <span className="tabular-nums text-foreground">{value}</span>{" "}
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
      className={`h-7 shrink-0 rounded-md border border-border bg-surface px-2.5 text-[12px] text-foreground transition-colors hover:bg-surface-2 disabled:opacity-40 ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function ProjectButton({
  project,
  selected,
  onSelect,
  onDropFile,
}: {
  project: ProjectNode;
  selected: boolean;
  onSelect: () => void;
  onDropFile: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-markie-project-row={project.name}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropFile();
      }}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING} ${
        selected ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/40"
      } ${over ? "ring-2 ring-[color:var(--status-blue)]" : ""} ${
        project.isUnfiled
          ? "border border-dashed border-[color:color-mix(in_srgb,var(--muted)_68%,transparent)] text-muted"
          : ""
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
      <span className="shrink-0 tabular-nums text-[10px] text-muted">{project.fileCount}</span>
      <span
        className="shrink-0 tabular-nums text-[10px] text-muted"
        title={new Date(project.updated).toLocaleString()}
      >
        {shortAgo(project.updated)}
      </span>
    </button>
  );
}

function FileRow({
  file,
  pinned,
  onOpen,
  onDragStart,
  menuOpen,
  onMenu,
  children,
}: {
  file: FileNode;
  pinned: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="group relative flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/30"
      draggable
      onDragStart={onDragStart}
      data-markie-project-file={file.path}
    >
      <button
        type="button"
        onClick={onOpen}
        title={file.path}
        className={`flex min-w-0 flex-1 items-baseline gap-2 rounded-md text-left ${FOCUS_RING}`}
      >
        <span className="shrink-0 truncate text-[13px] text-foreground/90">{file.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{file.dir}</span>
      </button>
      {pinned && (
        <span
          className="shrink-0 text-[9px] uppercase tracking-wide text-[color:var(--status-blue)]"
          title="You moved this file here, so rules leave it alone"
        >
          pinned
        </span>
      )}
      <span
        className="shrink-0 tabular-nums text-[10px] text-muted"
        title={new Date(file.mtimeMs).toLocaleString()}
      >
        {shortAgo(file.mtimeMs)}
      </span>
      <button
        type="button"
        onClick={onMenu}
        aria-label={`Organize ${file.name}`}
        aria-expanded={menuOpen}
        className={`shrink-0 rounded-md px-1 text-[13px] leading-none text-muted opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 ${FOCUS_RING} ${
          menuOpen ? "opacity-100" : ""
        }`}
      >
        ⋯
      </button>
      {children}
    </div>
  );
}

function MenuPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="markie-menu-panel markie-menu-raised absolute right-2 top-7 z-20 w-[240px] rounded-lg p-2 text-[12px]">
      {children}
    </div>
  );
}

function MenuSelect({
  label,
  options,
  onPick,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  onPick: (value: string) => void;
}) {
  return (
    <label className="mb-1.5 block">
      <span className="mb-0.5 block text-[10.5px] uppercase tracking-wide text-muted">{label}</span>
      <select
        value=""
        onChange={(e) => e.target.value && onPick(e.target.value)}
        className={`markie-overlay-field w-full rounded-md px-1.5 py-1 text-[12px] ${FOCUS_RING}`}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MenuAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md px-1.5 py-1 text-left text-[12px] text-foreground/90 hover:bg-accent/40 ${FOCUS_RING}`}
    >
      {children}
    </button>
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
  const taxonomy: Taxonomy | null = projects.taxonomy;
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<string | null>(null);
  const [blockMenu, setBlockMenu] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ blockId: string; value: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Escape unmounts the focused input, and removing a focused element still
  // fires React's delegated blur: without this, cancelling a rename renamed
  // the block anyway. Same guard files-view.tsx carries, for the same reason.
  const settled = useRef(true);

  const list = useMemo(
    () => filterTaxonomy(taxonomy?.projects ?? [], query),
    [taxonomy, query]
  );
  const active = useMemo(
    () => list.find((p) => p.name === picked) ?? substantialProjects(list)[0] ?? null,
    [list, picked]
  );
  const pinnedPaths = useMemo(
    () =>
      new Set(
        (taxonomy?.assignmentRows ?? []).filter((r) => r.source === "pin").map((r) => r.path)
      ),
    [taxonomy]
  );
  const totalBlocks = useMemo(
    () => (taxonomy?.projects ?? []).reduce((n, p) => n + p.blocks.length, 0),
    [taxonomy]
  );

  const beginRename = (block: BlockNode) => {
    setBlockMenu(null);
    settled.current = false;
    setEdit({ blockId: block.id, value: block.name });
  };
  const cancelRename = () => {
    settled.current = true;
    setEdit(null);
  };
  const submitRename = async () => {
    if (settled.current || !edit) return;
    settled.current = true;
    const value = edit.value.trim();
    setEdit(null);
    if (value) await projects.rename(edit.blockId, value);
  };

  const dropOnto = (project: string, blockId: string | null) => {
    const path = dragPath;
    setDragPath(null);
    if (path) void projects.pin(path, project, blockId);
  };

  const writeOverview = async () => {
    const api = getElectronAPI();
    if (!api?.projectsWriteOverview || !taxonomy) return;
    const res = await api.projectsWriteOverview({
      listing: buildOverviewListing(taxonomy.projects),
    });
    setNotice(res?.ok ? "Listing written to Projects.md." : (res?.error ?? "Could not write Projects.md."));
  };

  // Blocks and loose files share one most-recent-first order. A loose file
  // renders as a bare row rather than a card: a card is a piece of work, and
  // drawing one around a single file is the folder costume this pass took off.
  const entries = useMemo(() => {
    const rows: Array<{ at: number; block?: BlockNode; file?: FileNode }> = [
      ...(active?.blocks ?? []).map((b) => ({ at: b.updated, block: b })),
      ...(active?.looseFiles ?? []).map((f) => ({ at: f.mtimeMs, file: f })),
    ];
    return rows.sort((a, b) => b.at - a.at);
  }, [active]);

  // One row, wherever the file sits. `inBlock` is the block it is already in,
  // so the move menu never offers to move it where it already is.
  const organizeRow = (file: FileNode, inBlock: string | null) => (
    <FileRow
      key={file.path}
      file={file}
      pinned={pinnedPaths.has(file.path)}
      onOpen={() => onOpenPath(file.path)}
      onDragStart={() => setDragPath(file.path)}
      menuOpen={fileMenu === file.path}
      onMenu={() => setFileMenu(fileMenu === file.path ? null : file.path)}
    >
      {fileMenu === file.path && (
        <MenuPanel>
          <MenuSelect
            label="Move to project"
            options={(taxonomy?.projects ?? []).map((p) => ({ value: p.name, label: p.name }))}
            onPick={(project) => {
              setFileMenu(null);
              void projects.pin(file.path, project, null);
            }}
          />
          <MenuSelect
            label="Move to block"
            options={(active?.blocks ?? [])
              .filter((b) => b.id !== inBlock)
              .map((b) => ({ value: b.id, label: b.name }))}
            onPick={(blockId) => {
              setFileMenu(null);
              if (active) void projects.pin(file.path, active.name, blockId);
            }}
          />
          {pinnedPaths.has(file.path) && (
            <MenuAction
              onClick={() => {
                setFileMenu(null);
                void projects.unpin(file.path);
              }}
            >
              Unpin (follow rules)
            </MenuAction>
          )}
        </MenuPanel>
      )}
    </FileRow>
  );

  const BlockCardHeader = ({ block }: { block: BlockNode }) => (
    <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
      {edit?.blockId === block.id ? (
        <input
          autoFocus
          aria-label="Block name"
          value={edit.value}
          onChange={(e) => setEdit({ blockId: block.id, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitRename();
            if (e.key === "Escape") {
              e.stopPropagation();
              cancelRename();
            }
          }}
          onBlur={() => void submitRename()}
          className={`markie-overlay-field min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-[13px] ${FOCUS_RING}`}
        />
      ) : (
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {block.name}
        </h2>
      )}
      <span className="shrink-0 text-[11px] text-muted">
        {block.files.length} {block.files.length === 1 ? "file" : "files"}
      </span>
      <span
        className="shrink-0 text-[11px] text-muted"
        title={`Started ${new Date(block.made).toLocaleString()}`}
      >
        started {longAgo(block.made)}
      </span>
      <span
        className="shrink-0 text-[11px] text-muted"
        title={new Date(block.updated).toLocaleString()}
      >
        updated {longAgo(block.updated)}
      </span>
      <button
        type="button"
        onClick={() => beginRename(block)}
        aria-label={`Rename block ${block.name}`}
        className={`shrink-0 rounded-md px-1 text-[12px] text-muted hover:text-foreground ${FOCUS_RING}`}
      >
        ✎
      </button>
      <button
        type="button"
        onClick={() => setBlockMenu(blockMenu === block.id ? null : block.id)}
        aria-label={`More actions for ${block.name}`}
        aria-expanded={blockMenu === block.id}
        className={`shrink-0 rounded-md px-1 text-[13px] leading-none text-muted hover:text-foreground ${FOCUS_RING}`}
      >
        ⋯
      </button>
      {blockMenu === block.id && (
        <MenuPanel>
          <MenuAction onClick={() => beginRename(block)}>Rename block</MenuAction>
          <div className="mt-1.5">
            <MenuSelect
              label="Merge into"
              options={(active?.blocks ?? [])
                .filter((b) => b.id !== block.id)
                .map((b) => ({ value: b.id, label: b.name }))}
              onPick={(target) => {
                setBlockMenu(null);
                void projects.merge(block.id, target);
              }}
            />
          </div>
        </MenuPanel>
      )}
    </div>
  );

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
      <header className="shrink-0 border-b border-border bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-1 text-[15px] font-semibold text-foreground">Projects</h1>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search projects, blocks, and files"
            aria-label="Search projects, blocks, and files"
            className={`markie-overlay-field h-7 min-w-[180px] flex-1 rounded-md px-2 text-[12.5px] ${FOCUS_RING}`}
          />
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
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          <Stat value={taxonomy?.projects.length ?? 0} label="projects" />
          <Stat value={totalBlocks} label="blocks" />
          <Stat value={taxonomy?.totalFiles ?? 0} label="files" />
          <Stat value={taxonomy?.unfiledCount ?? 0} label="unfiled" />
          <span className="text-muted">Nothing here moves a file on disk.</span>
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
      ) : !list.length ? (
        <p className="p-6 text-[13px] text-muted">
          {query.trim()
            ? `Nothing matches "${query.trim()}".`
            : "No markdown to organize yet. Open a file and Markie will start grouping your work."}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] max-[860px]:grid-cols-1">
          <nav
            aria-label="Projects"
            className="min-h-0 overflow-y-auto border-r border-border bg-surface p-2 max-[860px]:max-h-[132px] max-[860px]:border-b max-[860px]:border-r-0"
          >
            <div className="flex flex-col gap-0.5">
              {list.map((p) => (
                <ProjectButton
                  key={p.name}
                  project={p}
                  selected={active?.name === p.name}
                  onSelect={() => setPicked(p.name)}
                  onDropFile={() => dropOnto(p.name, null)}
                />
              ))}
            </div>
          </nav>

          <div className="min-h-0 overflow-y-auto p-3">
            {entries.map((entry) =>
              entry.file ? (
                <div key={entry.file.path} className="mb-2.5 px-2.5">
                  {organizeRow(entry.file, null)}
                </div>
              ) : (
                <section
                  key={entry.block!.id}
                  data-markie-project-block={entry.block!.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOnto(active!.name, entry.block!.id);
                  }}
                  className="relative mb-2.5 rounded-md border border-border bg-surface"
                >
                  <BlockCardHeader block={entry.block!} />
                  <div className="p-1">
                    {(expanded.has(entry.block!.id)
                      ? entry.block!.files
                      : entry.block!.files.slice(0, FILES_SHOWN)
                    ).map((file) => organizeRow(file, entry.block!.id))}
                    {entry.block!.files.length > FILES_SHOWN && !expanded.has(entry.block!.id) && (
                      <button
                        type="button"
                        onClick={() => setExpanded(new Set(expanded).add(entry.block!.id))}
                        className={`w-full rounded-md px-2 py-1 text-left text-[12px] text-muted hover:bg-accent/30 hover:text-foreground ${FOCUS_RING}`}
                      >
                        Show all {entry.block!.files.length} files
                      </button>
                    )}
                  </div>
                </section>
              )
            )}
          </div>
        </div>
      )}
    </Shell>
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
