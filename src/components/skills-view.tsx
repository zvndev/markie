import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  getElectronAPI,
  type Catalog,
  type CatalogSkill,
  type ElectronAPI,
  type InstalledSkill,
  type MdRow,
  type MdStar,
  type SearchHit,
  type SkillFile,
  type SkillTarget,
} from "@/lib/electron";
import {
  AGENT_KINDS,
  agentFileKind,
  agentFileLabel,
  collapseSkills,
  skillRootOf,
  type AgentKind,
} from "@/lib/agent-files";
import { compactHomePath, inferHomePath } from "@/lib/path-display";
import { RichView } from "@/components/rich-view";
import {
  LICENSE_NOTE,
  PROJECT_HINT,
  PROPRIETARY_NOTE,
  SKILLS_KIND_OPEN,
  SKILLS_KIND_ORDER,
  SKILLS_TAB_KEY,
  SKILL_GROUPS,
  UNIVERSAL_HINT,
  canonicalFolder,
  describeChecked,
  formatDestinations,
  formatSize,
  groupForTarget,
  initialSkillsTab,
  installLabel,
  licenseChip,
  matchesSkill,
  newestFetchedAt,
  ownerRepoError,
  readRememberedTargets,
  resolveHit,
  skillGroupFor,
  targetKey,
  targetLabel,
  writeRememberedTargets,
  type SkillGroupId,
  type SkillsTab,
} from "@/lib/skills-panel";

interface SkillsViewProps {
  onOpenPath: (path: string) => void;
  activePath: string | null;
}

const FULL_KEY = "markie.skills.fullpath.v1";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--status-blue)]";

/** A target that is a tool's own folder, as opposed to a project's. */
type ToolTarget = Exclude<SkillTarget, { project: string }>;

// The five targets a skill can be added to, in the order the detail pane and
// the Installed groups both use.
const TOOL_TARGETS: ToolTarget[] = ["claude", "codex", "cursor", "gemini", "universal"];

const KIND_LABEL = new Map(AGENT_KINDS.map((k) => [k.id, k.label]));

// One left edge for the whole panel: tabs, fields, headings, rows, the detail
// metadata and the document all start here. Rows inside a section indent one
// step from it, and nothing else does.
const EDGE = "px-2";

// The section label, in the treatment Library and Browse already use.
const SECTION_LABEL = "text-[9px] uppercase tracking-wide text-muted";

const EMPTY_CATALOG: Catalog = { sources: [], skills: [] };

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference that will not save is not worth a broken panel */
  }
}

/** The SKILL.md inside a folder, spelled with the folder's own separator. */
function skillMdIn(folder: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}SKILL.md`;
}

// "Finder" on its own reads as a noun in a row of verbs. The label says what
// the click does, and names the thing the platform calls it.
function revealWord(platform: string): { text: string; label: string } {
  if (platform === "win32") return { text: "Explorer", label: "Show in Explorer" };
  if (platform === "darwin") return { text: "Finder", label: "Show in Finder" };
  return { text: "Files", label: "Show in your file manager" };
}

// ── Small shared pieces ──

function Badge({
  children,
  tone = "muted",
  title,
}: {
  children: ReactNode;
  tone?: "muted" | "blue" | "yellow";
  title?: string;
}) {
  const colors =
    tone === "blue"
      ? "border-[color:var(--status-blue)] text-[var(--status-blue)]"
      : tone === "yellow"
        ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
        : "border-border/70 text-muted";
  return (
    <span title={title} className={`shrink-0 rounded border px-1 py-px text-[9px] ${colors}`}>
      {children}
    </span>
  );
}

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
  const [tab, setTab] = useState<SkillsTab>(() =>
    initialSkillsTab((key) => localStorage.getItem(key))
  );
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

  // Installing or removing a skill writes a folder main has never seen. Until
  // the index has walked it, that SKILL.md is not a path the main process will
  // open or reveal, because both take only paths the app itself advertised. The
  // watcher would get there on its own; asking makes it deterministic.
  const reindex = useCallback(
    () =>
      api?.mdIndexRefresh?.()
        .then((res) => {
          if (Array.isArray(res?.files)) setRows(res.files);
        })
        .catch(() => {}),
    [api]
  );

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

  const pickTab = (next: SkillsTab) => {
    setTab(next);
    persist(SKILLS_TAB_KEY, next);
  };

  return (
    <div className="flex flex-col h-full">
      <div
        className={`flex items-center gap-0.5 ${EDGE} py-1.5 shrink-0 border-b border-border/60`}
        role="group"
        aria-label="Skills sections"
      >
        {(
          [
            ["installed", "Installed"],
            ["discover", "Discover"],
          ] as Array<[SkillsTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-skills-tab={id}
            aria-pressed={tab === id}
            onClick={() => pickTab(id)}
            className={`flex-1 text-[11px] py-1 rounded-md transition-colors ${FOCUS_RING} ${
              tab === id
                ? "bg-accent text-foreground"
                : "text-muted hover:text-foreground hover:bg-accent/40"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "installed" ? (
        <InstalledTab
          api={api}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={retry}
          onReindex={reindex}
          onOpenPath={onOpenPath}
          activePath={activePath}
        />
      ) : (
        <DiscoverTab api={api} onReindex={reindex} />
      )}
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
  installed: InstalledSkill | null;
  projectName: string | null;
  /** Every place this same skill is installed, when there is more than one. */
  destinations: SkillTarget[];
}

interface PlainRow {
  file: MdRow;
  label: string;
  contains: number;
}

function InstalledTab({
  api,
  rows,
  loading,
  error,
  onRetry,
  onReindex,
  onOpenPath,
  activePath,
}: {
  api: ElectronAPI;
  rows: MdRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onReindex: () => void;
  onOpenPath: (path: string) => void;
  activePath: string | null;
}) {
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  // Read only for Update: an InstalledSkill records where a skill came from
  // but not which catalog entry it is, and skillsInstall wants that entry's id.
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Sections the user has flipped away from their default state.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [fullPath, setFullPath] = useState(() => localStorage.getItem(FULL_KEY) === "1");

  const loadInstalled = useCallback(() => {
    // A failed channel answers an empty list, never `{ error }`, so the panel
    // simply shows the skills the index found and no badges.
    const rows = api.skillsInstalled?.()
      .then((list) => setInstalled(Array.isArray(list) ? list : []))
      .catch(() => setInstalled([]));
    // Local: reading the catalog never touches the network.
    const known = api.skillsCatalogList?.()
      .then((next) => {
        if (next && Array.isArray(next.skills)) setCatalog(next);
      })
      .catch(() => {});
    return Promise.all([rows, known]);
  }, [api]);

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
    loadInstalled();
    loadStars();
  }, [loadInstalled, loadStars]);

  const home = useMemo(() => inferHomePath(rows.flatMap((r) => [r.path, r.dir])), [rows]);

  // Where a skill was installed to, back to the catalog entry it came from.
  const catalogByFolder = useMemo(() => {
    const out = new Map<string, CatalogSkill>();
    for (const skill of catalog.skills) {
      for (const entry of skill.installedTo) out.set(canonicalFolder(entry.path, api.platform), skill);
    }
    return out;
  }, [catalog, api.platform]);

  const toggleStar = (p: string) =>
    api.mdIndexToggleStar?.(p, "file")
      .then(() => {
        setNotice(null);
        return loadStars();
      })
      .catch(() => setNotice("Couldn't save that star."));

  // One row per skill folder, from two sources that overlap: the markdown
  // index (which sees every skill on disk, including the ones installed by
  // hand) and the install registry (which knows the source and whether an
  // update is waiting). Keyed by the folder, so a skill Markie installed is
  // one row and not two.
  const skillsByGroup = useMemo(() => {
    const byKey = new Map<string, SkillRow>();
    const perGroup = new Map<SkillGroupId, MdRow[]>();
    for (const r of rows) {
      if (agentFileKind(r.path, r.name) !== "skill") continue;
      const group = skillGroupFor(r.path, r.name);
      if (!group) continue;
      const list = perGroup.get(group);
      if (list) list.push(r);
      else perGroup.set(group, [r]);
    }
    for (const [group, files] of perGroup) {
      for (const { file, label } of collapseSkills(files)) {
        const key = canonicalFolder(skillRootOf(file.path) ?? file.dir, api.platform);
        byKey.set(key, {
          key,
          group,
          label,
          openPath: file.path,
          description: null,
          installed: null,
          projectName: null,
          destinations: [],
        });
      }
    }
    // Every place one skill was installed to, so a row can say where else it
    // lives. Only registry rows, which are the only ones that name a target.
    const places = new Map<string, SkillTarget[]>();
    for (const row of installed) {
      const identity = `${row.source ?? ""}::${row.name}`;
      const list = places.get(identity);
      if (list) list.push(row.target);
      else places.set(identity, [row.target]);
    }
    for (const row of installed) {
      const key = canonicalFolder(row.path, api.platform);
      const existing = byKey.get(key);
      const projectName = typeof row.target === "object" ? targetLabel(row.target) : null;
      const destinations = places.get(`${row.source ?? ""}::${row.name}`) ?? [];
      if (existing) {
        existing.installed = row;
        existing.description = row.description;
        existing.projectName = projectName;
        existing.destinations = destinations;
        // The recorded target beats the path: Claude Code and Codex both let
        // the user move their config folder, and then the path says nothing.
        existing.group = groupForTarget(row.target);
      } else {
        byKey.set(key, {
          key,
          group: groupForTarget(row.target),
          label: row.name,
          openPath: skillMdIn(row.path),
          description: row.description,
          installed: row,
          projectName,
          destinations,
        });
      }
    }
    const q = filter.trim().toLowerCase();
    const out = new Map<SkillGroupId, SkillRow[]>();
    for (const row of byKey.values()) {
      if (
        q &&
        !row.label.toLowerCase().includes(q) &&
        !row.key.toLowerCase().includes(q) &&
        !String(row.description ?? "").toLowerCase().includes(q)
      ) {
        continue;
      }
      const list = out.get(row.group);
      if (list) list.push(row);
      else out.set(row.group, [row]);
    }
    for (const list of out.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }, [rows, installed, filter, api.platform]);

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
      const row = { file: r, label: agentFileLabel(r.path, r.name), contains: 1 };
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

  const act = (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setNotice(null);
    setConfirming(null);
    run()
      .then(() => {
        onReindex();
        return loadInstalled();
      })
      .catch(() => setNotice("That didn't work. Try again."))
      .finally(() => setBusy(null));
  };

  const update = (row: SkillRow) => {
    const skill = row.installed;
    const entry = catalogByFolder.get(row.key);
    if (!skill || !api.skillsInstall) return;
    if (!entry) {
      setNotice("Markie can't find that skill in the catalog any more. Refresh its source.");
      return;
    }
    act(row.key, async () => {
      const result = await api.skillsInstall!(entry.id, [skill.target]);
      const failed = result?.errors?.[0];
      if (failed) setNotice(failed.message);
    });
  };

  const remove = (row: SkillRow) => {
    const skill = row.installed;
    if (!skill || !api.skillsRemove) return;
    act(row.key, async () => {
      const result = await api.skillsRemove!(skill.target, skill.name);
      if (result && result.ok === false) setNotice(result.error ?? "Couldn't remove that skill.");
    });
  };

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
                              busy={busy === row.key}
                              confirming={confirming === row.key}
                              starred={stars.has(row.openPath)}
                              revealWord={word}
                              onOpen={() => onOpenPath(row.openPath)}
                              onStar={() => toggleStar(row.openPath)}
                              onReveal={() => reveal(row.openPath)}
                              onUpdate={() => update(row)}
                              onRemove={() =>
                                confirming === row.key ? remove(row) : setConfirming(row.key)
                              }
                              onCancel={() => setConfirming(null)}
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
  busy,
  confirming,
  starred,
  revealWord: word,
  onOpen,
  onStar,
  onReveal,
  onUpdate,
  onRemove,
  onCancel,
}: {
  row: SkillRow;
  active: boolean;
  busy: boolean;
  confirming: boolean;
  starred: boolean;
  revealWord: { text: string; label: string };
  onOpen: () => void;
  onStar: () => void;
  onReveal: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const skill = row.installed;
  const updatable = !!skill?.updateAvailable;
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
        {updatable ? (
          <Badge tone="blue">update available</Badge>
        ) : skill?.source ? (
          <Badge>from {skill.source}</Badge>
        ) : null}
        <Star on={starred} onClick={onStar} />
      </div>
      {/* Where else this same skill lives. Under a tool's own heading, saying
          it is installed there is not news; saying it is also in two other
          tools is. */}
      {row.destinations.length > 1 && (
        <div className="truncate text-[10px] text-muted">
          {formatDestinations(row.destinations)}
        </div>
      )}
      {row.description && (
        <div className="truncate text-[10px] text-muted">{row.description}</div>
      )}
      {row.projectName && (
        <div className="truncate text-[10px] text-muted">in {row.projectName}</div>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <LinkButton onClick={onReveal} title={word.label} ariaLabel={`${word.label}: ${row.label}`}>
          {word.label}
        </LinkButton>
        {updatable && (
          <LinkButton
            tone="blue"
            onClick={onUpdate}
            disabled={busy}
            ariaLabel={`Update ${row.label}`}
          >
            {busy ? "Updating…" : "Update"}
          </LinkButton>
        )}
        {/* Deleting a folder is not the same kind of thing as opening one, so
            it does not sit in the same run of links. */}
        {skill?.installedByMarkie && (
          <span className="ml-auto flex items-center gap-2 border-l border-border/70 pl-2">
            <LinkButton
              tone="red"
              onClick={onRemove}
              disabled={busy}
              title={confirming ? `Deletes ${row.key}` : undefined}
              ariaLabel={confirming ? `Confirm removing ${row.label}` : `Remove ${row.label}`}
            >
              {busy ? "Removing…" : confirming ? "Yes, remove" : "Remove"}
            </LinkButton>
            {confirming && <LinkButton onClick={onCancel}>Cancel</LinkButton>}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Discover ──

function DiscoverTab({ api, onReindex }: { api: ElectronAPI; onReindex: () => void }) {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  // A resolved catalog id, or an id of null when a skills.sh hit could not be
  // matched to anything in the source's catalog. Both open the detail pane;
  // only one of them has a document to show.
  const [selected, setSelected] = useState<{
    id: string | null;
    name: string;
    source: string;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [sourceInput, setSourceInput] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((next: Catalog | undefined | null) => {
    if (!mounted.current) return;
    // Every failure answers the declared shape with empty lists, so there is
    // no error field to read here: a source that could not be fetched carries
    // its own message, and that is drawn on its chip.
    if (next && Array.isArray(next.sources) && Array.isArray(next.skills)) setCatalog(next);
  }, []);

  useEffect(() => {
    if (!api.skillsCatalogList) {
      setLoading(false);
      return;
    }
    api.skillsCatalogList()
      .then(async (first) => {
        apply(first);
        // Nothing cached yet: the catch-up refresh is what turns a first open
        // into a list instead of an empty panel. It only fetches sources that
        // are missing or a day old, so opening the tab again is free.
        if (first && Array.isArray(first.skills) && first.skills.length === 0 && api.skillsCatalogRefresh) {
          setRefreshing(true);
          apply(await api.skillsCatalogRefresh());
          if (mounted.current) setRefreshing(false);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted.current) {
          setLoading(false);
          setNow(Date.now());
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "checked 40 min ago" has to keep being true while the panel sits open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // skills.sh widens the search past what is downloaded. It answers `[]` for
  // "nothing matched" and for "the site is down" alike, so a failure here is
  // simply the absence of the group.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !api.skillsSearch) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.skillsSearch!(q)
        .then((found) => {
          if (alive) setHits(Array.isArray(found) ? found : []);
        })
        .catch(() => {
          if (alive) setHits([]);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, api]);

  const refresh = () => {
    if (!api.skillsCatalogRefresh) return;
    setRefreshing(true);
    api.skillsCatalogRefresh()
      .then(apply)
      .catch(() => {})
      .finally(() => {
        if (!mounted.current) return;
        setRefreshing(false);
        setNow(Date.now());
      });
  };

  const addSource = () => {
    const message = ownerRepoError(sourceInput);
    if (message) {
      setSourceError(message);
      return;
    }
    if (!api.skillsCatalogAddSource) return;
    setSourceError(null);
    setRefreshing(true);
    api.skillsCatalogAddSource(sourceInput.trim())
      .then((next) => {
        apply(next);
        if (!mounted.current) return;
        setSourceInput("");
        setAdding(false);
      })
      .catch(() => {})
      .finally(() => {
        if (!mounted.current) return;
        setRefreshing(false);
        setNow(Date.now());
      });
  };

  const removeSource = (id: string) => {
    if (!api.skillsCatalogRemoveSource) return;
    setRefreshing(true);
    api.skillsCatalogRemoveSource(id)
      .then(apply)
      .catch(() => {})
      .finally(() => {
        if (mounted.current) setRefreshing(false);
      });
  };

  // A hit's id is not a catalog id. skills.sh calls the pdf skill
  // `anthropics/skills/pdf`; discovery finds it inside that repository's
  // `skills/` container and calls it `anthropics/skills/skills/pdf`. Passing
  // the hit's id straight into the catalog opened an empty detail and made the
  // install fail, for the default source and every other container-based
  // repository. So the hit is matched against the catalog it belongs to, and
  // when that catalog had to be fetched first, against the one that came back.
  //
  // A chip is not a catalog, either. After a partial refresh a built-in source
  // keeps its chip whether or not its download succeeded, so "is it a source"
  // was the wrong question: a source is loaded when its catalog is here
  // (fetched, and the fetch did not fail). One that is not gets fetched by
  // name before the hit is resolved, the way an unknown one is added first.
  const openHit = (hit: SearchHit) => {
    const open = (skills: CatalogSkill[]) => {
      const found = resolveHit(hit, skills);
      setSelected({
        id: found?.id ?? null,
        name: found?.name ?? hit.name,
        source: hit.source,
      });
    };
    const source = catalog.sources.find((s) => s.id === hit.source);
    const loaded = !!source && !!source.fetchedAt && !source.error;
    // What is here already answers, whatever the last fetch said about it.
    if (loaded || resolveHit(hit, catalog.skills)) {
      open(catalog.skills);
      return;
    }
    // A repository has to be a source before its skills can be read, and
    // adding one is also what fetches it.
    const fetched = source
      ? api.skillsCatalogRefresh?.(hit.source)
      : api.skillsCatalogAddSource?.(hit.source);
    if (!fetched) {
      open(catalog.skills);
      return;
    }
    setRefreshing(true);
    fetched
      .then((next) => {
        apply(next);
        if (!mounted.current) return;
        open(next?.skills ?? []);
      })
      .catch(() => {
        if (mounted.current) setSelected({ id: null, name: hit.name, source: hit.source });
      })
      .finally(() => {
        if (mounted.current) setRefreshing(false);
      });
  };

  const shown = useMemo(
    () => catalog.skills.filter((s) => matchesSkill(s, query)),
    [catalog.skills, query]
  );

  // A hit that resolves to a row already on screen is that row. Comparing
  // ids drew `anthropics/skills/pdf` under the loaded
  // `anthropics/skills/skills/pdf`, which is the same skill twice.
  const extraHits = useMemo(
    () => hits.filter((hit) => !resolveHit(hit, shown)),
    [hits, shown]
  );

  const checked = describeChecked(newestFetchedAt(catalog.sources), now);

  if (selected) {
    return (
      <SkillDetail
        api={api}
        id={selected.id}
        fallbackName={selected.name}
        fallbackSource={selected.source}
        skill={catalog.skills.find((s) => s.id === selected.id) ?? null}
        onBack={() => setSelected(null)}
        onInstalled={() => {
          onReindex();
          api.skillsCatalogList?.().then(apply).catch(() => {});
        }}
      />
    );
  }

  return (
    <>
      <div className={`${EDGE} py-1.5 border-b border-border shrink-0 flex flex-col gap-1.5`}>
        <div className={SECTION_LABEL}>Sources</div>
        <div className="flex flex-wrap items-center gap-1">
          {catalog.sources.map((source) => (
            <span
              key={source.id}
              title={source.error ?? source.id}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] ${
                source.error
                  ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
                  : "border-border/70 text-muted"
              }`}
            >
              {source.id}
              {!source.builtin && (
                <button
                  type="button"
                  aria-label={`Remove ${source.id}`}
                  onClick={() => removeSource(source.id)}
                  className={`text-muted hover:text-foreground ${FOCUS_RING}`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              setAdding((v) => !v);
              setSourceError(null);
            }}
            aria-expanded={adding}
            title="Add a GitHub repository as a source"
            className={`rounded border border-border px-1.5 py-px text-[10px] text-foreground/80 hover:bg-accent/40 hover:text-foreground ${FOCUS_RING}`}
          >
            + repository
          </button>
        </div>

        {adding && (
          <div className="flex items-center gap-1">
            <input
              value={sourceInput}
              autoFocus
              onChange={(e) => {
                setSourceInput(e.target.value);
                setSourceError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSource();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAdding(false);
                }
              }}
              placeholder="owner/repo"
              aria-label="Repository to add"
              className="flex-1 text-[11.5px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
            />
            <button
              type="button"
              onClick={addSource}
              className={`rounded-md px-2 py-1 text-[11px] bg-accent text-foreground ${FOCUS_RING}`}
            >
              Add
            </button>
          </div>
        )}
        {sourceError && (
          <div role="alert" className="text-[10.5px] text-[var(--status-red)]">
            {sourceError}
          </div>
        )}
        {catalog.sources
          .filter((s) => s.error)
          .map((s) => (
            <div key={`${s.id}-error`} className="text-[10.5px] text-[var(--status-yellow)]">
              {s.id}: {s.error}
            </div>
          ))}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search skills…"
          aria-label="Search skills"
          className="w-full text-[12px] bg-background border border-border rounded-md px-2 py-1 text-foreground outline-none focus:border-foreground/40"
        />

        <div className="flex items-center gap-2 text-[10.5px] text-muted">
          <span>{refreshing ? "Updating the catalog…" : (checked ?? "Catalog not fetched yet")}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className={`rounded px-1.5 py-0.5 text-muted hover:text-foreground disabled:opacity-50 ${FOCUS_RING}`}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className={`${EDGE} py-4 text-[12px] text-muted`}>Reading the catalog…</div>
        ) : shown.length === 0 && extraHits.length === 0 ? (
          <div className={`${EDGE} py-4 text-[12px] text-muted leading-relaxed`}>
            {query
              ? // skills.sh answers an empty list for "nothing matched" and for
                // "the site is down" alike, so this has to read sensibly either
                // way: it says what to do next rather than what was searched.
                "Nothing matches that. Try another word, or add the repository it lives in."
              : refreshing
                ? "Getting the catalog…"
                : "No skills downloaded yet. Refresh to fetch them."}
          </div>
        ) : (
          <>
            {shown.map((skill) => (
              <CatalogRow
                key={skill.id}
                skill={skill}
                onOpen={() =>
                  setSelected({ id: skill.id, name: skill.name, source: skill.source })
                }
              />
            ))}
            {extraHits.length > 0 && (
              <>
                <div className={`${SECTION_LABEL} ${EDGE} pt-3 pb-1 border-b border-border/60`}>
                  <span>From skills.sh</span>
                  <span className="ml-1">{extraHits.length}</span>
                </div>
                {extraHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    data-skills-hit={hit.id}
                    onClick={() => openHit(hit)}
                    className={`group w-full text-left ${EDGE} py-1.5 hover:bg-accent/40 ${FOCUS_RING}`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                        {hit.name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted">
                        {hit.installs} installs
                      </span>
                      <Chevron />
                    </div>
                    <div className="truncate text-[10px] text-muted">{hit.source}</div>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** A row opens something. Without this it read as a paragraph of static text. */
function Chevron() {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 text-[11px] text-muted transition-colors group-hover:text-foreground"
    >
      ›
    </span>
  );
}

function CatalogRow({ skill, onOpen }: { skill: CatalogSkill; onOpen: () => void }) {
  // A licence name is a badge. A whole sentence about where the terms live is
  // not, and one under every row was the loudest thing in the catalog; that
  // belongs in the detail pane, once, next to the button it is about.
  const chip = licenseChip(skill.license);
  return (
    <button
      type="button"
      data-skills-row={skill.id}
      onClick={onOpen}
      className={`group w-full text-left ${EDGE} py-1.5 hover:bg-accent/40 ${FOCUS_RING}`}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{skill.name}</span>
        {typeof skill.installs === "number" && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted">
            {skill.installs} installs
          </span>
        )}
        <Chevron />
      </div>
      <div className="text-[10.5px] text-muted leading-snug line-clamp-2">{skill.description}</div>
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <span className="text-[10px] text-muted">{skill.source}</span>
        {chip && (
          <Badge title={chip === "Proprietary" ? PROPRIETARY_NOTE : (skill.license ?? undefined)}>
            {chip}
          </Badge>
        )}
        {skill.installedTo.map((entry) => (
          <Badge key={targetKey(entry.target)} tone={entry.upToDate ? "muted" : "blue"}>
            {targetLabel(entry.target)}
          </Badge>
        ))}
      </div>
    </button>
  );
}

// ── One skill, in full ──

/** What a target is currently holding, which decides how its row is drawn. */
type TargetState = "free" | "installed" | "stale";

function SkillDetail({
  api,
  id,
  fallbackName,
  fallbackSource,
  skill,
  onBack,
  onInstalled,
}: {
  api: ElectronAPI;
  /** null when a skills.sh hit could not be matched to anything in its source. */
  id: string | null;
  fallbackName: string;
  fallbackSource: string;
  skill: CatalogSkill | null;
  onBack: () => void;
  onInstalled: () => void;
}) {
  const [doc, setDoc] = useState<{ body: string; files: SkillFile[] } | null>(null);
  const [loading, setLoading] = useState(!!id);
  // What was ticked last time, read once. The tool targets are taken as they
  // were; the project one is a target only if that folder is still open, which
  // the roots effect below decides.
  const [remembered] = useState(() => {
    const list = readRememberedTargets((key) => localStorage.getItem(key));
    return {
      tools: list.filter((t): t is ToolTarget => typeof t === "string"),
      project: list.find((t): t is { project: string } => typeof t === "object")?.project ?? null,
    };
  });
  const [tools, setTools] = useState<ToolTarget[]>(remembered.tools);
  const [projectTicked, setProjectTicked] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [project, setProject] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<NonNullable<ElectronAPI["skillsInstall"]>>
  > | null>(null);

  useEffect(() => {
    if (!id) {
      setDoc(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.skillsRead?.(id)
      .then((read) => {
        if (!alive) return;
        // A failure answers `{ body: "", files: [] }`, which draws as the empty
        // state below rather than as a crash.
        setDoc(read && typeof read.body === "string" ? read : { body: "", files: [] });
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setDoc({ body: "", files: [] });
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, id]);

  useEffect(() => {
    let alive = true;
    api.wsRoots?.()
      .then((list) => {
        if (!alive) return;
        const found = Array.isArray(list) ? list : [];
        setRoots(found);
        // A remembered project counts only while that folder is still open.
        // Otherwise the tick would quietly aim at whichever workspace came
        // first in the list, which is a stale target by another route.
        const kept =
          remembered.project !== null && found.includes(remembered.project)
            ? remembered.project
            : null;
        setProject((current) => current || kept || found[0] || "");
        if (kept) setProjectTicked(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, remembered]);

  // A target already holding the current copy of this skill is not something
  // to tick; it is a fact about the target. One holding an older copy can be
  // ticked, and that is an update.
  const stateOf = useCallback(
    (target: SkillTarget): TargetState => {
      const entry = skill?.installedTo.find(
        (e) => targetKey(e.target) === targetKey(target)
      );
      if (!entry) return "free";
      return entry.upToDate ? "installed" : "stale";
    },
    [skill]
  );

  // The project target exists only while its box is ticked and a folder is
  // chosen, so there is never a second project in the list and never a stale
  // one: choosing another folder in the select changes which one it is. Keeping
  // the project inside the list instead let ticking A and then choosing B draw
  // B unticked while the install still wrote to A.
  const targets = useMemo<SkillTarget[]>(
    () => (projectTicked && project ? [...tools, { project }] : tools),
    [tools, projectTicked, project]
  );

  const remember = (nextTools: ToolTarget[], ticked: boolean, folder: string) =>
    writeRememberedTargets(
      (k, v) => localStorage.setItem(k, v),
      ticked && folder ? [...nextTools, { project: folder }] : nextTools
    );

  // A new pick starts a new outcome: the last install's report was about the
  // boxes that were ticked then.
  const toggleTool = (target: ToolTarget) => {
    const next = tools.includes(target) ? tools.filter((t) => t !== target) : [...tools, target];
    setTools(next);
    setResult(null);
    remember(next, projectTicked, project);
  };

  const toggleProject = () => {
    setProjectTicked(!projectTicked);
    setResult(null);
    remember(tools, !projectTicked, project);
  };

  const pickProject = (next: string) => {
    setProject(next);
    setResult(null);
    remember(tools, projectTicked, next);
  };

  // What the button will actually write: a target that already holds this
  // exact copy is not one of them.
  const chosen = useMemo(
    () => targets.filter((t) => stateOf(t) !== "installed"),
    [targets, stateOf]
  );

  // "Update" only when every box that counts already holds an older copy.
  // Anything else is an add.
  const isUpdate = chosen.length > 0 && chosen.every((t) => stateOf(t) === "stale");
  const landed = result?.installed ?? [];
  const failures = result?.errors ?? [];
  // Nothing to do and nothing just done: say why the button waits.
  const blockedByInstalled =
    chosen.length === 0 && landed.length === 0 && targets.some((t) => stateOf(t) === "installed");

  const install = () => {
    if (!api.skillsInstall || !id || chosen.length === 0) return;
    setRunning(true);
    setResult(null);
    api.skillsInstall(id, chosen)
      .then((res) => {
        setResult(res ?? { installed: [], errors: [] });
        onInstalled();
      })
      .catch(() => setResult({ installed: [], errors: [] }))
      .finally(() => setRunning(false));
  };

  const name = skill?.name ?? fallbackName;
  const source = skill?.source ?? fallbackSource;
  const chip = licenseChip(skill?.license);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={`${EDGE} py-1.5 border-b border-border shrink-0`}>
        <button
          type="button"
          onClick={onBack}
          className={`text-[11px] text-muted hover:text-foreground ${FOCUS_RING}`}
        >
          ‹ Back to skills
        </button>
      </div>

      {/* The identity of the thing being installed, pinned. Scrolling the
          document used to leave the pane with nothing on it but "Back". */}
      <div data-skills-identity className={`${EDGE} pt-1.5 pb-2 border-b border-border shrink-0`}>
        <div className={SECTION_LABEL}>Skill</div>
        <div className="flex items-center gap-1 pt-px">
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={name}>
            {name}
          </span>
          {chip && (
            <Badge title={chip === "Proprietary" ? PROPRIETARY_NOTE : (skill?.license ?? undefined)}>
              {chip}
            </Badge>
          )}
        </div>
        <div className="truncate text-[10.5px] text-muted" title={source}>
          {source}
        </div>
        {/* Only where there is something to install. */}
        {id && (
          <div className="pt-0.5 text-[10.5px] text-muted" title={skill?.license ?? undefined}>
            {LICENSE_NOTE}
          </div>
        )}
        {skill?.compatibility && (
          <div className="truncate pt-0.5 text-[10.5px] text-muted">
            Works with {skill.compatibility}
          </div>
        )}
        {skill?.allowedTools && (
          <div className="pt-0.5 text-[10.5px] text-muted leading-snug">
            Tools: {skill.allowedTools}
          </div>
        )}
      </div>

      {!id ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className={`${EDGE} py-3 text-[12px] text-muted leading-relaxed`}>
            skills.sh lists {name} in {source}, but Markie&apos;s copy of that
            repository has no skill by that name. Refresh the source and try again.
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className={`${SECTION_LABEL} ${EDGE} pt-2 pb-1`}>SKILL.md</div>
            <div
              data-skills-preview
              className="border-y border-border/60 h-[38vh] min-h-[140px]"
              style={{ "--doc-font-size": "12.5px" } as CSSProperties}
            >
              {loading ? (
                <div className={`${EDGE} py-3 text-[12px] text-muted`}>Reading SKILL.md…</div>
              ) : doc && doc.body ? (
                <RichView value={doc.body} onChange={() => {}} readOnly />
              ) : (
                <div className={`${EDGE} py-3 text-[12px] text-muted`}>
                  Markie couldn&apos;t read this skill&apos;s SKILL.md. Refresh its source and try
                  again.
                </div>
              )}
            </div>

            {doc && doc.files.length > 0 && (
              <div className={`${EDGE} py-2`}>
                <div className={`${SECTION_LABEL} pb-1`}>
                  Files
                  <span className="ml-1">{doc.files.length}</span>
                </div>
                {doc.files.map((file) => (
                  <div key={file.path} className="flex items-center gap-2 py-px">
                    <span
                      className="min-w-0 flex-1 truncate text-[10.5px] text-muted"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted">
                      {formatSize(file.size)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* The reason for opening this pane, kept where it can be reached
              without reading the whole document first. */}
          <div
            data-skills-install
            className="shrink-0 border-t border-border bg-surface"
          >
            <div className={`max-h-[42vh] overflow-y-auto ${EDGE} pt-2`}>
              <div className={`${SECTION_LABEL} pb-1`}>Add to</div>
              {TOOL_TARGETS.map((target) => (
                <TargetRow
                  key={targetKey(target)}
                  label={targetLabel(target)}
                  hint={target === "universal" ? UNIVERSAL_HINT : undefined}
                  state={stateOf(target)}
                  checked={tools.includes(target)}
                  onChange={() => toggleTool(target)}
                />
              ))}
              {roots.length > 0 && (
                <TargetRow
                  label="Project"
                  hint={PROJECT_HINT}
                  state={stateOf({ project })}
                  checked={projectTicked}
                  disabled={!project}
                  onChange={toggleProject}
                  trailing={
                    <select
                      aria-label="Project folder"
                      value={project}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => pickProject(e.target.value)}
                      className="min-w-0 max-w-[55%] flex-1 rounded-md border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
                    >
                      {roots.map((root) => (
                        <option key={root} value={root}>
                          {targetLabel({ project: root })}
                        </option>
                      ))}
                    </select>
                  }
                />
              )}
            </div>

            <div className={`${EDGE} py-2`}>
              <button
                type="button"
                onClick={install}
                disabled={running || chosen.length === 0}
                className={`w-full rounded-md border px-2 py-1.5 text-[12px] transition-opacity ${FOCUS_RING} ${
                  running || chosen.length === 0
                    ? "border-border bg-transparent text-muted opacity-60"
                    : "border-foreground/30 bg-accent font-medium text-foreground hover:opacity-90"
                }`}
              >
                {running ? "Working…" : installLabel(chosen, isUpdate)}
              </button>

              {blockedByInstalled && (
                <div className="pt-1 text-[10.5px] text-muted">
                  Everything you picked already has the current copy.
                </div>
              )}
              {/* What landed is reported even when something else did not:
                  one target failing is no reason to hide the other's copy. */}
              {landed.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 pt-2">
                  <span className="text-[10.5px] text-[var(--status-green)]">Added to</span>
                  {landed.map((entry) => (
                    <Badge key={targetKey(entry.target)}>{targetLabel(entry.target)}</Badge>
                  ))}
                </div>
              )}
              {failures.map((entry) => (
                <div
                  key={targetKey(entry.target)}
                  role="alert"
                  className="pt-1 text-[10.5px] leading-snug text-[var(--status-red)]"
                >
                  {entry.message}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One place a skill can go. A target already holding the current copy says so
 * and cannot be picked; one holding an older copy can be, and that is an
 * update. Everything else is an ordinary checkbox.
 */
function TargetRow({
  label,
  hint,
  state,
  checked,
  disabled,
  onChange,
  trailing,
}: {
  label: string;
  hint?: string;
  state: TargetState;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  trailing?: ReactNode;
}) {
  const settled = state === "installed";
  return (
    <div className="py-px">
      <label
        className={`flex items-center gap-1.5 text-[11.5px] ${
          settled ? "text-muted" : "cursor-pointer select-none text-foreground/90"
        }`}
      >
        <input
          type="checkbox"
          aria-label={label}
          checked={settled || checked}
          disabled={settled || disabled}
          onChange={onChange}
          className="accent-current"
        />
        <span className="shrink-0">{label}</span>
        {settled && <Badge>Installed</Badge>}
        {state === "stale" && <Badge tone="blue">Update ready</Badge>}
        {trailing}
      </label>
      {hint && <div className="pl-[22px] text-[10px] leading-snug text-muted">{hint}</div>}
    </div>
  );
}
