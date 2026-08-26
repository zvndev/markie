"use client";

// The top level of Projects: the auto folders, then every project. One screen
// that answers "what have I been working on" before it answers "what do I
// have", and a grid rather than a 248px column so the page fills the window it
// was given instead of crowding into its top left corner.
import { useRef, useState } from "react";
import { longAgo } from "@/lib/relative-time";
import { FOCUS_RING } from "@/components/projects-rows";
import type { FolderNode } from "@/lib/projects/folders";
import type { ProjectNode } from "@/lib/projects/taxonomy";

const CARD_GRID =
  "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]";

const num = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function SectionHeading({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <h2 id={id} className="text-[11px] font-medium uppercase tracking-[0.08em] text-foreground">
        {title}
      </h2>
      {note && <span className="text-[11px] text-muted">{note}</span>}
      <span className="ml-auto flex items-center gap-1.5">{children}</span>
    </div>
  );
}

// A view is not a place, and after two rounds of review it was still reading
// as one: same grid, same tile, same footprint as the projects underneath. So
// it stops being a tile. One line, inline, wrapped into a row: the grammar of
// a filter, not of a container. The rule it applies and where it came from are
// on the control itself for anyone who wants to check.
function FolderChip({ folder, onOpen }: { folder: FolderNode; onOpen: () => void }) {
  const empty = folder.count === 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={folder.custom ? `${folder.rule} Defined in Projects.md.` : folder.rule}
      data-markie-folder-card={folder.id}
      className={`inline-flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5 text-left transition-colors hover:bg-accent/50 ${FOCUS_RING}`}
    >
      <span className="truncate text-[12px] text-foreground">{folder.name}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted">
        {empty ? "none" : num(folder.count)}
      </span>
    </button>
  );
}

function ProjectCard({
  project,
  onOpen,
  onRename,
}: {
  project: ProjectNode;
  onOpen: () => void;
  onRename: () => void;
}) {
  const blocks = project.blocks.length;
  return (
    <div
      data-markie-project-card={project.key}
      className={`group/card relative flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-[color:var(--status-blue)] ${
        project.isUnfiled ? "border-dashed" : ""
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open project ${project.name}`}
        className={`truncate text-left text-[12.5px] font-medium after:absolute after:inset-0 after:rounded-lg ${FOCUS_RING} ${
          // Unfiled is a synthetic pile, not a project. It says so quietly:
          // muted text and a dashed edge, rather than a colour that would make
          // the files nobody organized the loudest thing on the page.
          project.isUnfiled ? "text-muted" : "text-foreground"
        }`}
      >
        {project.name}
      </button>
      <span className="text-[10.5px] tabular-nums text-muted">
        {project.fileCount === 0
          ? "Empty — pin files into it"
          : `${plural(project.fileCount, "file")}${blocks ? ` · ${plural(blocks, "block")}` : ""}`}
      </span>
      <span
        className="text-[10.5px] text-muted"
        title={new Date(project.updated).toLocaleString()}
      >
        {project.isUnfiled ? "Markie could not place these" : `updated ${longAgo(project.updated)}`}
      </span>
      {/* Unfiled is a synthetic pile, not a project the user made, so there is
          no name of theirs to change on it. */}
      {!project.isUnfiled && (
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename project ${project.name}`}
          className={`absolute right-1.5 top-1.5 z-10 rounded-md px-1 text-[11px] text-muted opacity-0 transition-opacity hover:bg-accent/50 hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 ${FOCUS_RING}`}
        >
          ✎
        </button>
      )}
    </div>
  );
}

// Renaming happens where the name is, so the card turns into a field rather
// than opening a dialog over the thing you are editing. Clearing the field
// hands the project back to whatever Markie derived, which is the only way out
// of a name you regret.
function RenameCard({
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
    <div className="flex flex-col gap-1 rounded-lg border border-[color:var(--status-blue)] bg-surface px-3 py-2.5">
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
        className={`markie-overlay-field w-full rounded-md px-1.5 py-0.5 text-[12.5px] ${FOCUS_RING}`}
      />
      <span className="text-[10px] leading-snug text-muted">
        Renaming changes nothing on disk. Clear it to go back to {project.key}.
      </span>
    </div>
  );
}

function NewProjectCard({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-[color:var(--status-blue)] bg-surface px-3 py-2.5">
      <input
        autoFocus
        aria-label="New project name"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") setError(onCreate(value.trim()));
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Project name"
        className={`markie-overlay-field w-full rounded-md px-1.5 py-0.5 text-[12.5px] ${FOCUS_RING}`}
      />
      {error ? (
        <span role="alert" className="text-[10px] leading-snug text-[color:var(--status-red)]">
          {error}
        </span>
      ) : (
        <span className="text-[10px] leading-snug text-muted">
          Starts empty. Move files into it from any project.
        </span>
      )}
    </div>
  );
}

export function ProjectsIndex({
  folders,
  projects,
  totalProjects,
  searching,
  onOpenProject,
  onOpenFolder,
  onRenameProject,
  onCreateProject,
}: {
  folders: FolderNode[];
  projects: ProjectNode[];
  totalProjects: number;
  searching: boolean;
  onOpenProject: (key: string) => void;
  onOpenFolder: (id: string) => void;
  onRenameProject: (key: string, customName: string | null) => void;
  onCreateProject: (name: string) => string | null;
}) {
  const [asked, setAsked] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A project that vanishes mid-rename (the index moved under us, or the
  // search narrowed past it) must not leave a field editing something that is
  // no longer on screen. Derived rather than corrected after the fact.
  const renaming =
    asked && projects.some((p) => p.key === asked && !p.isUnfiled) ? asked : null;
  const setRenaming = setAsked;

  return (
    <div data-markie-projects-index className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {/* Auto folders sit above the projects because they answer the question
          people arrive with. They are lenses, not containers: the same file is
          in "Updated today" and in its project at the same time, and saying so
          here is cheaper than explaining it after somebody is confused. */}
      {!searching && folders.length > 0 && (
        <section aria-labelledby="markie-auto-folders" className="mb-5">
          <SectionHeading
            id="markie-auto-folders"
            title="Auto folders"
            note="Views across every project. Files stay where they are."
          />
          <div className="flex flex-wrap gap-1.5">
            {folders.map((f) => (
              <FolderChip key={f.id} folder={f} onOpen={() => onOpenFolder(f.id)} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="markie-projects-heading">
        <SectionHeading
          id="markie-projects-heading"
          title="Projects"
          note={
            searching
              ? `${plural(projects.length, "match", "matches")} of ${num(totalProjects)}`
              : num(totalProjects)
          }
        >
          <button
            type="button"
            onClick={() => setCreating(true)}
            className={`h-6 rounded-md border border-border px-2 text-[11px] text-foreground/90 transition-colors hover:bg-accent/40 ${FOCUS_RING}`}
          >
            New project
          </button>
        </SectionHeading>
        <div className={CARD_GRID}>
          {creating && (
            <NewProjectCard
              onCreate={(name) => {
                const error = onCreateProject(name);
                if (!error) setCreating(false);
                return error;
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {projects.map((p) =>
            renaming === p.key ? (
              <RenameCard
                key={p.key}
                project={p}
                onCommit={(value) => {
                  setRenaming(null);
                  if (value !== p.name) onRenameProject(p.key, value || null);
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <ProjectCard
                key={p.key}
                project={p}
                onOpen={() => onOpenProject(p.key)}
                onRename={() => setRenaming(p.key)}
              />
            )
          )}
        </div>
        {!projects.length && !creating && (
          <p className="py-6 text-[12.5px] text-muted">
            {searching
              ? "No project or file matches that."
              : "No markdown to organize yet. Open a file and Markie will start grouping your work."}
          </p>
        )}
      </section>
    </div>
  );
}
