// The Live Docs area (super-nightly, step M3): a pane of its own beside the
// Markdown and documents panes, reached from its rail button. Its home lists
// the Live Docs projects a person has added. Opening one shows every project
// file in a tree and edits any text file in one CodeMirror editor with simple
// tabs. An edit made outside Markie shows up in the tree and the open tab.
//
// Every folder and file stays in the main process
// (electron/live-docs-projects.cjs). This pane holds a project's id and its
// files' paths inside the project, and nothing else. It starts no process:
// Run, the preview, Problems and the terminal come in M4.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  getElectronAPI,
  type LiveDocsLocalProject,
  type LiveDocsOpenProject,
  type LiveDocsProjectChange,
  type LiveDocsTreeEntry,
} from "@/lib/electron";
import { SourceEditor } from "@/components/source-editor";
import type { SourceHandle } from "@/lib/source-handle";
import { baseName, buildProjectTree, editsAsMarkdown, initiallyExpanded, type LiveDocsTreeNode } from "@/lib/live-docs/tree";
import { emptyTabs, isDirty, tabsReducer, type LiveDocsTab } from "@/lib/live-docs/tabs";
import { liveDocsHomeSections, refusalMessage } from "@/lib/live-docs/home";

/** What the app shell needs from the area: menu Save and Undo, and the close guard. */
export interface LiveDocsShell {
  projectName: string | null;
  activeName: string | null;
  activeDirty: boolean;
  dirtyCount: number;
  save(): void;
  undo(): void;
  redo(): void;
  /** False, with the reason shown in the area, when closing now would lose unsaved edits. */
  prepareClose(): boolean;
}

interface LiveDocsAreaProps {
  /** The area is the pane on screen. The list loads the first time it is. */
  active: boolean;
  onShellChange?: (shell: LiveDocsShell | null) => void;
}

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

const BUTTON = "markie-overlay-button rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-accent/40 hover:text-foreground disabled:opacity-40";
const ROW = "flex w-full items-center gap-1 pl-1 pr-2 py-1 text-left text-[12px] cursor-pointer hover:bg-accent/30";
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
// A change to a folder (a rename, a delete) reaches every file under it.
const touches = (changed: readonly string[], filePath: string) => changed.some((p) => p === filePath || filePath.startsWith(`${p}/`));

export function LiveDocsArea({ active, onShellChange }: LiveDocsAreaProps) {
  const api = getElectronAPI()?.liveDocsProjects ?? null;
  const [projects, setProjects] = useState<LiveDocsLocalProject[] | null>(null);
  const [project, setProject] = useState<LiveDocsOpenProject | null>(null);
  const [entries, setEntries] = useState<LiveDocsTreeEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [tabs, dispatch] = useReducer(tabsReducer, emptyTabs);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => { tabsRef.current = tabs; }, [tabs]);
  // Bumped whenever the open project changes, so an answer about the last
  // project never lands in this one.
  const generation = useRef(0);
  const handles = useRef(new Map<string, SourceHandle>());
  // Changes that arrived while that file was saving; read once the save lands.
  const recheck = useRef(new Set<string>());

  const loadList = useCallback(async () => {
    if (!api) return;
    const result = await api.list();
    if (result.ok) setProjects(result.projects);
    else { setProjects([]); setNotice(refusalMessage(result)); }
  }, [api]);
  useEffect(() => {
    if (active && projects === null) void loadList();
  }, [active, projects, loadList]);

  const refreshTree = useCallback(async () => {
    if (!api) return;
    const at = generation.current;
    const tree = await api.tree();
    if (at !== generation.current) return;
    if (!tree.ok) { setNotice(refusalMessage(tree)); return; }
    setEntries(tree.entries);
    setTruncated(tree.truncated);
    setProject(tree.project);
  }, [api]);

  const reread = useCallback(async (filePath: string) => {
    if (!api) return;
    const at = generation.current;
    const result = await api.read({ path: filePath });
    if (at !== generation.current) return;
    if (result.ok) dispatch({ type: "disk-read", path: filePath, text: result.file.text, revision: result.file.revision });
    else if (result.code === "missing" || result.code === "not-a-file" || result.code === "symlink") dispatch({ type: "disk-missing", path: filePath });
    else dispatch({ type: "save-failed", path: filePath, message: refusalMessage(result) });
  }, [api]);

  const save = useCallback(async (filePath?: string) => {
    const target = filePath ?? tabsRef.current.active;
    const tab = tabsRef.current.tabs.find((item) => item.path === target);
    if (!api || !tab || tab.saving || !isDirty(tab)) return;
    const at = generation.current;
    const text = tab.text;
    dispatch({ type: "saving", path: tab.path });
    const result = await api.write({ path: tab.path, text, baseRevision: tab.revision });
    if (at !== generation.current) return;
    if (result.ok) dispatch({ type: "saved", path: tab.path, text, revision: result.file.revision });
    else {
      dispatch({ type: "save-failed", path: tab.path, message: refusalMessage(result, `${baseName(tab.path)} was not saved.`) });
      // Say what is on disk now, so the banner can offer to reload it.
      if (result.code === "conflict") void reread(tab.path);
    }
    if (recheck.current.delete(tab.path)) void reread(tab.path);
  }, [api, reread]);

  // Outside edits: refresh the tree, and read again every open file they touched.
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!api || !projectId) return;
    return api.onChanged((change: LiveDocsProjectChange) => {
      if (change.projectId !== projectId) return;
      void refreshTree();
      for (const tab of tabsRef.current.tabs) {
        if (!change.overflow && !touches(change.paths, tab.path)) continue;
        if (tab.saving) recheck.current.add(tab.path);
        else void reread(tab.path);
      }
    });
  }, [api, projectId, refreshTree, reread]);

  const resetProjectView = () => {
    dispatch({ type: "reset" });
    handles.current.clear();
    recheck.current.clear();
    setEntries([]);
    setTruncated(false);
    setExpanded(new Set());
  };

  const addProject = async () => {
    if (!api || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.add();
      if (!result.ok) { if (result.code !== "canceled") setNotice(refusalMessage(result)); return; }
      await loadList();
      if (result.existed) setNotice(`${result.project.name} is already in Live Docs.`);
    } finally {
      setBusy(false);
    }
  };

  const openProject = async (id: string) => {
    if (!api) return;
    const at = ++generation.current;
    setNotice(null);
    const result = await api.open({ id });
    if (at !== generation.current) return;
    if (!result.ok) { setNotice(refusalMessage(result)); void loadList(); return; }
    resetProjectView();
    setProject(result.project);
    const tree = await api.tree();
    if (at !== generation.current) return;
    if (!tree.ok) { setNotice(refusalMessage(tree)); return; }
    setEntries(tree.entries);
    setTruncated(tree.truncated);
    setExpanded(initiallyExpanded(tree.entries));
  };

  const leaveProject = async () => {
    generation.current += 1;
    resetProjectView();
    setProject(null);
    setNotice(null);
    await api?.close();
    void loadList();
  };
  const requestLeaveProject = () => {
    const dirty = tabsRef.current.tabs.filter(isDirty).length;
    if (!dirty) { void leaveProject(); return; }
    setConfirm({
      title: `Close ${project?.name ?? "this project"}?`,
      body: `${plural(dirty, "file has", "files have")} unsaved changes. Closing the project discards them.`,
      confirmLabel: "Discard and close",
      onConfirm: () => void leaveProject(),
    });
  };

  const requestRemove = (entry: LiveDocsLocalProject) => {
    setConfirm({
      title: `Remove ${entry.name} from Live Docs?`,
      body: "The folder and its files stay where they are. You can add it again at any time.",
      confirmLabel: "Remove",
      onConfirm: () => {
        void (async () => {
          const result = await api?.remove({ id: entry.id });
          if (result && !result.ok) setNotice(refusalMessage(result));
          await loadList();
        })();
      },
    });
  };

  const openFile = async (filePath: string) => {
    if (!api) return;
    if (tabsRef.current.tabs.some((tab) => tab.path === filePath)) { dispatch({ type: "activate", path: filePath }); return; }
    const at = generation.current;
    const result = await api.read({ path: filePath });
    if (at !== generation.current) return;
    if (!result.ok) { setNotice(`${baseName(filePath)}: ${refusalMessage(result)}`); return; }
    setNotice(null);
    dispatch({ type: "opened", path: filePath, text: result.file.text, revision: result.file.revision });
  };

  const closeTab = (tab: LiveDocsTab) => {
    const close = () => { dispatch({ type: "close", path: tab.path }); handles.current.delete(tab.path); };
    if (!isDirty(tab)) { close(); return; }
    setConfirm({
      title: `Close ${baseName(tab.path)} without saving?`,
      body: "Your changes to this file will be lost.",
      confirmLabel: "Close without saving",
      onConfirm: close,
    });
  };

  // One stable callback per file, so an editor never sees its ready or change
  // handler replaced (the editor drops its handle when onReady changes).
  const readyHandlers = useRef(new Map<string, (handle: SourceHandle | null) => void>());
  const changeHandlers = useRef(new Map<string, (text: string) => void>());
  const readyFor = (filePath: string) => {
    let handler = readyHandlers.current.get(filePath);
    if (!handler) {
      handler = (handle) => { if (handle) handles.current.set(filePath, handle); else handles.current.delete(filePath); };
      readyHandlers.current.set(filePath, handler);
    }
    return handler;
  };
  const changeFor = (filePath: string) => {
    let handler = changeHandlers.current.get(filePath);
    if (!handler) {
      handler = (text) => dispatch({ type: "edit", path: filePath, text });
      changeHandlers.current.set(filePath, handler);
    }
    return handler;
  };

  const activeTab = tabs.tabs.find((tab) => tab.path === tabs.active) ?? null;
  const dirtyPaths = useMemo(() => new Set(tabs.tabs.filter(isDirty).map((tab) => tab.path)), [tabs.tabs]);
  const dirtyCount = dirtyPaths.size;
  const tree = useMemo(() => buildProjectTree(entries), [entries]);

  // The shell the app reads. Its functions go through refs, so it changes
  // only when what it reports changes, not on every keystroke.
  const latest = useRef({ save, dirtyCount });
  useLayoutEffect(() => { latest.current = { save, dirtyCount }; }, [save, dirtyCount]);
  const projectName = project?.name ?? null;
  const activeName = activeTab ? baseName(activeTab.path) : null;
  const activeDirty = !!activeTab && isDirty(activeTab);
  useEffect(() => {
    onShellChange?.({
      projectName,
      activeName,
      activeDirty,
      dirtyCount,
      save: () => void latest.current.save(),
      undo: () => { const target = tabsRef.current.active; if (target) handles.current.get(target)?.undo(); },
      redo: () => { const target = tabsRef.current.active; if (target) handles.current.get(target)?.redo(); },
      prepareClose: () => {
        const dirty = latest.current.dirtyCount;
        if (!dirty) return true;
        setNotice(`Markie stayed open: ${plural(dirty, "Live Docs file has", "Live Docs files have")} unsaved changes. Save, or close the project to discard them.`);
        return false;
      },
    });
  }, [onShellChange, projectName, activeName, activeDirty, dirtyCount]);
  useEffect(() => () => onShellChange?.(null), [onShellChange]);

  if (!api) {
    return <div className="flex h-full items-center justify-center p-6 text-[13px] text-muted">Live Docs projects need the Markie app on a Mac.</div>;
  }

  const noticeStrip = notice ? (
    <div role="alert" className="flex items-start gap-3 border-b border-border bg-surface px-3 py-2 text-[12.5px] text-foreground">
      <span className="flex-1">{notice}</span>
      <button type="button" className={BUTTON} onClick={() => setNotice(null)}>Dismiss</button>
    </div>
  ) : null;
  const dialog = confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null;

  if (!project) {
    const sections = liveDocsHomeSections(projects ?? []);
    return (
      <div data-markie-live-docs="home" className="h-full overflow-auto bg-background">
        {noticeStrip}
        <div className="mx-auto max-w-[760px] px-6 py-8">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-foreground">Live Docs</h1>
              <p className="mt-1 text-[12.5px] text-muted">Darkmown projects you are building. Open one to edit its pages, skins and scripts.</p>
            </div>
            <button type="button" className={BUTTON} onClick={() => void addProject()} disabled={busy}>Add Project…</button>
          </header>
          {projects === null ? <p role="status" className="mt-6 text-[12.5px] text-muted">Loading…</p> : sections.map((section) => (
            <section key={section.kind} aria-label={section.label} className="mt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{section.label}</h2>
              {section.entries.length === 0 ? (
                <p className="mt-2 rounded-[12px] border border-dashed border-border px-4 py-5 text-[12.5px] text-muted">
                  No projects yet. Add a Darkmown project folder: one with site/pages, or a package.json that depends on @zvndev/darkmown.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {section.entries.map((entry) => (
                    <li key={entry.id} className="flex items-center gap-3 rounded-[12px] border border-border/75 bg-background/35 px-3 py-2.5 hover:border-foreground/22">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openProject(entry.id)} aria-label={`Open ${entry.name}`}>
                        <span className="block truncate text-[13.5px] font-semibold text-foreground">{entry.name}</span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-muted">
                          {entry.location}{entry.available ? "" : " · Folder not found"}
                        </span>
                      </button>
                      <button type="button" className={BUTTON} onClick={() => requestRemove(entry)} aria-label={`Remove ${entry.name} from Live Docs`}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div data-markie-live-docs="project" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <button type="button" className={BUTTON} onClick={requestLeaveProject}>← Live Docs</button>
        <span className="truncate text-[13px] font-semibold text-foreground">{project.name}</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted">{project.location}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] text-muted">{project.watching ? "Watching for outside changes" : "Not watching for outside changes"}</span>
      </header>
      {noticeStrip}
      {tabs.refused ? (
        <div role="alert" className="border-b border-border bg-surface px-3 py-2 text-[12.5px] text-foreground">
          Every open tab has unsaved changes. Save or close one to open {baseName(tabs.refused)}.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Project files" className="w-60 shrink-0 overflow-auto border-r border-border bg-surface py-1">
          <TreeRows
            nodes={tree}
            expanded={expanded}
            activePath={tabs.active}
            dirty={dirtyPaths}
            onToggle={(folder) => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(folder)) next.delete(folder); else next.add(folder);
              return next;
            })}
            onOpen={(filePath) => void openFile(filePath)}
          />
          {truncated ? <p className="px-2 py-1 text-[11px] text-muted">This project has more files than the tree shows.</p> : null}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.tabs.length ? (
            <div role="tablist" aria-label="Open files" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface">
              {tabs.tabs.map((tab, index) => {
                const selected = tab.path === tabs.active;
                return (
                  <div key={tab.path} className={`flex shrink-0 items-center border-r border-border ${selected ? "bg-background text-foreground" : "text-muted"}`}>
                    <button
                      type="button"
                      role="tab"
                      id={`live-docs-tab-${index}`}
                      aria-selected={selected}
                      aria-controls={`live-docs-panel-${index}`}
                      title={tab.path}
                      className="h-full pl-3 pr-1 text-[12px] hover:text-foreground"
                      onClick={() => dispatch({ type: "activate", path: tab.path })}
                    >
                      {baseName(tab.path)}
                      {isDirty(tab) ? <span aria-label="unsaved changes" className="ml-1.5 text-[var(--status-blue)]">●</span> : null}
                    </button>
                    <button type="button" aria-label={`Close ${baseName(tab.path)}`} className="px-1.5 text-[13px] text-muted hover:text-foreground" onClick={() => closeTab(tab)}>×</button>
                  </div>
                );
              })}
            </div>
          ) : null}
          {activeTab ? (
            <TabBanner
              tab={activeTab}
              onReload={() => dispatch({ type: "reload", path: activeTab.path })}
              onKeepMine={() => dispatch({ type: "keep-mine", path: activeTab.path })}
            />
          ) : null}
          <div className="relative min-h-0 flex-1">
            {tabs.tabs.map((tab, index) => (
              <div
                key={tab.path}
                role="tabpanel"
                id={`live-docs-panel-${index}`}
                aria-labelledby={`live-docs-tab-${index}`}
                hidden={tab.path !== tabs.active}
                data-live-docs-editor={tab.path}
                className="absolute inset-0"
              >
                <SourceEditor value={tab.text} onChange={changeFor(tab.path)} plainText={!editsAsMarkdown(tab.path)} onReady={readyFor(tab.path)} />
              </div>
            ))}
            {!tabs.tabs.length ? <div className="flex h-full items-center justify-center p-6 text-[12.5px] text-muted">Choose a file in the tree to edit it.</div> : null}
          </div>
          <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted">
            {activeTab ? (
              <>
                <span className="min-w-0 truncate">{activeTab.path}</span>
                <span className="flex-1" />
                <span role="status">{activeTab.saving ? "Saving…" : isDirty(activeTab) ? "Unsaved · ⌘S saves" : "Saved"}</span>
              </>
            ) : null}
          </footer>
        </div>
      </div>
      {dialog}
    </div>
  );
}

function TreeRows({ nodes, expanded, activePath, dirty, onToggle, onOpen }: {
  nodes: LiveDocsTreeNode[];
  expanded: ReadonlySet<string>;
  activePath: string | null;
  dirty: ReadonlySet<string>;
  onToggle: (folder: string) => void;
  onOpen: (filePath: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        if (node.kind === "dir") {
          const open = expanded.has(node.path);
          return (
            <li key={node.path}>
              <button type="button" className={ROW} aria-expanded={open} title={node.path} onClick={() => onToggle(node.path)}>
                <span aria-hidden="true" className="w-3 shrink-0 text-muted">{open ? "▾" : "▸"}</span>
                <span className="flex-1 truncate text-foreground/90">{node.name}</span>
              </button>
              {open && node.children.length ? (
                <div className="ml-[6px] border-l border-border pl-[5px]">
                  <TreeRows nodes={node.children} expanded={expanded} activePath={activePath} dirty={dirty} onToggle={onToggle} onOpen={onOpen} />
                </div>
              ) : null}
            </li>
          );
        }
        if (node.kind === "link") {
          return (
            <li key={node.path} className={`${ROW} cursor-default text-muted hover:bg-transparent`} title={`${node.path} is a symbolic link. Markie does not follow links inside a project.`}>
              <span aria-hidden="true" className="w-3 shrink-0" />
              <span className="flex-1 truncate italic">{node.name}</span>
              <span className="shrink-0 text-[10px]">link</span>
            </li>
          );
        }
        const current = node.path === activePath;
        return (
          <li key={node.path}>
            <button type="button" className={`${ROW} ${current ? "bg-accent/40" : ""}`} aria-current={current ? "true" : undefined} title={node.path} onClick={() => onOpen(node.path)}>
              <span aria-hidden="true" className="w-3 shrink-0" />
              <span className="flex-1 truncate">{node.name}</span>
              {dirty.has(node.path) ? <span aria-label="unsaved changes" className="shrink-0 text-[10px] text-[var(--status-blue)]">●</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TabBanner({ tab, onReload, onKeepMine }: { tab: LiveDocsTab; onReload: () => void; onKeepMine: () => void }) {
  const name = baseName(tab.path);
  const strip = "flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 text-[12.5px] text-foreground";
  if (tab.disk?.kind === "changed") {
    return (
      <div role="alert" className={strip}>
        <span className="flex-1">{name} changed outside Markie, and you have unsaved changes.</span>
        <button type="button" className={BUTTON} onClick={onReload}>Reload from disk</button>
        <button type="button" className={BUTTON} onClick={onKeepMine}>Keep my version</button>
      </div>
    );
  }
  if (tab.disk?.kind === "deleted") {
    return (
      <div role="alert" className={strip}>
        <span className="flex-1">{name} was deleted or renamed outside Markie. Its text stays here until you close the tab.</span>
        <button type="button" className={BUTTON} onClick={onKeepMine}>Dismiss</button>
      </div>
    );
  }
  if (tab.error) return <div role="alert" className={strip}>{tab.error}</div>;
  return null;
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return (
    <div className="markie-scrim fixed inset-0 z-50 flex items-center justify-center p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="live-docs-confirm-title"
        aria-describedby="live-docs-confirm-body"
        className="markie-overlay-panel w-[min(440px,calc(100vw-2rem))] rounded-[14px] p-5"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      >
        <h2 id="live-docs-confirm-title" className="text-[15px] font-semibold text-foreground">{request.title}</h2>
        <p id="live-docs-confirm-body" className="mt-2 text-[12.5px] text-muted">{request.body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancel} type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON} onClick={() => { onClose(); request.onConfirm(); }}>{request.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
