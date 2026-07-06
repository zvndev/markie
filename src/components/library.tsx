"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";
import { getElectronAPI, type LibraryItem } from "@/lib/electron";
import { FilesView } from "@/components/files-view";
import { BrowseView } from "@/components/browse-view";
import { SkillsView } from "@/components/skills-view";
import { SharedView } from "@/components/shared-view";
import type { LeftView } from "@/components/activity-bar";
import { readLibraryStartupSnapshot } from "@/lib/library-startup";
import {
  libraryItemNeedsAttention,
  organizeLibraryItems,
  summarizeLibrary,
  type LibraryOverview,
} from "@/lib/library-overview";
import type { WorkspaceBootstrapResult } from "@/lib/workspace-default";

interface LibraryProps {
  // which view the left rail selected (library | browse | shared | skills)
  view: LeftView;
  onClose: () => void;
  onOpenPath: (path: string) => void;
  onOpenFile: () => void;
  onAddPaths: (paths: string[]) => void;
  onSignIn: () => void;
  // open the share dialog to manage people on a doc I own
  onManageShare: (docId: string, name: string) => void;
  activePath: string | null;
  // bump to force a refresh (file opened/saved/sync changed)
  refreshKey: number;
}

const OPENABLE = /\.(md|markdown|mdx|txt|csv)$/i;
const TAB_KEY = "markie.libtab.v1";

// The "Library" view has a Recent/Files sub-toggle; the other views come from
// the left rail and have no sub-tabs.
type LibTab = "recent" | "files";

const VIEW_TITLE: Record<LeftView, string> = {
  library: "Library",
  browse: "Browse",
  shared: "Shared",
  skills: "Skills",
};

const BADGE: Record<LibraryItem["state"], [string, string]> = {
  "local-only": ["Local", "text-muted border-border"],
  synced: [
    "Synced",
    "text-[var(--status-green)] border-[color:var(--status-green)]",
  ],
  paused: [
    "Paused",
    "text-[var(--status-yellow)] border-[color:var(--status-yellow)]",
  ],
  conflict: [
    "Conflict",
    "text-[var(--status-red)] border-[color:var(--status-red)]",
  ],
  behind: [
    "Update",
    "text-[var(--status-blue)] border-[color:var(--status-blue)]",
  ],
  "cloud-only": [
    "Cloud",
    "text-[var(--status-blue)] border-[color:var(--status-blue)]",
  ],
};

export function Library({
  view,
  onClose,
  onOpenPath,
  onOpenFile,
  onAddPaths,
  onSignIn,
  onManageShare,
  activePath,
  refreshKey,
}: LibraryProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  // only "loading" when there's actually a main-process library to query
  const [loading, setLoading] = useState(
    () => !!getElectronAPI()?.libraryState
  );
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceBootstrapResult | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [libTab, setLibTab] = useState<LibTab>(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "files" ? "files" : "recent";
    } catch {
      return "recent";
    }
  });
  const pickTab = (t: LibTab) => {
    setLibTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // storage unavailable
    }
  };
  const [defaultMsg, setDefaultMsg] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState(false);
  // null = unknown/checking; show the prompt only when we know it's NOT default.
  // No status API (web/dev) → never show, decided up front to avoid set-in-effect.
  const [needsDefault, setNeedsDefault] = useState<boolean | null>(() =>
    getElectronAPI()?.defaultMarkdownStatus ? null : false
  );

  // Ask the system whether Markie already owns .md, so we don't nag every open.
  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.defaultMarkdownStatus) return;
    let alive = true;
    api.defaultMarkdownStatus().then((s) => {
      if (alive) setNeedsDefault(s.supported && !s.isDefault);
    });
    return () => {
      alive = false;
    };
  }, []);

  const makeDefault = async () => {
    const api = getElectronAPI();
    if (!api?.setDefaultMarkdownApp) return;
    setSettingDefault(true);
    setDefaultMsg(null);
    const res = await api.setDefaultMarkdownApp();
    setSettingDefault(false);
    if (res.ok) {
      setDefaultMsg("Markie now opens .md files.");
      setNeedsDefault(false); // hide the prompt — it's set now
    } else {
      setDefaultMsg(res.error ?? "Couldn't set default.");
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const api = getElectronAPI();
    if (!api?.pathForFile) {
      setNotice("Drag-and-drop needs the desktop app.");
      return;
    }
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => api.pathForFile(f))
      .filter((p): p is string => !!p && OPENABLE.test(p));
    if (paths.length === 0) {
      setNotice("Drop Markdown, text, or CSV files here.");
      return;
    }
    onAddPaths(paths);
  };

  const refresh = useCallback(() => {
    const api = getElectronAPI();
    if (!api?.libraryState) return Promise.resolve();
    return readLibraryStartupSnapshot(api).then((s) => {
      setItems(s.items);
      setSignedIn(s.signedIn);
      setWorkspace(s.workspace);
      setLoading(false);
      if (s.error) setNotice(s.error);
    });
  }, []);

  useEffect(() => {
    const api = getElectronAPI();
    if (!api?.libraryState) return;
    let alive = true;
    readLibraryStartupSnapshot(api).then((s) => {
      if (!alive) return;
      setItems(s.items);
      setSignedIn(s.signedIn);
      setWorkspace(s.workspace);
      setLoading(false);
      if (s.error) setNotice(s.error);
    });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    setMenuFor(null);
    refresh();
  };

  const flash = (msg: string) => {
    setNotice(msg);
    setMenuFor(null);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      flash("Path copied — paste it anywhere.");
    } catch {
      flash("Couldn't copy the path.");
    }
  };

  const copyContents = async (item: LibraryItem) => {
    const api = getElectronAPI();
    if (!item.path || !api?.openFilePath) return flash("Nothing to copy.");
    const file = await api.openFilePath(item.path);
    if (!file) return flash(`Couldn't read ${item.name}.`);
    try {
      await navigator.clipboard.writeText(file.content);
      flash("Contents copied to clipboard.");
    } catch {
      flash("Couldn't copy the contents.");
    }
  };

  const syncOn = (item: LibraryItem) =>
    act(async () => {
      const api = getElectronAPI()!;
      const file = await api.openFilePath(item.path!);
      if (!file) return setNotice(`Can't read ${item.name}`);
      const res = await api.docSyncOn({
        path: item.path!,
        name: item.name,
        content: file.content,
      });
      if (res.error) setNotice(res.error);
    });

  const { localFiles, myCloudOnly, sharedItems, sharedCloudOnly } =
    organizeLibraryItems(items);
  const overview = summarizeLibrary(items);

  const fileRow = (item: LibraryItem) => {
    const [label, badgeClass]: [string, string] = item.shared
      ? [
          "Shared",
          "text-[var(--status-purple)] border-[color:var(--status-purple)]",
        ]
      : BADGE[item.state];
    const api = getElectronAPI()!;
    const isActive = activePath && item.path === activePath;
    const open = () => {
      if (item.path && item.exists) {
        onOpenPath(item.path);
      } else if (item.shared && item.cloudId && api.docOpenShared) {
        // shared with me → just save to Downloads and open it, no save dialog
        act(() => api.docOpenShared!({ cloudId: item.cloudId!, suggestedName: item.name }));
      } else if (item.state === "cloud-only" && item.cloudId) {
        act(() => api.docPull({ cloudId: item.cloudId!, suggestedName: item.name }));
      }
    };
    return (
      <div
        key={item.path ?? item.cloudId}
        className={`group rounded-md px-2 py-1.5 cursor-pointer ${
          isActive ? "bg-accent" : "hover:bg-accent/40"
        }`}
        onClick={open}
      >
        <div className="flex items-center gap-1.5">
          <FileIcon />
          <span className="text-[12.5px] text-foreground truncate flex-1" title={item.path ?? item.name}>
            {item.name}
          </span>
          <span className={`text-[9px] px-1 py-px rounded border shrink-0 ${badgeClass}`}>
            {label}
          </span>
          {(item.path || item.cloudId) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuFor(menuFor === (item.path ?? item.cloudId) ? null : item.path ?? item.cloudId);
              }}
              className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted hover:text-foreground hover:bg-accent/40 shrink-0 transition"
              aria-label="Actions"
            >
              ⋯
            </button>
          )}
        </div>
        {item.path && !item.exists && (
          <div className="text-[10px] text-[var(--status-red)] pl-5">Missing on disk</div>
        )}
        {item.shared && (item.sharedBy || item.role) && (
          <div className="text-[10px] text-muted pl-5 truncate">
            {item.sharedBy ? `Shared by ${item.sharedBy}` : "Shared with you"}
            {item.role ? ` · ${item.role === "editor" ? "Editor" : "Viewer"}` : ""}
          </div>
        )}

        {menuFor === (item.path ?? item.cloudId) && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pl-5 pt-1.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
            {item.path && (
              <button className="text-muted hover:text-foreground" onClick={() => copyPath(item.path!)}>Copy path</button>
            )}
            {item.path && item.exists && (
              <button className="text-muted hover:text-foreground" onClick={() => copyContents(item)}>Copy contents</button>
            )}
            {signedIn && item.state === "local-only" && item.exists && (
              <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>Sync to cloud</button>
            )}
            {signedIn && item.state === "paused" && item.exists && (
              <button className="text-muted hover:text-foreground" onClick={() => syncOn(item)}>Resume sync</button>
            )}
            {signedIn && item.state === "synced" && (
              <button className="text-muted hover:text-foreground" onClick={() => setConfirmOff(item.path)}>Stop syncing</button>
            )}
            {signedIn && item.state === "behind" && (
              <button className="text-[var(--status-blue)] hover:underline" onClick={() => act(() => api.docResolve({ path: item.path!, strategy: "cloud" }))}>Pull latest</button>
            )}
            {signedIn && item.state === "conflict" && (
              <>
                <button className="text-muted hover:text-foreground" onClick={() => act(() => api.docResolve({ path: item.path!, strategy: "local" }))}>Keep local</button>
                <button className="text-muted hover:text-foreground" onClick={() => act(() => api.docResolve({ path: item.path!, strategy: "cloud" }))}>Take cloud</button>
              </>
            )}
            {item.state === "cloud-only" && signedIn && (
              <button className="text-[var(--status-blue)] hover:underline" onClick={() => act(() => api.docPull({ cloudId: item.cloudId!, suggestedName: item.name }))}>Download…</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`markie-side-panel relative w-[252px] shrink-0 h-full flex flex-col border-r bg-surface ${
        dropping ? "border-foreground/40" : "border-border"
      }`}
      onDragOver={(e) => {
        if (!getElectronAPI()?.pathForFile) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        if (e.relatedTarget === null) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {dropping && (
        <div className="absolute inset-0 z-10 m-1.5 rounded-lg border-2 border-dashed border-foreground/40 bg-surface/80 flex items-center justify-center pointer-events-none">
          <span className="text-[12px] text-foreground/80">Drop to add to your library</span>
        </div>
      )}
      <div className="flex items-center justify-between px-3 h-10 shrink-0 border-b border-border">
        <span className="text-[11px] uppercase tracking-wide text-muted font-medium">{VIEW_TITLE[view]}</span>
        <div className="flex items-center gap-1">
          <button onClick={onOpenFile} title="Open file (⌘O)" className="text-muted hover:text-foreground w-6 h-6 flex items-center justify-center rounded hover:bg-accent/40">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button onClick={onClose} title="Collapse (⌘L)" aria-label="Collapse library" className="text-muted hover:text-foreground w-6 h-6 flex items-center justify-center rounded hover:bg-accent/40">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
        </div>
      </div>

      {/* Recent/Files sub-toggle — only the Library view has sub-tabs */}
      {view === "library" && (
        <>
          <div className="flex items-center gap-0.5 px-2 py-1.5 shrink-0 border-b border-border/60">
            {(["recent", "files"] as LibTab[]).map((t) => (
              <button
                key={t}
                onClick={() => pickTab(t)}
                className={`flex-1 text-[11px] py-1 rounded-md capitalize transition-colors ${
                  libTab === t
                    ? "bg-accent text-foreground"
                    : "text-muted hover:text-foreground hover:bg-accent/40"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {!loading && libTab === "recent" && <LibraryOverviewBand overview={overview} />}
        </>
      )}

      <div className="flex-1 overflow-y-auto px-1.5 py-2">
        {view === "browse" ? (
          <BrowseView onOpenPath={onOpenPath} activePath={activePath} />
        ) : view === "skills" ? (
          <SkillsView onOpenPath={onOpenPath} activePath={activePath} />
        ) : view === "shared" ? (
          <SharedView
            sharedWithMe={sharedItems}
            withMeLoading={loading}
            renderRow={fileRow}
            signedIn={signedIn}
            onManage={onManageShare}
            refreshKey={refreshKey}
          />
        ) : loading ? (
          <LibrarySkeleton />
        ) : libTab === "files" ? (
          <FilesView
            activePath={activePath}
            refreshKey={refreshKey}
            onOpenPath={onOpenPath}
            onNotice={setNotice}
          />
        ) : localFiles.length === 0 &&
          myCloudOnly.length === 0 &&
          sharedCloudOnly.length === 0 ? (
          <RecentEmptyState
            onOpenFile={onOpenFile}
            onShowFiles={() => pickTab("files")}
            workspace={workspace}
          />
        ) : (
          <>
            {localFiles.length > 0 && (
              <LibrarySectionHeader label="On this device" items={localFiles} />
            )}
            {localFiles.map(fileRow)}
            {myCloudOnly.length > 0 && (
              <LibrarySectionHeader label="In your cloud" items={myCloudOnly} />
            )}
            {myCloudOnly.map(fileRow)}
            {sharedCloudOnly.length > 0 && (
              <LibrarySectionHeader label="Shared with me" items={sharedCloudOnly} />
            )}
            {sharedCloudOnly.map(fileRow)}
          </>
        )}
      </div>

      {!signedIn && (
        <button
          onClick={onSignIn}
          className="m-2 text-[11px] text-muted hover:text-foreground border border-border rounded-md py-1.5 px-2 text-left leading-snug"
        >
          <span className="text-foreground/90">Sign in</span> to sync these files
          across your devices and share them.
        </button>
      )}
      {notice && (
        <div className="px-3 py-2 text-[11px] text-muted border-t border-border">{notice}</div>
      )}

      {needsDefault && (
        <div className="border-t border-border px-2 py-2">
          <button
            onClick={makeDefault}
            disabled={settingDefault}
            className="w-full text-[11px] text-muted hover:text-foreground rounded-md py-1.5 px-2 text-left hover:bg-accent/40 disabled:opacity-50"
          >
            {settingDefault
              ? "Setting…"
              : "Open .md files in Markie by default"}
          </button>
          {defaultMsg && (
            <div className="text-[10.5px] text-muted px-2 pt-1 leading-snug">{defaultMsg}</div>
          )}
        </div>
      )}

      {confirmOff && (
        <div className="markie-scrim-strong fixed inset-0 z-[110] flex items-center justify-center">
          <div className="w-[380px] rounded-xl border border-border shadow-2xl p-4" style={{ background: "var(--surface-2)" }}>
            <div className="text-[13px] text-foreground mb-1">Stop syncing this document?</div>
            <div className="text-[12px] text-muted mb-4">
              A copy currently exists in your cloud. You can keep it there
              (syncing just pauses) or delete it.
            </div>
            <div className="flex flex-col gap-2">
              <button className="w-full text-[12px] py-2 rounded-md bg-accent text-foreground" onClick={() => act(async () => { await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: false }); setConfirmOff(null); })}>
                Keep cloud copy, pause syncing
              </button>
              <button className="w-full text-[12px] py-2 rounded-md border border-[color:var(--status-red)] text-[var(--status-red)] hover:bg-accent/40" onClick={() => act(async () => { await getElectronAPI()!.docSyncOff({ path: confirmOff, deleteRemote: true }); setConfirmOff(null); })}>
                Delete the cloud copy
              </button>
              <button className="w-full text-[12px] py-1.5 text-muted hover:text-foreground" onClick={() => setConfirmOff(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const SKELETON_WIDTHS = ["72%", "54%", "80%", "46%"];

function LibrarySkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Loading library</span>
      <div className="animate-pulse" aria-hidden="true">
        {SKELETON_WIDTHS.map((width, i) => (
          <div key={i} className="rounded-md px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <div className="h-[13px] w-[13px] rounded bg-accent shrink-0" />
              <div className="h-2.5 flex-1 rounded bg-accent" style={{ maxWidth: width }} />
              <div className="h-3 w-8 rounded bg-accent shrink-0" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LibrarySectionHeader({
  label,
  items,
}: {
  label: string;
  items: LibraryItem[];
}) {
  const attention = items.filter(libraryItemNeedsAttention).length;

  return (
    <div className="flex items-center justify-between gap-2 px-2 pt-3 pb-1">
      <span className="text-[9px] uppercase tracking-wide text-muted">{label}</span>
      <span
        className={`rounded border px-1 py-px text-[9px] tabular-nums ${
          attention > 0
            ? "border-[color:var(--status-yellow)] text-[var(--status-yellow)]"
            : "border-border/70 text-muted"
        }`}
      >
        {attention > 0 ? `${attention} alert${attention === 1 ? "" : "s"}` : items.length}
      </span>
    </div>
  );
}

function LibraryOverviewBand({ overview }: { overview: LibraryOverview }) {
  return (
    <div className="shrink-0 border-b border-border/60 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted">Documents</span>
        <span
          className={`text-[10.5px] ${
            overview.needsAttention > 0 ? "text-[var(--status-yellow)]" : "text-muted"
          }`}
        >
          {overview.needsAttention > 0 ? `${overview.needsAttention} need attention` : "All clear"}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1">
        <LibraryMetric label="Device" value={overview.onDevice} />
        <LibraryMetric label="Synced" value={overview.synced} />
        <LibraryMetric label="Shared" value={overview.shared} />
      </div>
      {overview.cloudOnly > 0 && (
        <div className="mt-1.5 text-[10.5px] text-muted">
          {overview.cloudOnly} cloud-only {overview.cloudOnly === 1 ? "doc" : "docs"}
        </div>
      )}
    </div>
  );
}

function LibraryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/35 px-1.5 py-1">
      <div className="text-[13px] leading-none text-foreground tabular-nums">{value}</div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

function RecentEmptyState({
  onOpenFile,
  onShowFiles,
  workspace,
}: {
  onOpenFile: () => void;
  onShowFiles: () => void;
  workspace: WorkspaceBootstrapResult | null;
}) {
  const readyPath =
    workspace && !workspace.error && workspace.roots.length > 0
      ? workspace.defaultPath || workspace.roots[0]
      : null;
  const compactPath = readyPath ? compactWorkspacePath(readyPath) : null;

  return (
    <div className="px-2 py-3">
      <div className="rounded-md border border-border/70 bg-background/45 px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[12px] font-medium text-foreground">
              {compactPath ? "Workspace ready" : "No recent files"}
            </div>
            {compactPath && (
              <div className="mt-0.5 text-[10.5px] text-muted truncate" title={readyPath ?? undefined}>
                {compactPath}
              </div>
            )}
          </div>
          {workspace?.created && (
            <span className="rounded border border-[color:var(--status-green)] px-1 py-px text-[9px] uppercase tracking-wide text-[var(--status-green)]">
              New
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={onOpenFile}
            className="rounded-md bg-accent px-2 py-1 text-[11px] text-foreground hover:opacity-90"
          >
            Open file
          </button>
          <button
            onClick={onShowFiles}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground"
          >
            Files
          </button>
        </div>
      </div>
    </div>
  );
}

function compactWorkspacePath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const documentsMarkie = normalized.match(/(?:^|\/)(Documents\/Markie)$/);
  if (documentsMarkie) return `~/${documentsMarkie[1]}`;
  return path;
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
