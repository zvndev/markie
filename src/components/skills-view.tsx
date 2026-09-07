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
  SKILLS_KIND_OPEN,
  SKILLS_KIND_ORDER,
  SKILLS_TAB_KEY,
  SKILL_GROUPS,
  describeChecked,
  formatSize,
  groupForTarget,
  initialSkillsTab,
  licenseBadge,
  matchesSkill,
  newestFetchedAt,
  ownerRepoError,
  readRememberedTargets,
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

// The five targets a skill can be added to, in the order the detail pane and
// the Installed groups both use.
const TOOL_TARGETS: SkillTarget[] = ["claude", "codex", "cursor", "gemini", "universal"];

const KIND_LABEL = new Map(AGENT_KINDS.map((k) => [k.id, k.label]));

const EMPTY_CATALOG: Catalog = { sources: [], skills: [] };

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference that will not save is not worth a broken panel */
  }
}

/** Trailing slashes and Windows separators folded, so one folder is one key. */
function folderKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The SKILL.md inside a folder, spelled with the folder's own separator. */
function skillMdIn(folder: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}SKILL.md`;
}

function revealWord(platform: string): { text: string; label: string } {
  if (platform === "win32") return { text: "Explorer", label: "Show in Explorer" };
  if (platform === "darwin") return { text: "Finder", label: "Show in Finder" };
  return { text: "Files", label: "Show in your file manager" };
}

// ── Small shared pieces ──

function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "blue" | "yellow";
}) {
  const colors =
    tone === "blue"
      ? "border-[color:var(--status-blue)] text-[var(--status-blue)]"
      : tone === "yellow"
        ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
        : "border-border/70 text-muted";
  return (
    <span className={`shrink-0 rounded border px-1 py-px text-[9px] ${colors}`}>{children}</span>
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
        className="flex items-center gap-0.5 px-2 py-1.5 shrink-0 border-b border-border/60"
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
          onOpenPath={onOpenPath}
          activePath={activePath}
        />
      ) : (
        <DiscoverTab api={api} />
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
  contains: number;
  description: string | null;
  installed: InstalledSkill | null;
  projectName: string | null;
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
      for (const entry of skill.installedTo) out.set(folderKey(entry.path), skill);
    }
    return out;
  }, [catalog]);

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
      for (const { file, label, contains } of collapseSkills(files)) {
        const key = folderKey(skillRootOf(file.path) ?? file.dir);
        byKey.set(key, {
          key,
          group,
          label,
          openPath: file.path,
          contains,
          description: null,
          installed: null,
          projectName: null,
        });
      }
    }
    for (const row of installed) {
      const key = folderKey(row.path);
      const existing = byKey.get(key);
      const projectName = typeof row.target === "object" ? targetLabel(row.target) : null;
      if (existing) {
        existing.installed = row;
        existing.description = row.description;
        existing.projectName = projectName;
        // The recorded target beats the path: Claude Code and Codex both let
        // the user move their config folder, and then the path says nothing.
        existing.group = groupForTarget(row.target);
      } else {
        byKey.set(key, {
          key,
          group: groupForTarget(row.target),
          label: row.name,
          openPath: skillMdIn(row.path),
          contains: 1,
          description: row.description,
          installed: row,
          projectName,
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
  }, [rows, installed, filter]);

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
      .then(() => loadInstalled())
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
      <div className="px-2 py-1.5 flex items-center gap-1.5 border-b border-border shrink-0">
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
          className="px-3 py-1.5 text-[11px] text-[var(--status-red)] border-b border-border shrink-0"
        >
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-[12px] text-[var(--status-red)]">
            {error}{" "}
            <button onClick={onRetry} className="underline hover:no-underline">
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="p-4 text-[12px] text-muted">Looking for agent files…</div>
        ) : total === 0 ? (
          <div className="p-4 text-[12px] text-muted leading-relaxed">
            No agent files found{filter ? " for this filter" : ""}. Markie looks for
            CLAUDE.md, AGENTS.md, GEMINI.md, and the skills folders of Claude Code,
            Codex, Cursor, Gemini and <code>~/.agents</code>.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.tool.id}>
              <div
                data-skills-group={g.tool.id}
                className="text-[9px] uppercase tracking-wide text-muted px-2 pt-3 pb-1 border-b border-border/60 sticky top-0 bg-surface"
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
                      className={`w-full text-left text-[10px] text-muted/80 px-2 pt-2 pb-0.5 flex items-center gap-1 hover:text-foreground ${FOCUS_RING}`}
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
      data-skill-row={row.key}
      onClick={onOpen}
      title={row.key}
      className={`pl-4 pr-2 py-1 cursor-pointer hover:bg-accent/30 ${
        active ? "bg-accent/40" : ""
      }`}
    >
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          <span>{row.label}</span>
          {row.contains > 1 && (
            <span className="ml-1 text-[9px] text-muted">+{row.contains - 1}</span>
          )}
        </div>
        {updatable ? (
          <Badge tone="blue">update available</Badge>
        ) : skill?.source ? (
          <Badge>from {skill.source}</Badge>
        ) : null}
        <Star on={starred} onClick={onStar} />
      </div>
      {row.description && (
        <div className="truncate text-[10px] text-muted">{row.description}</div>
      )}
      {row.projectName && (
        <div className="truncate text-[10px] text-muted">in {row.projectName}</div>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <LinkButton onClick={onReveal} title={word.label} ariaLabel={`${word.label}: ${row.label}`}>
          {word.text}
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
        {skill?.installedByMarkie && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// ── Discover ──

function DiscoverTab({ api }: { api: ElectronAPI }) {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
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

  const openHit = (hit: SearchHit) => {
    const known = catalog.sources.some((s) => s.id === hit.source);
    if (known || !api.skillsCatalogAddSource) {
      setSelected({ id: hit.id, name: hit.name });
      return;
    }
    // A repository has to be a source before its skills can be read, and
    // adding one is also what fetches it.
    setRefreshing(true);
    api.skillsCatalogAddSource(hit.source)
      .then(apply)
      .catch(() => {})
      .finally(() => {
        if (!mounted.current) return;
        setRefreshing(false);
        setSelected({ id: hit.id, name: hit.name });
      });
  };

  const shown = useMemo(
    () => catalog.skills.filter((s) => matchesSkill(s, query)),
    [catalog.skills, query]
  );

  const extraHits = useMemo(() => {
    const local = new Set(shown.map((s) => s.id));
    return hits.filter((h) => !local.has(h.id));
  }, [hits, shown]);

  const checked = describeChecked(newestFetchedAt(catalog.sources), now);

  if (selected) {
    return (
      <SkillDetail
        api={api}
        id={selected.id}
        fallbackName={selected.name}
        skill={catalog.skills.find((s) => s.id === selected.id) ?? null}
        onBack={() => setSelected(null)}
        onInstalled={() => api.skillsCatalogList?.().then(apply).catch(() => {})}
      />
    );
  }

  return (
    <>
      <div className="px-2 py-1.5 border-b border-border shrink-0 flex flex-col gap-1.5">
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
            className={`rounded border border-dashed border-border/70 px-1.5 py-px text-[10px] text-muted hover:text-foreground ${FOCUS_RING}`}
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
          <span>{refreshing ? "Checking…" : (checked ?? "not checked yet")}</span>
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
          <div className="p-4 text-[12px] text-muted">Reading the catalog…</div>
        ) : shown.length === 0 && extraHits.length === 0 ? (
          <div className="p-4 text-[12px] text-muted leading-relaxed">
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
                onOpen={() => setSelected({ id: skill.id, name: skill.name })}
              />
            ))}
            {extraHits.length > 0 && (
              <>
                <div className="text-[9px] uppercase tracking-wide text-muted px-2 pt-3 pb-1 border-b border-border/60">
                  <span>From skills.sh</span>
                  <span className="ml-1">{extraHits.length}</span>
                </div>
                {extraHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    data-skills-hit={hit.id}
                    onClick={() => openHit(hit)}
                    className={`w-full text-left px-2 py-1.5 hover:bg-accent/30 ${FOCUS_RING}`}
                  >
                    <div className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                        {hit.name}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted">
                        {hit.installs} installs
                      </span>
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

function CatalogRow({ skill, onOpen }: { skill: CatalogSkill; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-skills-row={skill.id}
      onClick={onOpen}
      className={`w-full text-left px-2 py-1.5 hover:bg-accent/30 ${FOCUS_RING}`}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{skill.name}</span>
        {typeof skill.installs === "number" && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted">
            {skill.installs} installs
          </span>
        )}
      </div>
      <div className="text-[10.5px] text-muted leading-snug line-clamp-2">{skill.description}</div>
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <span className="text-[10px] text-muted">{skill.source}</span>
        <Badge>{licenseBadge(skill.license)}</Badge>
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

function SkillDetail({
  api,
  id,
  fallbackName,
  skill,
  onBack,
  onInstalled,
}: {
  api: ElectronAPI;
  id: string;
  fallbackName: string;
  skill: CatalogSkill | null;
  onBack: () => void;
  onInstalled: () => void;
}) {
  const [doc, setDoc] = useState<{ body: string; files: SkillFile[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [targets, setTargets] = useState<SkillTarget[]>(() =>
    readRememberedTargets((key) => localStorage.getItem(key))
  );
  const [roots, setRoots] = useState<string[]>([]);
  const [project, setProject] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<NonNullable<ElectronAPI["skillsInstall"]>>
  > | null>(null);

  useEffect(() => {
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
        setProject((current) => current || found[0] || "");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const chosen = useMemo(() => {
    // A project checkbox with no project selected is not a target.
    return targets.filter((t) => typeof t === "string" || t.project);
  }, [targets]);

  const has = (target: SkillTarget) =>
    targets.some((t) => targetKey(t) === targetKey(target));

  const toggle = (target: SkillTarget) => {
    setTargets((current) => {
      const key = targetKey(target);
      const next = current.some((t) => targetKey(t) === key)
        ? current.filter((t) => targetKey(t) !== key)
        : [...current, target];
      writeRememberedTargets((k, v) => localStorage.setItem(k, v), next);
      return next;
    });
  };

  // "Update" only when every box that is ticked already holds this skill and
  // holds an older copy of it. Anything else is an add, even when one of the
  // targets happens to be up to date.
  const isUpdate =
    chosen.length > 0 &&
    !!skill &&
    chosen.every((target) =>
      skill.installedTo.some(
        (entry) => targetKey(entry.target) === targetKey(target) && !entry.upToDate
      )
    );

  const install = () => {
    if (!api.skillsInstall || chosen.length === 0) return;
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

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border shrink-0">
        <button
          type="button"
          onClick={onBack}
          className={`text-[11px] text-muted hover:text-foreground ${FOCUS_RING}`}
        >
          ‹ Back to skills
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 pt-2 pb-1">
          <div className="text-[13px] text-foreground">{name}</div>
          <div className="text-[10.5px] text-muted">{skill?.source ?? id}</div>
          <div className="flex flex-wrap items-center gap-1 pt-1">
            <Badge>{licenseBadge(skill?.license)}</Badge>
            {skill?.compatibility && <Badge>{skill.compatibility}</Badge>}
          </div>
          {skill?.allowedTools && (
            <div className="pt-1 text-[10.5px] text-muted leading-snug">
              Tools: {skill.allowedTools}
            </div>
          )}
        </div>

        <div
          data-skills-preview
          className="border-y border-border/60 px-1 h-[45vh] min-h-[160px]"
          style={{ "--doc-font-size": "12.5px" } as CSSProperties}
        >
          {loading ? (
            <div className="p-3 text-[12px] text-muted">Reading SKILL.md…</div>
          ) : doc && doc.body ? (
            <RichView value={doc.body} onChange={() => {}} readOnly />
          ) : (
            <div className="p-3 text-[12px] text-muted">
              Markie couldn&apos;t read this skill&apos;s SKILL.md. Refresh its source and try again.
            </div>
          )}
        </div>

        {doc && doc.files.length > 0 && (
          <div className="px-3 py-2">
            <div className="text-[9px] uppercase tracking-wide text-muted pb-1">
              Files
              <span className="ml-1">{doc.files.length}</span>
            </div>
            {doc.files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 py-px">
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted">
                  {formatSize(file.size)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="px-3 py-2 border-t border-border/60">
          <div className="text-[9px] uppercase tracking-wide text-muted pb-1">Add to…</div>
          {TOOL_TARGETS.map((target) => (
            <label
              key={targetKey(target)}
              className="flex items-center gap-1.5 py-px text-[11.5px] text-foreground/90"
            >
              <input
                type="checkbox"
                checked={has(target)}
                onChange={() => toggle(target)}
                className="accent-[color:var(--status-blue)]"
              />
              {targetLabel(target)}
            </label>
          ))}
          {roots.length > 0 && (
            <div className="flex items-center gap-1.5 py-px text-[11.5px] text-foreground/90">
              <input
                type="checkbox"
                aria-label="Project"
                checked={has({ project })}
                disabled={!project}
                onChange={() => toggle({ project })}
                className="accent-[color:var(--status-blue)]"
              />
              <span>Project</span>
              <select
                aria-label="Project folder"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="min-w-0 flex-1 text-[11px] bg-background border border-border rounded-md px-1 py-0.5 text-foreground"
              >
                {roots.map((root) => (
                  <option key={root} value={root}>
                    {targetLabel({ project: root })}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={install}
            disabled={running || chosen.length === 0}
            className={`mt-2 w-full rounded-md bg-accent px-2 py-1.5 text-[12px] text-foreground disabled:opacity-50 ${FOCUS_RING}`}
          >
            {running ? "Working…" : isUpdate ? "Update" : "Add skill"}
          </button>

          {result && result.installed.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-2">
              <span className="text-[10.5px] text-muted">Added to</span>
              {result.installed.map((entry) => (
                <Badge key={targetKey(entry.target)}>{targetLabel(entry.target)}</Badge>
              ))}
            </div>
          )}
          {result?.errors.map((entry) => (
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
    </div>
  );
}
