import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { getElectronAPI, type MdRow, type MdStar } from "@/lib/electron";
import { compactHomePath, inferHomePath } from "@/lib/path-display";
import {
  buildFolderTree,
  countNodes,
  initialOpenSet,
  pathsToFiles,
  sortTree,
  type FileEntry,
  type FolderNode,
  type SortOrder,
} from "@/lib/folder-tree";
import { updatedAgo, updatedOn } from "@/lib/relative-time";

interface BrowseViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

const STAR_KEY = "markie.browse.starred.v1";
const FULL_KEY = "markie.browse.fullpath.v1";
const OPEN_KEY = "markie.browse.open.v1";
const SORT_KEY = "markie.browse.sort.v1";

const SORTS: Array<{ order: SortOrder; label: string; hint: string }> = [
  { order: "name", label: "Name", hint: "Sort by name" },
  { order: "updated", label: "Updated", hint: "Sort by when it last changed" },
];

// Which folders the user has opened, once they have opened any. Absent means
// they never have, and the tree opens itself to its first branching level
// instead; an empty array is a real answer, not the absence of one.
function rememberedOpen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((p): p is string => typeof p === "string"));
  } catch {
    return null;
  }
}

const MINUTE_MS = 60_000;

// How many rows one open folder draws before it stops and offers the rest. The
// indexer allows 200,000 files and nothing stops them all sitting in one
// folder; the tree used to open closed, so nobody had met that folder yet.
const ROW_CAP = 200;

// The dates in the column age on their own, and Browse can sit open for hours
// without a click to re-render it: "just now" would stay true-looking long
// after it stopped being true. Tick on the minute boundary so every row turns
// over together, and only while the panel is actually mounted.
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let repeat: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(
      () => {
        setTick((n) => n + 1);
        repeat = setInterval(() => setTick((n) => n + 1), MINUTE_MS);
      },
      MINUTE_MS - (Date.now() % MINUTE_MS)
    );
    return () => {
      clearTimeout(align);
      if (repeat) clearInterval(repeat);
    };
  }, []);
}

// Module scope so the recursive tree rows can use it too. It was defined
// inside BrowseView, which also meant a fresh component identity every render.
function Star({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={on ? "Unstar" : "Star"}
      className={`shrink-0 px-1 text-[12px] ${
        on ? "text-[var(--status-yellow)]" : "text-muted hover:text-foreground"
      }`}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

// Memoized, and handed its date as a finished string rather than a timestamp.
// The minute tick re-renders the whole tree to age that column, and without
// this every visible row would re-render every minute to print what it already
// said. When the string has not changed, this row does no work at all.
const FileRow = memo(function FileRow({
  file,
  ago,
  starred,
  active,
  onOpen,
  onToggleStar,
}: {
  file: FileEntry;
  ago: string;
  starred: boolean;
  active: boolean;
  onOpen: (path: string) => void;
  onToggleStar: (path: string, kind: "folder" | "file") => void;
}) {
  return (
    <div
      onClick={() => onOpen(file.path)}
      className={`flex items-center gap-1 pl-1 pr-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px] ${
        active ? "bg-accent/40" : ""
      }`}
    >
      {/* Stands in for the folder chevron, so names line up with the labels
          above them. */}
      <span aria-hidden="true" className="w-3 shrink-0" />
      {/* Deep rows have little room left for a name, so the whole path is one
          hover away, the same as a folder row. */}
      <span className="truncate flex-1" title={file.path}>
        {file.name}
      </span>
      <span
        data-markie-browse-updated
        // Empty when the indexer could not stat the file: an empty title
        // attribute is still a tooltip, so leave it off entirely.
        title={updatedOn(file.mtimeMs) || undefined}
        className="shrink-0 text-[10px] text-muted tabular-nums"
      >
        {ago}
      </span>
      <Star on={starred} onClick={() => onToggleStar(file.path, "file")} />
    </div>
  );
});

function FolderRow({
  node,
  label,
  open,
  forcedOpen,
  onToggle,
  revealed,
  onReveal,
  stars,
  onToggleStar,
  onOpenPath,
  activePath,
}: {
  node: FolderNode;
  label?: string;
  open: Set<string>;
  // Set while a filter is active: the tree opens to its matches rather than
  // hiding them behind rows the user would have to guess at.
  forcedOpen: Set<string> | null;
  onToggle: (path: string) => void;
  // The folders whose row cap the user has lifted. Kept for the session only:
  // asking for 30,000 rows is a decision about this list, right now, not a
  // preference to greet them with tomorrow.
  revealed: Set<string>;
  onReveal: (path: string) => void;
  stars: Set<string>;
  onToggleStar: (path: string, kind: "folder" | "file") => void;
  onOpenPath: (path: string) => void;
  activePath: string | null;
}) {
  const isOpen = forcedOpen ? forcedOpen.has(node.path) : open.has(node.path);
  // Files and folders share one budget, counted in the order they are drawn.
  const capped = !revealed.has(node.path) && node.files.length + node.children.length > ROW_CAP;
  const shownFiles = capped ? node.files.slice(0, ROW_CAP) : node.files;
  const shownChildren = capped
    ? node.children.slice(0, Math.max(0, ROW_CAP - node.files.length))
    : node.children;
  const hidden =
    node.files.length + node.children.length - shownFiles.length - shownChildren.length;
  return (
    <div data-markie-folder-node={node.path}>
      <div
        onClick={() => onToggle(node.path)}
        className="group flex items-center gap-1 pl-1 pr-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px]"
      >
        <span className="text-muted w-3 shrink-0">{isOpen ? "▾" : "▸"}</span>
        <span className="truncate flex-1 text-foreground/90" title={node.path}>
          {label ?? node.label}
        </span>
        <span className="text-[9px] text-muted shrink-0">{node.total}</span>
        <Star on={stars.has(node.path)} onClick={() => onToggleStar(node.path, "folder")} />
      </div>
      {isOpen && (
        // Depth used to be padding, which left rows floating with nothing to
        // read them against. A hairline in the same border token the panel
        // already uses does the same work and says where a level ends. The
        // 6 + 1 + 5 adds up to the 12 px a level always cost, so the line is
        // paid for out of the old indent rather than added on top of it: a
        // name four levels down has the room it had before.
        <div data-markie-browse-children className="ml-[6px] border-l border-border pl-[5px]">
          {shownFiles.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              ago={updatedAgo(f.mtimeMs)}
              starred={stars.has(f.path)}
              active={activePath === f.path}
              onOpen={onOpenPath}
              onToggleStar={onToggleStar}
            />
          ))}
          {shownChildren.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              open={open}
              forcedOpen={forcedOpen}
              onToggle={onToggle}
              revealed={revealed}
              onReveal={onReveal}
              stars={stars}
              onToggleStar={onToggleStar}
              onOpenPath={onOpenPath}
              activePath={activePath}
            />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              data-markie-browse-more
              onClick={() => onReveal(node.path)}
              className="flex w-full items-center gap-1 pl-1 pr-2 py-1 text-left text-[11px] text-muted hover:bg-accent/30 hover:text-foreground"
            >
              <span aria-hidden="true" className="w-3 shrink-0" />
              <span className="truncate">Show {hidden.toLocaleString()} more</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function BrowseView({ onOpenPath, activePath }: BrowseViewProps) {
  const api = getElectronAPI();
  useMinuteTick();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [refreshing, setRefreshing] = useState(false);
  const [starredOnly, setStarredOnly] = useState(
    () => localStorage.getItem(STAR_KEY) === "1"
  );
  const [fullPath, setFullPath] = useState(
    () => localStorage.getItem(FULL_KEY) === "1"
  );
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortOrder>(() =>
    localStorage.getItem(SORT_KEY) === "updated" ? "updated" : "name"
  );
  // Null until the user opens or closes something themselves; see the initial
  // rule below for what the tree does in the meantime.
  const [openedByHand, setOpenedByHand] = useState<Set<string> | null>(rememberedOpen);
  // Which folders have been asked to draw past the row cap, this session only.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // A failed star is a one-line complaint, not an error page over the list.
  const [starNotice, setStarNotice] = useState<string | null>(null);
  // A scan that stopped early (budget or depth cap) indexed a *subset* of the
  // device. Without saying so, "No markdown found" and a short list both read
  // as the whole truth.
  const [truncatedReason, setTruncatedReason] = useState<string | null>(null);

  // `truncated` is optional and older mains never send it, so absence means
  // "the scan was complete", not "unknown".
  const noteTruncation = (res: { truncated?: boolean; truncatedReason?: string | null } | null | undefined) =>
    setTruncatedReason(res?.truncated ? res.truncatedReason || "the scan stopped early" : null);

  // Derive home from indexed paths. Avoids an IPC call and works across desktop platforms.
  const home = useMemo(() => {
    return inferHomePath(rows.flatMap((r) => [r.path, r.dir]));
  }, [rows]);

  // Stable across renders, because the memoized file rows use it as a prop and
  // a fresh function every render would defeat the memo on every minute tick.
  const loadStars = useCallback(
    () =>
      api?.mdIndexStars?.()
        .then((s: MdStar[]) =>
          // A failed channel answers `{ error }`, not a list.
          setStars(new Set((Array.isArray(s) ? s : []).map((x) => x.path)))
        )
        // Stars are decoration: losing them must not take the panel down with it.
        .catch(() => {}),
    [api]
  );

  useEffect(() => {
    if (!api?.mdIndexScan) return;
    let alive = true;
    api.mdIndexScan()
      .then((res) => {
        if (!alive) return;
        // The scan can fail without rejecting: main answers the same shape
        // with an empty list and an `error`. Reading `res.files` blindly is
        // what used to crash this panel on a flatMap of undefined.
        if (!Array.isArray(res?.files)) {
          setError(res?.error ?? "Couldn't read your markdown files.");
          setLoading(false);
          return;
        }
        setRows(res.files);
        noteTruncation(res);
        setError(null);
        setLoading(false);
      })
      // Without this the panel sat on "Scanning your markdown…" forever.
      .catch(() => {
        if (!alive) return;
        setError("Couldn't read your markdown files.");
        setLoading(false);
      });
    loadStars();
    // The broadcast now carries the scan result. Asking for a fresh scan in
    // response to being told about one meant two full device walks per event.
    const off = api.onMdIndexUpdated?.((payload) => {
      if (!alive) return;
      if (payload?.files) {
        setRows(payload.files);
        noteTruncation(payload);
        setError(null);
        setLoading(false);
        return;
      }
      api.mdIndexRefresh?.()
        .then((res) => {
          if (!alive) return;
          if (!Array.isArray(res?.files)) {
            setError(res?.error ?? "Couldn't refresh the index.");
            setLoading(false);
            return;
          }
          setRows(res.files);
          noteTruncation(res);
          setError(null);
          setLoading(false);
        })
        .catch(() => {
          if (alive) setError("Couldn't refresh the index.");
        });
    });
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  };

  const refresh = () => {
    if (!api?.mdIndexRefresh) return;
    setRefreshing(true);
    api.mdIndexRefresh()
      .then((res) => {
        if (!Array.isArray(res?.files)) {
          setError(res?.error ?? "Rescan failed.");
          return;
        }
        setRows(res.files);
        noteTruncation(res);
        setError(null);
      })
      .catch(() => setError("Rescan failed."))
      // Always: the spinner used to stay lit forever on a failed rescan.
      .finally(() => setRefreshing(false));
  };

  // A star is decoration. Routing its failure through `error` replaced the
  // whole file list with an error page, so the user lost the panel over a
  // bookmark that didn't stick. Say so in the header instead.
  const toggleStar = useCallback(
    (p: string, kind: "folder" | "file") => {
      api?.mdIndexToggleStar?.(p, kind)
        .then(() => {
          setStarNotice(null);
          return loadStars();
        })
        .catch(() => setStarNotice("Couldn't save that star."));
    },
    [api, loadStars]
  );

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows),
    [rows, q]
  );

  // A tree, not one row per directory. Ten subfolders under one project used
  // to be ten sibling rows all reprinting the same prefix.
  const tree = useMemo(() => {
    const list = starredOnly
      ? filtered.filter((r) => stars.has(r.path) || stars.has(r.dir))
      : filtered;
    return buildFolderTree(list);
  }, [filtered, starredOnly, stars]);

  // Filtering is a search: leaving the answers behind collapsed rows would
  // make it useless. Capped so a filter that matches everything does not
  // expand thousands of folders at once.
  const AUTO_OPEN_CAP = 200;
  const forcedOpen = useMemo(() => {
    if (!q) return null;
    if (countNodes(tree) > AUTO_OPEN_CAP) return null;
    return new Set(pathsToFiles(tree));
  }, [q, tree]);

  const shown = useMemo(() => sortTree(tree, sort), [tree, sort]);

  // Everything used to start closed, so the panel opened on a row you had to
  // click before it told you anything. What the user opened themselves wins.
  const open = useMemo(
    () => openedByHand ?? initialOpenSet(tree),
    [openedByHand, tree]
  );

  const reveal = useCallback((path: string) => {
    setRevealed((prev) => new Set(prev).add(path));
  }, []);

  // A different sort or a different filter is a different list, so the folder
  // that was asked for all its rows is not the folder in front of you now.
  useEffect(() => {
    setRevealed((prev) => (prev.size === 0 ? prev : new Set()));
  }, [sort, q]);

  const toggle = (path: string) => {
    // While the filter is holding the tree open, a chevron has nothing to do:
    // the row springs back the moment it renders. Saving the filtered shape
    // over what the user opened for themselves is the part that lasted, and it
    // closed folders they never touched once the filter cleared.
    if (forcedOpen) return;
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpenedByHand(next);
    persist(OPEN_KEY, JSON.stringify([...next]));
  };

  if (!api?.mdIndexScan)
    return (
      <div className="p-4 text-[12px] text-muted">
        Browse is available in the desktop app.
      </div>
    );


  return (
    <div className="flex flex-col h-full">
      {/* controls */}
      <div className="px-2 py-1.5 flex flex-col gap-1.5 border-b border-border">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name or path…"
          className="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
        />
        <div className="flex items-center gap-1 text-[11px]">
          {/* Two tabs used to sit here, so name what these are: without the
              word they read as another pair of views. */}
          <span className="text-muted pl-0.5">Sort</span>
          {SORTS.map(({ order, label, hint }) => (
            <button
              key={order}
              onClick={() => {
                setSort(order);
                persist(SORT_KEY, order);
              }}
              aria-pressed={sort === order}
              title={hint}
              className={`px-2 py-0.5 rounded ${
                sort === order ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
          <div className="flex-1" />
          <button
            onClick={() => {
              const v = !starredOnly;
              setStarredOnly(v);
              persist(STAR_KEY, v ? "1" : "0");
            }}
            className={`px-1.5 py-0.5 rounded ${
              starredOnly ? "bg-accent text-[var(--status-yellow)]" : "text-muted hover:text-foreground"
            }`}
            title="Show starred only"
          >
            ★
          </button>
          <button
            onClick={() => {
              const v = !fullPath;
              setFullPath(v);
              persist(FULL_KEY, v ? "1" : "0");
            }}
            className={`px-1.5 py-0.5 rounded ${
              fullPath ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
            }`}
            title="Show full ~ paths"
          >
            ~/
          </button>
          <button
            onClick={refresh}
            className="px-1.5 py-0.5 rounded text-muted hover:text-foreground"
            title="Rescan"
          >
            {refreshing ? "…" : "⟳"}
          </button>
        </div>
      </div>

      {starNotice && (
        <div className="px-3 py-1.5 text-[11px] text-[var(--status-red)] border-b border-border">
          {starNotice}
        </div>
      )}

      {truncatedReason && !error && !loading && (
        <div
          data-markie-index-truncated
          role="status"
          className="px-3 py-1.5 text-[11px] text-[var(--status-yellow)] border-b border-border"
        >
          Index is incomplete: {truncatedReason}
        </div>
      )}

      {/* body */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-[12px] text-[var(--status-red)]">
            {error}{" "}
            <button onClick={refresh} className="underline hover:no-underline">
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="p-4 text-[12px] text-muted">Scanning your markdown…</div>
        ) : shown.length === 0 ? (
          <div className="p-4 text-[12px] text-muted">
            No markdown found{q ? " for this filter" : ""}.
          </div>
        ) : (
          <div className="pl-1">
            {shown.map((node) => (
              <FolderRow
                key={node.path}
                node={node}
                // The root prints as a path so you can tell where it is; every
                // level below it is already located by the row above.
                label={compactHomePath(node.path, home, fullPath)}
                open={open}
                forcedOpen={forcedOpen}
                onToggle={toggle}
                revealed={revealed}
                onReveal={reveal}
                stars={stars}
                onToggleStar={toggleStar}
                onOpenPath={onOpenPath}
                activePath={activePath}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
