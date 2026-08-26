"use client";

// One auto folder, opened. The files are grouped by the project they are still
// in, and each group heading is the way into that project. That grouping is
// the answer to the only real objection to auto folders: a folder that looks
// like a place will be mistaken for one, and a folder that shows you the
// projects its files came from cannot be.
import { useState } from "react";
import { compactDir } from "@/lib/path-display";
import { longAgo, shortAgo } from "@/lib/relative-time";
import { FOCUS_RING, NAME_COL } from "@/components/projects-rows";
import type { FolderNode, FolderProjectGroup } from "@/lib/projects/folders";

// A week of a busy machine is thousands of files. Each group opens to a
// readable slice and says how many more it has, and the list of groups does
// the same, so the level costs a fixed amount of DOM however big the answer.
const FILES_SHOWN = 12;
const GROUPS_SHOWN = 25;

function Group({
  group,
  home,
  onOpenPath,
  onOpenProject,
}: {
  group: FolderProjectGroup;
  home: string;
  onOpenPath: (path: string) => void;
  onOpenProject: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.files : group.files.slice(0, FILES_SHOWN);
  return (
    <section
      data-markie-folder-group={group.projectKey}
      className="mb-3 rounded-lg border border-border bg-surface"
    >
      <div className="flex items-center gap-2.5 px-3 pb-2 pt-2.5">
        <button
          type="button"
          onClick={() => onOpenProject(group.projectKey)}
          aria-label={`Open project ${group.projectName}`}
          className={`min-w-0 truncate rounded-md text-left text-[12.5px] font-semibold hover:underline ${FOCUS_RING} ${
            group.isUnfiled ? "text-muted" : "text-foreground"
          }`}
        >
          {group.projectName}
        </button>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted">
          {group.files.length} {group.files.length === 1 ? "file" : "files"}
        </span>
        <span
          className="ml-auto shrink-0 text-[10.5px] text-muted"
          title={new Date(group.updated).toLocaleString()}
        >
          updated {longAgo(group.updated)}
        </span>
      </div>
      <div className="px-1 pb-1.5">
        {shown.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpenPath(file.path)}
            title={file.path}
            data-markie-project-file={file.path}
            className={`flex w-full items-baseline gap-2 rounded-md py-[3px] pl-3 pr-2 text-left hover:bg-accent/30 ${FOCUS_RING}`}
          >
            <span className={`${NAME_COL} text-[12.5px] text-foreground/90`}>{file.name}</span>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">
              {compactDir(file.dir, home)}
            </span>
            <span
              className="min-w-[34px] shrink-0 text-right tabular-nums text-[10px] text-muted"
              title={new Date(file.mtimeMs).toLocaleString()}
            >
              {shortAgo(file.mtimeMs)}
            </span>
          </button>
        ))}
        {group.files.length > FILES_SHOWN && !all && (
          <button
            type="button"
            onClick={() => setAll(true)}
            className={`mt-0.5 flex w-full items-center gap-1.5 rounded-md py-1 pl-3 pr-2 text-left text-[11.5px] text-foreground/80 hover:bg-accent/40 hover:text-foreground ${FOCUS_RING}`}
          >
            <span aria-hidden="true" className="text-muted">
              ▾
            </span>
            Show all {group.files.length} files in {group.projectName}
          </button>
        )}
      </div>
    </section>
  );
}

export function FolderDetail({
  folder,
  home,
  searching,
  onOpenPath,
  onOpenProject,
}: {
  folder: FolderNode;
  home: string;
  searching: boolean;
  onOpenPath: (path: string) => void;
  onOpenProject: (key: string) => void;
}) {
  const [allGroups, setAllGroups] = useState(false);
  const groups = allGroups ? folder.groups : folder.groups.slice(0, GROUPS_SHOWN);

  if (!folder.groups.length) {
    return (
      <div data-markie-projects-folder className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <p className="text-[12.5px] text-muted">
          {searching
            ? "Nothing in this folder matches that."
            : `Nothing matches this folder yet. ${folder.rule}`}
        </p>
      </div>
    );
  }

  return (
    <div data-markie-projects-folder className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
      {groups.map((g) => (
        <Group
          key={g.projectKey}
          group={g}
          home={home}
          onOpenPath={onOpenPath}
          onOpenProject={onOpenProject}
        />
      ))}
      {folder.groups.length > GROUPS_SHOWN && !allGroups && (
        <button
          type="button"
          onClick={() => setAllGroups(true)}
          className={`w-full rounded-md border border-border py-1.5 text-[11.5px] text-foreground/80 hover:bg-accent/40 hover:text-foreground ${FOCUS_RING}`}
        >
          Show all {folder.groups.length} projects
        </button>
      )}
    </div>
  );
}
