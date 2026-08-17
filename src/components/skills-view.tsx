"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI, type MdRow, type MdStar } from "@/lib/electron";
import {
  AGENT_KINDS,
  AGENT_TOOLS,
  agentFileKind,
  agentFileLabel,
  classifyAgentFile,
  collapseSkills,
  type AgentKind,
  type AgentTool,
} from "@/lib/agent-files";
import { compactHomePath, inferHomePath } from "@/lib/path-display";

interface SkillsViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

const FULL_KEY = "markie.skills.fullpath.v1";

export function SkillsView({ onOpenPath, activePath }: SkillsViewProps) {
  const api = getElectronAPI();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [filter, setFilter] = useState("");
  // Sections the user has flipped away from their default state.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [fullPath, setFullPath] = useState(
    () => localStorage.getItem(FULL_KEY) === "1"
  );

  const home = useMemo(() => {
    return inferHomePath(rows.flatMap((r) => [r.path, r.dir]));
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

  const toggleStar = (p: string) =>
    api?.mdIndexToggleStar?.(p, "file").then(() => loadStars());

  // Grouped by tool, then by what the file is for. One flat list per tool put
  // a skill, a subagent definition and a saved session note in the same run of
  // rows, which is what made this panel hard to read. Cached copies are
  // dropped by classifyAgentFile before they reach here.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byTool = new Map<AgentTool, Map<AgentKind, MdRow[]>>();
    for (const r of rows) {
      const tool = classifyAgentFile(r.path, r.name);
      if (!tool) continue;
      if (q && !r.path.toLowerCase().includes(q)) continue;
      const kind = agentFileKind(r.path, r.name);
      const kinds = byTool.get(tool) ?? new Map<AgentKind, MdRow[]>();
      byTool.set(tool, kinds);
      const arr = kinds.get(kind);
      if (arr) arr.push(r);
      else kinds.set(kind, [r]);
    }
    return AGENT_TOOLS.map((t) => {
      const kinds = byTool.get(t.id);
      return {
        tool: t,
        total: kinds ? [...kinds.values()].reduce((n, f) => n + f.length, 0) : 0,
        sections: AGENT_KINDS.map((k) => {
          const files = kinds?.get(k.id) ?? [];
          // A skill is a folder: one row for it, not one per reference doc.
          const rows =
            k.id === "skill"
              ? collapseSkills(files)
              : files
                  .map((f) => ({
                    file: f,
                    label: agentFileLabel(f.path, f.name),
                    contains: 1,
                  }))
                  .sort((a, b) => a.label.localeCompare(b.label));
          return { kind: k, rows };
        }).filter((sec) => sec.rows.length > 0),
      };
    }).filter((g) => g.total > 0);
  }, [rows, filter]);

  if (!api?.mdIndexScan)
    return (
      <div className="p-4 text-[12px] text-muted">
        Skills are available in the desktop app.
      </div>
    );

  const total = grouped.reduce((n, g) => n + g.total, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-border">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter skills & agent files…"
          className="flex-1 text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
        />
        <button
          onClick={() => {
            const v = !fullPath;
            setFullPath(v);
            try { localStorage.setItem(FULL_KEY, v ? "1" : "0"); } catch { /* ignore */ }
          }}
          className={`px-1.5 py-0.5 rounded text-[11px] ${
            fullPath ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
          }`}
          title="Show full ~ paths"
        >
          ~/
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-[12px] text-muted">Looking for agent files…</div>
        ) : total === 0 ? (
          <div className="p-4 text-[12px] text-muted leading-relaxed">
            No agent files found{filter ? " for this filter" : ""}. Markie looks for
            CLAUDE.md, AGENTS.md, GEMINI.md, and your{" "}
            <code>~/.claude/skills</code> + <code>~/.codex</code> files.
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.tool.id}>
              <div className="text-[9px] uppercase tracking-wide text-muted px-2 pt-3 pb-1 border-b border-border/60 sticky top-0 bg-surface">
                {g.tool.label}
                <span className="ml-1 text-muted">{g.total}</span>
              </div>
              {g.sections.map((sec) => {
                const key = `${g.tool.id}:${sec.kind.id}`;
                // A filter is a search, so it overrides the fold: hiding the
                // matches behind a closed section would defeat the filter.
                const isOpen = filter
                  ? true
                  : closed.has(key)
                    ? false
                    : !sec.kind.collapsed;
                return (
                <div key={sec.kind.id}>
                  <div
                    onClick={() =>
                      setClosed((s) => {
                        const n = new Set(s);
                        // Stored as "not in its default state", so a section
                        // opened by hand stays open and one closed by hand
                        // stays closed.
                        if (n.has(key)) n.delete(key);
                        else n.add(key);
                        return n;
                      })
                    }
                    className="text-[10px] text-muted/80 px-2 pt-2 pb-0.5 flex items-center gap-1 cursor-pointer hover:text-foreground"
                  >
                    <span className="w-2.5">{isOpen ? "▾" : "▸"}</span>
                    {sec.kind.label}
                    <span className="ml-1">{sec.rows.length}</span>
                  </div>
                  {isOpen && sec.rows.map(({ file: f, label, contains }) => (
                    <div
                      key={f.path}
                      onClick={() => onOpenPath(f.path)}
                      title={f.path}
                      className={`flex items-center gap-1 pl-4 pr-2 py-1 cursor-pointer hover:bg-accent/30 ${
                        activePath === f.path ? "bg-accent/40" : ""
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] text-foreground/90">
                          {label}
                          {contains > 1 && (
                            <span className="ml-1 text-[9px] text-muted">
                              +{contains - 1}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[10px] text-muted">
                          {compactHomePath(f.dir, home, fullPath)}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleStar(f.path); }}
                        title={stars.has(f.path) ? "Unstar" : "Star"}
                        className={`shrink-0 px-1 text-[12px] ${
                          stars.has(f.path) ? "text-[var(--status-yellow)]" : "text-muted hover:text-foreground"
                        }`}
                      >
                        {stars.has(f.path) ? "★" : "☆"}
                      </button>
                    </div>
                  ))}
                </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
