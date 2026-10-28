import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getElectronAPI, type ElectronAPI, type MdRow, type MdStar } from "@/lib/electron";
import {
  AGENT_KINDS,
  agentFileKind,
  agentFileLabel,
  collapseSkills,
  skillRootOf,
  type AgentKind,
} from "@/lib/agent-files";
import { compactHomePath, inferHomePath } from "@/lib/path-display";
import {
  SKILLS_KIND_OPEN,
  SKILLS_KIND_ORDER,
  SKILL_GROUPS,
  canonicalFolder,
  skillGroupFor,
  type SkillGroupId,
} from "@/lib/skills-panel";

interface SkillsViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

const FULL_KEY = "markie.skills.fullpath.v1";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--status-blue)]";

const KIND_LABEL = new Map(AGENT_KINDS.map((k) => [k.id, k.label]));

// One left edge for the whole panel: fields, headings and rows all start here.
// Rows inside a section indent one step from it, and nothing else does.
const EDGE = "px-2";

// The section label, in the treatment Library and Browse already use.
const SECTION_LABEL = "text-[9px] uppercase tracking-wide text-muted";

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference that will not save is not worth a broken panel */
  }
}

// "Finder" on its own reads as a noun in a row of verbs. The label says what
// the click does, and names the thing the platform calls it.
function revealWord(platform: string): { text: string; label: string } {
  if (platform === "win32") return { text: "Explorer", label: "Show in Explorer" };
  if (platform === "darwin") return { text: "Finder", label: "Show in Finder" };
  return { text: "Files", label: "Show in your file manager" };
}

// ── Small shared pieces ──

function LinkButton({
  onClick,
  children,
  tone = "muted",
  title,
  ariaLabel,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  tone?: "muted" | "blue" | "red";
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const colors =
    tone === "blue"
      ? "text-[var(--status-blue)] hover:underline"
      : tone === "red"
        ? "text-[var(--status-red)] hover:underline"
        : "text-muted hover:text-foreground";
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded text-[10.5px] disabled:opacity-50 ${colors} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function Star({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={on ? "Unstar" : "Star"}
      aria-label={on ? "Unstar" : "Star"}
      className={`shrink-0 px-1 text-[12px] ${
        on ? "text-[var(--status-yellow)]" : "text-muted hover:text-foreground"
      }`}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

// ── The panel ──

export function SkillsView({ onOpenPath, activePath }: SkillsViewProps) {
  const api = getElectronAPI();
  const [rows, setRows] = useState<MdRow[]>([]);
  const [loading, setLoading] = useState(!!api?.mdIndexScan);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api?.mdIndexScan) return;
    let alive = true;
    api.mdIndexScan()
      .then((res) => {
        if (!alive) return;
        // The scan can fail without rejecting: main answers the same shape
        // with an empty list and an `error`.
        if (!Array.isArray(res?.files)) {
          setError(res?.error ?? "Couldn't read your agent files.");
          setLoading(false);
          return;
        }
        setRows(res.files);
        setError(null);
        setLoading(false);
      })
      // Without this the panel sat on "Looking for agent files…" forever.
      .catch(() => {
        if (!alive) return;
        setError("Couldn't read your agent files.");
        setLoading(false);
      });
    // The broadcast carries the scan result; asking for another scan in
    // response to one meant two device-wide walks per event.
    const off = api.onMdIndexUpdated?.((payload) => {
      if (!alive) return;
      if (payload?.files) {
        setRows(payload.files);
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

  // Rescan on demand, so an error state is not a dead end.
  const retry = () => {
    if (!api?.mdIndexRefresh) return;
    setError(null);
    setLoading(true);
    api.mdIndexRefresh()
      .then((res) => {
        if (!Array.isArray(res?.files)) {
          setError(res?.error ?? "Couldn't read your agent files.");
          setLoading(false);
          return;
        }
        setRows(res.files);
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        setError("Couldn't read your agent files.");
        setLoading(false);
      });
  };

  if (!api?.mdIndexScan)
    return (
      <div className="p-4 text-[12px] text-muted">
        Skills are available in the desktop app.
      </div>
    );

  return (
    <div className="flex flex-col h-full">
      <InstalledSkills
        api={api}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={retry}
        onOpenPath={onOpenPath}
        activePath={activePath}
      />
    </div>
  );
}

// ── Installed ──

interface SkillRow {
  key: string;
  group: SkillGroupId;
  label: string;
  openPath: string;
  description: string | null;
}

interface PlainRow {
  file: MdRow;
  label: string;
}

function InstalledSkills({
  api,
  rows,
  loading,
  error,
  onRetry,
  onOpenPath,
  activePath,
}: {
  api: ElectronAPI;
  rows: MdRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenPath: (path: string) => void;
  activePath: string | null;
}) {
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // Sections the user has flipped away from their default state.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [fullPath, setFullPath] = useState(() => localStorage.getItem(FULL_KEY) === "1");

  const loadStars = useCallback(
    () =>
      api.mdIndexStars?.()
        .then((s: MdStar[]) =>
          setStars(new Set((Array.isArray(s) ? s : []).map((x) => x.path)))
        )
        // Stars are decoration: losing them must not take the panel down.
        .catch(() => {}),
    [api]
  );

  useEffect(() => {
    loadStars();
  }, [loadStars]);

  const home = useMemo(() => inferHomePath(rows.flatMap((r) => [r.path, r.dir])), [rows]);

  const toggleStar = (p: string) =>
    api.mdIndexToggleStar?.(p, "file")
      .then(() => {
        setNotice(null);
        return loadStars();
      })
      .catch(() => setNotice("Couldn't save that star."));

  // One row per skill folder, from the markdown index, which sees every skill
  // on disk however it got there.
  const skillsByGroup = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const perGroup = new Map<SkillGroupId, MdRow[]>();
    for (const r of rows) {
      if (agentFileKind(r.path, r.name) !== "skill") continue;
      const group = skillGroupFor(r.path, r.name, r.skill);
      if (!group) continue;
      const list = perGroup.get(group);
      if (list) list.push(r);
      else perGroup.set(group, [r]);
    }
    const out = new Map<SkillGroupId, SkillRow[]>();
    for (const [group, files] of perGroup) {
      for (const { file, label } of collapseSkills(files)) {
        const row: SkillRow = {
          key: canonicalFolder(skillRootOf(file.path) ?? file.dir, api.platform),
          group,
          label,
          openPath: file.path,
          // The front matter's description, when the index read it.
          description: file.skill?.description ?? null,
        };
        if (
          q &&
          !row.label.toLowerCase().includes(q) &&
          !row.key.toLowerCase().includes(q) &&
          !String(row.description ?? "").toLowerCase().includes(q)
        ) {
          continue;
        }
        const list = out.get(group);
        if (list) list.push(row);
        else out.set(group, [row]);
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [rows, filter, api.platform]);

  // Everything that is not a skill, grouped the way this panel always has.
  const otherByGroup = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = new Map<SkillGroupId, Map<AgentKind, PlainRow[]>>();
    for (const r of rows) {
      const kind = agentFileKind(r.path, r.name);
      if (kind === "skill") continue;
      const group = skillGroupFor(r.path, r.name);
      if (!group) continue;
      if (q && !r.path.toLowerCase().includes(q)) continue;
      const kinds = out.get(group) ?? new Map<AgentKind, PlainRow[]>();
      out.set(group, kinds);
      const row = { file: r, label: agentFileLabel(r.path, r.name) };
      const list = kinds.get(kind);
      if (list) list.push(row);
      else kinds.set(kind, [row]);
    }
    for (const kinds of out.values()) {
      for (const list of kinds.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    }
    return out;
  }, [rows, filter]);

  const groups = SKILL_GROUPS.map((tool) => {
    const skills = skillsByGroup.get(tool.id) ?? [];
    const kinds = otherByGroup.get(tool.id);
    const others = [...(kinds?.values() ?? [])].reduce((n, list) => n + list.length, 0);
    return { tool, skills, kinds, total: skills.length + others };
  }).filter((g) => g.total > 0);

  const total = groups.reduce((n, g) => n + g.total, 0);

  const reveal = (path: string) =>
    api.revealFile?.(path)
      .then((res) => {
        if (res && res.error) setNotice("Couldn't show that folder.");
      })
      .catch(() => setNotice("Couldn't show that folder."));

  const word = revealWord(api.platform);

  return (
    <>
      <div className={`${EDGE} py-1.5 flex items-center gap-1.5 border-b border-border shrink-0`}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter skills & agent files…"
          aria-label="Filter skills and agent files"
          className="flex-1 text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
        />
        <button
          type="button"
          onClick={() => {
            const v = !fullPath;
            setFullPath(v);
            persist(FULL_KEY, v ? "1" : "0");
          }}
          className={`px-1.5 py-0.5 rounded text-[11px] ${
            fullPath ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
          }`}
          title="Show full ~ paths"
        >
          ~/
        </button>
      </div>

      {notice && (
        <div
          role="status"
          className={`${EDGE} py-1.5 text-[11px] text-[var(--status-red)] border-b border-border shrink-0`}
        >
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className={`${EDGE} py-4 text-[12px] text-[var(--status-red)]`}>
            {error}{" "}
            <button onClick={onRetry} className="underline hover:no-underline">
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className={`${EDGE} py-4 text-[12px] text-muted`}>Looking for agent files…</div>
        ) : total === 0 ? (
          <div className={`${EDGE} py-4 text-[12px] text-muted leading-relaxed`}>
            No agent files found{filter ? " for this filter" : ""}. Markie looks for
            CLAUDE.md, AGENTS.md, GEMINI.md, and the skills folders of Claude Code,
            Codex, Cursor, Gemini and <code>~/.agents</code>.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.tool.id}>
              <div
                data-skills-group={g.tool.id}
                className={`${SECTION_LABEL} ${EDGE} pt-3 pb-1 border-b border-border/60 sticky top-0 bg-surface`}
              >
                <span>{g.tool.label}</span>
                <span className="ml-1 text-muted">{g.total}</span>
              </div>
              {SKILLS_KIND_ORDER.map((kind) => {
                const plain = g.kinds?.get(kind) ?? [];
                const count = kind === "skill" ? g.skills.length : plain.length;
                if (count === 0) return null;
                const key = `${g.tool.id}:${kind}`;
                // A filter is a search, so it overrides the fold: hiding the
                // matches behind a closed section would defeat the filter.
                const isOpen = filter
                  ? true
                  : closed.has(key)
                    ? kind !== SKILLS_KIND_OPEN
                    : kind === SKILLS_KIND_OPEN;
                return (
                  <div key={kind}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
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
                      className={`w-full text-left text-[10px] text-muted/80 ${EDGE} pt-2 pb-0.5 flex items-center gap-1 hover:text-foreground ${FOCUS_RING}`}
                    >
                      <span className="w-2.5">{isOpen ? "▾" : "▸"}</span>
                      {KIND_LABEL.get(kind) ?? kind}
                      <span className="ml-1">{count}</span>
                    </button>
                    {isOpen &&
                      (kind === "skill"
                        ? g.skills.map((row) => (
                            <InstalledSkillRow
                              key={row.key}
                              row={row}
                              active={activePath === row.openPath}
                              starred={stars.has(row.openPath)}
                              revealWord={word}
                              onOpen={() => onOpenPath(row.openPath)}
                              onStar={() => toggleStar(row.openPath)}
                              onReveal={() => reveal(row.openPath)}
                            />
                          ))
                        : plain.map(({ file, label }) => (
                            <div
                              key={file.path}
                              onClick={() => onOpenPath(file.path)}
                              title={file.path}
                              className={`flex items-center gap-1 pl-4 pr-2 py-1 cursor-pointer hover:bg-accent/30 ${
                                activePath === file.path ? "bg-accent/40" : ""
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[12px] text-foreground/90">
                                  {label}
                                </div>
                                <div className="truncate text-[10px] text-muted">
                                  {compactHomePath(file.dir, home, fullPath)}
                                </div>
                              </div>
                              <Star
                                on={stars.has(file.path)}
                                onClick={() => toggleStar(file.path)}
                              />
                            </div>
                          )))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function InstalledSkillRow({
  row,
  active,
  starred,
  revealWord: word,
  onOpen,
  onStar,
  onReveal,
}: {
  row: SkillRow;
  active: boolean;
  starred: boolean;
  revealWord: { text: string; label: string };
  onOpen: () => void;
  onStar: () => void;
  onReveal: () => void;
}) {
  return (
    <div
      data-skills-installed={row.key}
      onClick={onOpen}
      title={row.key}
      className={`pl-4 pr-2 py-1 cursor-pointer hover:bg-accent/30 ${
        active ? "bg-accent/40" : ""
      }`}
    >
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          <span>{row.label}</span>
        </div>
        <Star on={starred} onClick={onStar} />
      </div>
      {row.description && (
        <div className="truncate text-[10px] text-muted">{row.description}</div>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <LinkButton onClick={onReveal} title={word.label} ariaLabel={`${word.label}: ${row.label}`}>
          {word.label}
        </LinkButton>
      </div>
    </div>
  );
}
