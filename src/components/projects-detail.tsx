"use client";

// One project, opened. Blocks and the runs of files that clustered with
// nothing, most-recent-first, with everything the organizing actions need.
// This is the old master-detail right-hand pane, now given the whole width
// because the left column it used to share with is a level up.
import { useMemo, useRef, useState } from "react";
import { longAgo } from "@/lib/relative-time";
import {
  FOCUS_RING,
  FileRow,
  MenuAction,
  MenuPanel,
  MenuSelect,
} from "@/components/projects-rows";
import type { BlockNode, FileNode, ProjectNode } from "@/lib/projects/taxonomy";

// A project can hold thousands of files, and this pane renders every block of
// it at once. Measured on the owner's real index, that was 11,168 rows in the
// DOM for a single project. Blocks open to a readable slice and say how many
// more there are.
const FILES_SHOWN = 40;

export interface DetailActions {
  pin: (path: string, project: string, blockId: string | null) => void;
  unpin: (path: string) => void;
  renameBlock: (blockId: string, name: string) => void;
  mergeBlock: (blockId: string, into: string) => void;
}

export function ProjectDetail({
  project,
  allProjects,
  pinnedPaths,
  home,
  searching,
  onOpenPath,
  actions,
}: {
  project: ProjectNode;
  allProjects: ProjectNode[];
  pinnedPaths: Set<string>;
  home: string;
  searching: boolean;
  onOpenPath: (path: string) => void;
  actions: DetailActions;
}) {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<string | null>(null);
  const [blockMenu, setBlockMenu] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ blockId: string; value: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Escape unmounts the focused input, and removing a focused element still
  // fires React's delegated blur: without this, cancelling a rename renamed
  // the block anyway. Same guard files-view.tsx carries, for the same reason.
  const settled = useRef(true);

  const beginRename = (block: BlockNode) => {
    setBlockMenu(null);
    settled.current = false;
    setEdit({ blockId: block.id, value: block.name });
  };
  const cancelRename = () => {
    settled.current = true;
    setEdit(null);
  };
  const submitRename = () => {
    if (settled.current || !edit) return;
    settled.current = true;
    const value = edit.value.trim();
    setEdit(null);
    if (value) actions.renameBlock(edit.blockId, value);
  };

  const dropOnto = (blockId: string | null) => {
    const path = dragPath;
    setDragPath(null);
    if (path) actions.pin(path, project.key, blockId);
  };

  // Blocks and loose files share one most-recent-first order. A loose file
  // renders as a bare row rather than a card: a card is a piece of work, and
  // drawing one around a single file is the folder costume this pass took off.
  // Loose rows that land next to each other are then collected into one run,
  // so the pane can set a run off from the cards around it and label it once,
  // rather than dropping unexplained bare rows between cards. The order is
  // untouched: a run is exactly the loose files that already sorted together.
  const entries = useMemo(() => {
    const rows: Array<{ at: number; block?: BlockNode; file?: FileNode }> = [
      ...project.blocks.map((b) => ({ at: b.updated, block: b })),
      ...project.looseFiles.map((f) => ({ at: f.mtimeMs, file: f })),
    ];
    rows.sort((a, b) => b.at - a.at);
    const groups: Array<{ block?: BlockNode; loose?: FileNode[] }> = [];
    for (const row of rows) {
      if (row.block) {
        groups.push({ block: row.block });
        continue;
      }
      const tail = groups[groups.length - 1];
      if (tail?.loose) tail.loose.push(row.file!);
      else groups.push({ loose: [row.file!] });
    }
    return groups;
  }, [project]);

  // One row, wherever the file sits. `inBlock` is the block it is already in,
  // so the move menu never offers to move it where it already is.
  const organizeRow = (file: FileNode, inBlock: string | null) => (
    <FileRow
      key={file.path}
      file={file}
      home={home}
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
            options={allProjects
              .filter((p) => p.key !== project.key)
              .map((p) => ({ value: p.key, label: p.name }))}
            onPick={(target) => {
              setFileMenu(null);
              actions.pin(file.path, target, null);
            }}
          />
          <MenuSelect
            label="Move to block"
            options={project.blocks
              .filter((b) => b.id !== inBlock)
              .map((b) => ({ value: b.id, label: b.name }))}
            onPick={(blockId) => {
              setFileMenu(null);
              actions.pin(file.path, project.key, blockId);
            }}
          />
          {/* The path stopped being printed on every row in this pass, so the
              one person who needed it whole gets it here instead of losing it. */}
          <MenuAction
            onClick={() => {
              setFileMenu(null);
              void navigator.clipboard?.writeText(file.path);
            }}
          >
            Copy path
          </MenuAction>
          {pinnedPaths.has(file.path) && (
            <MenuAction
              onClick={() => {
                setFileMenu(null);
                actions.unpin(file.path);
              }}
            >
              Unpin (follow rules)
            </MenuAction>
          )}
        </MenuPanel>
      )}
    </FileRow>
  );

  // The header used to run "name / 15 files / started / updated / ✎ / ⋯" as six
  // items of near-equal weight on one baseline, so the thing a person is
  // actually scanning for came fifth in the reading order by size. Now the name
  // carries the card, the count sits with it as part of its identity, and the
  // rest is either demoted to the trailing corner or waits for a hover.
  const quiet =
    "shrink-0 rounded-md px-1 text-muted opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 group-focus-within/card:opacity-100";
  const blockHeader = (block: BlockNode) => (
    <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
      {edit?.blockId === block.id ? (
        <input
          autoFocus
          aria-label="Block name"
          value={edit.value}
          onChange={(e) => setEdit({ blockId: block.id, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitRename();
            if (e.key === "Escape") {
              e.stopPropagation();
              cancelRename();
            }
          }}
          onBlur={submitRename}
          className={`markie-overlay-field min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-[13.5px] ${FOCUS_RING}`}
        />
      ) : (
        <>
          <h3 className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">
            {block.name}
          </h3>
          <span className="shrink-0 text-[10.5px] text-muted">
            {block.files.length} {block.files.length === 1 ? "file" : "files"}
          </span>
        </>
      )}
      <span
        className="ml-auto shrink-0 text-[10.5px] text-muted opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100"
        title={`Started ${new Date(block.made).toLocaleString()}`}
      >
        started {longAgo(block.made)}
      </span>
      <span
        className="shrink-0 text-[10.5px] text-muted"
        title={new Date(block.updated).toLocaleString()}
      >
        updated {longAgo(block.updated)}
      </span>
      <button
        type="button"
        onClick={() => beginRename(block)}
        aria-label={`Rename block ${block.name}`}
        className={`${quiet} text-[12px] ${FOCUS_RING}`}
      >
        ✎
      </button>
      <button
        type="button"
        onClick={() => setBlockMenu(blockMenu === block.id ? null : block.id)}
        aria-label={`More actions for ${block.name}`}
        aria-expanded={blockMenu === block.id}
        className={`${quiet} text-[13px] leading-none ${FOCUS_RING} ${
          blockMenu === block.id ? "opacity-100" : ""
        }`}
      >
        ⋯
      </button>
      {blockMenu === block.id && (
        <MenuPanel>
          <MenuAction onClick={() => beginRename(block)}>Rename block</MenuAction>
          <div className="mt-1.5">
            <MenuSelect
              label="Merge into"
              options={project.blocks
                .filter((b) => b.id !== block.id)
                .map((b) => ({ value: b.id, label: b.name }))}
              onPick={(target) => {
                setBlockMenu(null);
                actions.mergeBlock(block.id, target);
              }}
            />
          </div>
        </MenuPanel>
      )}
    </div>
  );

  if (!entries.length) {
    return (
      <div data-markie-projects-detail className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <p className="text-[12.5px] text-muted">
          {searching
            ? "Nothing in this project matches that."
            : "This project is empty. Open any other project and move files into it from a file's ⋯ menu."}
        </p>
      </div>
    );
  }

  return (
    <div
      data-markie-projects-detail
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5"
    >
      {entries.map((entry) =>
        entry.loose ? (
          // A peer of a different kind. It takes the card's footprint and the
          // card's fill, so it weighs what a card weighs, but it is an open
          // form: one spine down its left instead of a closed outline, square
          // where a card is rounded, and a caption where a card carries a
          // title. An outdented bare row never weighed enough to read as a
          // peer, and a closed box would just be a block, which is the one
          // thing these files are not in.
          <div
            key={`loose:${entry.loose[0].path}`}
            data-markie-project-loose
            // -ml-px: the spine is 2px where a card's border is 1px, so the run
            // starts one pixel left and every name inside it lands on exactly
            // the line the block names land on.
            className="my-4 -ml-px rounded-r-lg border-l-2 border-border bg-surface first:mt-0"
          >
            <div className="flex items-center gap-2.5 px-3 pb-2 pt-3">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted">
                Not in a block
              </span>
              <span className="text-[10.5px] text-muted">
                {entry.loose.length} {entry.loose.length === 1 ? "file" : "files"}
              </span>
            </div>
            <div className="px-1 pb-1.5">{entry.loose.map((file) => organizeRow(file, null))}</div>
          </div>
        ) : (
          <section
            key={entry.block!.id}
            data-markie-project-block={entry.block!.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              dropOnto(entry.block!.id);
            }}
            className="group/card relative mb-3 rounded-lg border border-border bg-surface"
          >
            {/* No rule under the header. A card already draws two horizontal
                lines of its own, and a third inside it turned a column of
                blocks into a column of stripes. Space and weight separate the
                name from its files instead. */}
            {blockHeader(entry.block!)}
            <div className="px-1 pb-1.5">
              {(expanded.has(entry.block!.id)
                ? entry.block!.files
                : entry.block!.files.slice(0, FILES_SHOWN)
              ).map((file) => organizeRow(file, entry.block!.id))}
              {entry.block!.files.length > FILES_SHOWN && !expanded.has(entry.block!.id) && (
                <button
                  type="button"
                  onClick={() => setExpanded(new Set(expanded).add(entry.block!.id))}
                  className={`mt-0.5 flex w-full items-center gap-1.5 rounded-md py-1 pl-3 pr-2 text-left text-[11.5px] text-foreground/80 hover:bg-accent/40 hover:text-foreground ${FOCUS_RING}`}
                >
                  <span aria-hidden="true" className="text-muted">
                    ▾
                  </span>
                  Show all {entry.block!.files.length} files
                </button>
              )}
            </div>
          </section>
        )
      )}
    </div>
  );
}
