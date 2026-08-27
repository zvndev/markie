"use client";

// The pieces every Projects level draws: a file row, and the little menu that
// hangs off it. Shared so the index, a project, and an auto folder all render
// a file the same way, because it is the same file.
import { compactDir } from "@/lib/path-display";
import { shortAgo } from "@/lib/relative-time";
import type { FileNode } from "@/lib/projects/taxonomy";

// The file name owns a fixed share of the row, so the directory beside it
// starts at the same x on every line instead of wherever that line's name
// happened to stop. A ragged second column is the thing that makes a list of
// forty files read as a heap; a real column is what makes it scannable. The
// share is generous enough that an ordinary name never truncates, and a name
// long enough to hit the edge ellipsizes there, which is what a column does.
export const NAME_COL = "shrink-0 grow-0 basis-[44%] truncate";

export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--status-blue)]";

export function MenuPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="markie-menu-panel markie-menu-raised absolute right-2 top-7 z-20 w-[240px] rounded-lg p-2 text-[12px]">
      {children}
    </div>
  );
}

export function MenuSelect({
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

export function MenuAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
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

// A file is a file wherever it sits. The rank is carried by the container it
// sits in, not by the row: a block is a card, a run of files that clustered
// with nothing is an open group, and both hold rows that look the same.
//
// The name leads and it is the only thing at full strength. The directory used
// to be the whole absolute path, which meant every row in a list of forty
// opened with the identical forty characters of somebody's home directory, and
// the one word that told them apart came second. Now the directory is the last
// two segments, muted and half a step smaller, and it gives its width up to
// the name rather than the other way round. The full path is still on the row
// as a title, and in the menu as something you can copy.
export function FileRow({
  file,
  home,
  pinned,
  onOpen,
  onDragStart,
  menuOpen,
  onMenu,
  children,
}: {
  file: FileNode;
  home: string;
  pinned: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  menuOpen: boolean;
  onMenu: () => void;
  children: React.ReactNode;
}) {
  const dir = compactDir(file.dir, home);
  return (
    <div
      className="group relative flex items-center gap-2 rounded-md py-[3px] pl-3 pr-2 hover:bg-accent/30"
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
        <span className={`${NAME_COL} text-[12.5px] text-foreground/90`}>{file.name}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">{dir}</span>
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
        className="min-w-[34px] shrink-0 text-right tabular-nums text-[10px] text-muted"
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
