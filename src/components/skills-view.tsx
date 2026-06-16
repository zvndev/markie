"use client";

import { useEffect, useMemo, useState } from "react";
import { getElectronAPI, type MdRow, type MdStar } from "@/lib/electron";
import { classifyAgentFile, AGENT_TOOLS, type AgentTool } from "@/lib/agent-files";

interface SkillsViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

const FULL_KEY = "markie.skills.fullpath.v1";

function homeShort(p: string, home: string, full: boolean) {
  if (full) return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return home && p.startsWith(home) ? p.slice(home.length + 1) : p;
}

export function SkillsView({ onOpenPath, activePath }: SkillsViewProps) {
  const api = getElectronAPI();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [filter, setFilter] = useState("");
  const [fullPath, setFullPath] = useState(
    () => localStorage.getItem(FULL_KEY) === "1"
  );

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

  const toggleStar = (p: string) =>
    api?.mdIndexToggleStar?.(p, "file").then(() => loadStars());

  // Classify into agent tools, then group by tool in display order.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byTool = new Map<AgentTool, MdRow[]>();
    for (const r of rows) {
      const tool = classifyAgentFile(r.path, r.name);
      if (!tool) continue;
      if (q && !r.path.toLowerCase().includes(q)) continue;
      const arr = byTool.get(tool);
      if (arr) arr.push(r);
      else byTool.set(tool, [r]);
    }
    return AGENT_TOOLS.map((t) => ({
      tool: t,
      files: (byTool.get(t.id) ?? []).sort((a, b) => a.path.localeCompare(b.path)),
    })).filter((g) => g.files.length > 0);
  }, [rows, filter]);

  if (!api?.mdIndexScan)
    return (
      <div className="p-4 text-[12px] text-muted">
        Skills are available in the desktop app.
      </div>
    );

  const total = grouped.reduce((n, g) => n + g.files.length, 0);

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
              <div className="text-[9px] uppercase tracking-wide text-muted/70 px-2 pt-3 pb-1">
                {g.tool.label}
                <span className="ml-1 text-muted/50">{g.files.length}</span>
              </div>
              {g.files.map((f) => (
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
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleStar(f.path); }}
                    title={stars.has(f.path) ? "Unstar" : "Star"}
                    className={`shrink-0 px-1 text-[12px] ${
                      stars.has(f.path) ? "text-yellow-400" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {stars.has(f.path) ? "★" : "☆"}
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
