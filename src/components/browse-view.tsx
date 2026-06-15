"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI, type MdRow, type MdStar } from "@/lib/electron";

interface BrowseViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

type Mode = "folders" | "files";
const MODE_KEY = "markie.browse.mode.v1";
const STAR_KEY = "markie.browse.starred.v1";
const FULL_KEY = "markie.browse.fullpath.v1";
const FLAT_CAP = 300;

function homeShort(p: string, home: string, full: boolean) {
  if (full) return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return home && p.startsWith(home) ? p.slice(home.length + 1) : p;
}

export function BrowseView({ onOpenPath, activePath }: BrowseViewProps) {
  const api = getElectronAPI();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem(MODE_KEY) as Mode) || "folders"
  );
  const [starredOnly, setStarredOnly] = useState(
    () => localStorage.getItem(STAR_KEY) === "1"
  );
  const [fullPath, setFullPath] = useState(
    () => localStorage.getItem(FULL_KEY) === "1"
  );
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Derive home from any row's path (macOS /Users/<name>). Avoids an IPC call.
  const home = useMemo(() => {
    const r = rows[0];
    if (!r || !r.path.startsWith("/Users/")) return "";
    return r.path.split("/").slice(0, 3).join("/");
  }, [rows]);

  const loadStars = () =>
    api?.mdIndexStars?.().then((s: MdStar[]) => setStars(new Set(s.map((x) => x.path))));

  useEffect(() => {
    if (!api?.mdIndexScan) return;
    let alive = true;
    api.mdIndexScan().then((res) => {
      if (!alive) return;
      setRows(res.files);
      setLoading(false);
    });
    loadStars();
    const off = api.onMdIndexUpdated?.(() => {
      api.mdIndexRefresh?.().then((res) => {
        if (alive) setRows(res.files);
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
    api.mdIndexRefresh().then((res) => {
      setRows(res.files);
      setRefreshing(false);
    });
  };

  const toggleStar = (p: string, kind: "folder" | "file") => {
    api?.mdIndexToggleStar?.(p, kind).then(() => loadStars());
  };

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? rows.filter((r) => r.path.toLowerCase().includes(q)) : rows),
    [rows, q]
  );

  const folders = useMemo(() => {
    const map = new Map<string, MdRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.dir);
      if (arr) arr.push(r);
      else map.set(r.dir, [r]);
    }
    let entries = Array.from(map.entries());
    if (starredOnly)
      entries = entries.filter(
        ([dir, files]) => stars.has(dir) || files.some((f) => stars.has(f.path))
      );
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return entries;
  }, [filtered, starredOnly, stars]);

  const flat = useMemo(() => {
    let list = filtered;
    if (starredOnly) list = list.filter((r) => stars.has(r.path) || stars.has(r.dir));
    return [...list].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, FLAT_CAP);
  }, [filtered, starredOnly, stars]);

  if (!api?.mdIndexScan)
    return (
      <div className="p-4 text-[12px] text-muted">
        Browse is available in the desktop app.
      </div>
    );

  const Star = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={on ? "Unstar" : "Star"}
      className={`shrink-0 px-1 text-[12px] ${
        on ? "text-yellow-400" : "text-muted hover:text-foreground"
      }`}
    >
      {on ? "★" : "☆"}
    </button>
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
          <button
            onClick={() => {
              setMode("folders");
              persist(MODE_KEY, "folders");
            }}
            className={`px-2 py-0.5 rounded ${
              mode === "folders" ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            Folders
          </button>
          <button
            onClick={() => {
              setMode("files");
              persist(MODE_KEY, "files");
            }}
            className={`px-2 py-0.5 rounded ${
              mode === "files" ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            All files
          </button>
          <div className="flex-1" />
          <button
            onClick={() => {
              const v = !starredOnly;
              setStarredOnly(v);
              persist(STAR_KEY, v ? "1" : "0");
            }}
            className={`px-1.5 py-0.5 rounded ${
              starredOnly ? "bg-accent text-yellow-400" : "text-muted hover:text-foreground"
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

      {/* body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-[12px] text-muted">Scanning your markdown…</div>
        ) : mode === "folders" ? (
          folders.length === 0 ? (
            <div className="p-4 text-[12px] text-muted">
              No markdown found{q ? " for this filter" : ""}.
            </div>
          ) : (
            folders.map(([dir, files]) => {
              const isOpen = open.has(dir);
              return (
                <div key={dir}>
                  <div
                    onClick={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(dir)) n.delete(dir);
                        else n.add(dir);
                        return n;
                      })
                    }
                    className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px]"
                  >
                    <span className="text-muted w-3">{isOpen ? "▾" : "▸"}</span>
                    <span className="truncate flex-1 text-foreground/90">
                      {homeShort(dir, home, fullPath)}
                    </span>
                    <span className="text-[9px] text-muted">{files.length}</span>
                    <Star on={stars.has(dir)} onClick={() => toggleStar(dir, "folder")} />
                  </div>
                  {isOpen &&
                    files.map((f) => (
                      <div
                        key={f.path}
                        onClick={() => onOpenPath(f.path)}
                        className={`flex items-center gap-1 pl-7 pr-2 py-1 cursor-pointer hover:bg-accent/30 text-[12px] ${
                          activePath === f.path ? "bg-accent/40" : ""
                        }`}
                      >
                        <span className="truncate flex-1">{f.name}</span>
                        <Star on={stars.has(f.path)} onClick={() => toggleStar(f.path, "file")} />
                      </div>
                    ))}
                </div>
              );
            })
          )
        ) : flat.length === 0 ? (
          <div className="p-4 text-[12px] text-muted">
            No markdown found{q ? " for this filter" : ""}.
          </div>
        ) : (
          <>
            {flat.map((f) => (
              <div
                key={f.path}
                onClick={() => onOpenPath(f.path)}
                className={`flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/30 ${
                  activePath === f.path ? "bg-accent/40" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-foreground/90">{f.name}</div>
                  <div className="truncate text-[10px] text-muted">
                    {homeShort(f.dir, home, fullPath)}
                  </div>
                </div>
                <Star on={stars.has(f.path)} onClick={() => toggleStar(f.path, "file")} />
              </div>
            ))}
            {filtered.length > FLAT_CAP && (
              <div className="p-3 text-[11px] text-muted">
                Showing newest {FLAT_CAP} of {filtered.length}. Use the filter to narrow.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
