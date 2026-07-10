"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { getElectronAPI, type WsListing, type WsResult } from "@/lib/electron";
import {
  compactWorkspacePath,
  pathBasename,
  pathDirname,
} from "@/lib/path-utils";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { ensureDefaultWorkspaceRoot } from "@/lib/workspace-default";
import { openedPathAfterWorkspaceEdit } from "@/lib/workspace-edit";

interface FilesViewProps {
  activePath: string | null;
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onNotice: (msg: string | null) => void;
}

const parentDirectory = (value: string) => pathDirname(value) ?? value;

type Edit =
  | { kind: "new-folder" | "new-file"; parent: string; value: string }
  | { kind: "rename"; target: string; value: string }
  | null;

export function FilesView({
  activePath,
  refreshKey,
  onOpenPath,
  onNotice,
}: FilesViewProps) {
  const api = getElectronAPI();
  // null = loading; [] decided up front when there's no desktop API (web)
  const [roots, setRoots] = useState<string[] | null>(() =>
    getElectronAPI()?.wsRoots ? null : []
  );
  const [defaultPath, setDefaultPath] = useState("");
  const [listings, setListings] = useState<Record<string, WsListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit>(null);
  const [dragSrc, setDragSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);
  const attachMenuRoot = useCallback((node: HTMLDivElement | null) => {
    menuRootRef.current = node;
  }, []);

  useDismissibleLayer(menuFor !== null, menuRootRef, () => setMenuFor(null));

  const loadDir = useCallback(
    async (p: string) => {
      if (!api?.wsListDir) return;
      const r = await api.wsListDir(p);
      if (r && !("error" in r)) {
        setListings((prev) => ({ ...prev, [p]: r }));
      }
    },
    [api]
  );

  const loadRoots = useCallback(async () => {
    if (!api?.wsRoots) return;
    const result = await ensureDefaultWorkspaceRoot(api);
    const rs = result.roots;
    const dp = result.defaultPath;
    setRoots(rs);
    setDefaultPath(dp);
    if (result.error) onNotice(result.error);
    // auto-expand + load each root
    setExpanded((prev) => {
      const next = new Set(prev);
      rs.forEach((r) => next.add(r));
      return next;
    });
    rs.forEach((r) => loadDir(r));
  }, [api, loadDir, onNotice]);

  useEffect(() => {
    if (!api?.wsRoots) return;
    let alive = true;
    (async () => {
      const result = await ensureDefaultWorkspaceRoot(api);
      if (!alive) return;
      const rs = result.roots;
      setRoots(rs);
      setDefaultPath(result.defaultPath);
      if (result.error) onNotice(result.error);
      setExpanded((prev) => {
        const next = new Set(prev);
        rs.forEach((r) => next.add(r));
        return next;
      });
      rs.forEach((r) => loadDir(r));
    })();
    return () => {
      alive = false;
    };
  }, [api, loadDir, onNotice, refreshKey]);

  const toggle = (folder: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
        if (!listings[folder]) loadDir(folder);
      }
      return next;
    });
  };

  const createDefault = async () => {
    setBusy(true);
    const res = await api?.wsCreateDefault?.();
    setBusy(false);
    if (res?.error) onNotice(res.error);
    else loadRoots();
  };

  const addRoot = async () => {
    const res = await api?.wsAddRoot?.();
    if (res?.error) onNotice(res.error);
    else if (res?.ok) loadRoots();
  };

  const submitEdit = async () => {
    if (!edit || !api) return setEdit(null);
    const value = edit.value.trim();
    if (!value) return setEdit(null);
    setBusy(true);
    let res: WsResult | undefined;
    let reloadDir: string | null = null;
    if (edit.kind === "new-folder") {
      res = await api.wsMkdir(edit.parent, value);
      reloadDir = edit.parent;
    } else if (edit.kind === "new-file") {
      res = await api.wsNewFile(edit.parent, value);
      reloadDir = edit.parent;
    } else if (edit.kind === "rename") {
      res = await api.wsRename(edit.target, value);
      reloadDir = parentDirectory(edit.target);
    }
    const openPath = openedPathAfterWorkspaceEdit(edit.kind, res);
    setBusy(false);
    setEdit(null);
    if (res?.error) onNotice(res.error);
    else {
      if (reloadDir) loadDir(reloadDir);
      if (openPath) onOpenPath(openPath);
    }
  };

  const startNew = (parent: string, kind: "new-folder" | "new-file") => {
    setMenuFor(null);
    if (!expanded.has(parent)) toggle(parent);
    setEdit({ kind, parent, value: "" });
  };

  const trash = async (target: string) => {
    setMenuFor(null);
    const res = await api?.wsTrash?.(target);
    if (res?.error) onNotice(res.error);
    else loadDir(parentDirectory(target));
  };

  const onDropInto = async (folder: string) => {
    const src = dragSrc;
    setDragSrc(null);
    if (!src || src === folder || parentDirectory(src) === folder) return;
    const res = await api?.wsMove?.(src, folder);
    if (res?.error) onNotice(res.error);
    else {
      loadDir(folder);
      loadDir(parentDirectory(src));
    }
  };

  if (roots === null) {
    return <FilesSkeleton />;
  }

  if (!api?.wsRoots) {
    return (
      <div className="px-2 py-3">
        <div className="rounded-md border border-border/70 bg-background/45 px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-start gap-2">
            <span className="mt-px shrink-0 text-muted"><DesktopIcon /></span>
            <div>
              <div className="text-[12px] font-medium text-foreground">Desktop app required</div>
              <div className="mt-0.5 text-[11px] text-muted leading-snug">
                The Files workspace opens folders from your Mac.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
        <div className="mb-3">
          Markie could not set up its default workspace automatically. Pick a
          folder to organize your markdown on this computer.
        </div>
        <button
          onClick={createDefault}
          disabled={busy}
          className="w-full text-[12px] py-1.5 mb-1.5 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50"
        >
          Create {compactWorkspacePath(defaultPath)}
        </button>
        <button
          onClick={addRoot}
          className="w-full text-[12px] py-1.5 rounded-md border border-border text-foreground/90 hover:bg-accent/40"
        >
          Choose a folder…
        </button>
      </div>
    );
  }

  // Recursive folder/file rendering
  const renderDir = (dir: string, depth: number) => {
    const listing = listings[dir];
    if (!listing) return null;
    const pad = { paddingLeft: `${depth * 12 + 8}px` };
    return (
      <>
        {edit && edit.kind !== "rename" && edit.parent === dir && (
          <div style={pad} className="py-0.5">
            <input
              data-workspace-new-file-input={edit.kind === "new-file" ? "true" : undefined}
              autoFocus
              value={edit.value}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitEdit();
                if (e.key === "Escape") setEdit(null);
              }}
              onBlur={submitEdit}
              placeholder={edit.kind === "new-folder" ? "New folder" : "untitled.md"}
              className="w-[88%] text-[12px] bg-background border border-border rounded px-1.5 py-0.5 text-foreground outline-none focus:border-foreground/30"
            />
          </div>
        )}
        {listing.folders.map((f) => {
          const isOpen = expanded.has(f.path);
          return (
            <div key={f.path}>
              <Row
                depth={depth}
                isFolder
                isOpen={isOpen}
                name={f.name}
                path={f.path}
                active={false}
                editing={edit?.kind === "rename" && edit.target === f.path ? edit.value : null}
                onEditChange={(v) => edit && setEdit({ ...edit, value: v })}
                onEditSubmit={submitEdit}
                onEditCancel={() => setEdit(null)}
                onClick={() => toggle(f.path)}
                menuOpen={menuFor === f.path}
                attachMenuRoot={menuFor === f.path ? attachMenuRoot : undefined}
                onMenu={() => setMenuFor(menuFor === f.path ? null : f.path)}
                onDragStart={() => setDragSrc(f.path)}
                onDrop={() => onDropInto(f.path)}
                onNewFolder={() => startNew(f.path, "new-folder")}
                onNewFile={() => startNew(f.path, "new-file")}
                onRename={() => { setMenuFor(null); setEdit({ kind: "rename", target: f.path, value: f.name }); }}
                onReveal={() => { setMenuFor(null); api.wsReveal(f.path); }}
                onTrash={() => trash(f.path)}
                onCopyPath={async () => { setMenuFor(null); try { await navigator.clipboard.writeText(f.path); onNotice("Path copied."); } catch { onNotice("Couldn't copy."); } }}
              />
              {isOpen && renderDir(f.path, depth + 1)}
            </div>
          );
        })}
        {listing.files.map((file) => (
          <Row
            key={file.path}
            depth={depth}
            isFolder={false}
            name={file.name}
            path={file.path}
            active={activePath === file.path}
            editing={edit?.kind === "rename" && edit.target === file.path ? edit.value : null}
            onEditChange={(v) => edit && setEdit({ ...edit, value: v })}
            onEditSubmit={submitEdit}
            onEditCancel={() => setEdit(null)}
            onClick={() => onOpenPath(file.path)}
            menuOpen={menuFor === file.path}
            attachMenuRoot={menuFor === file.path ? attachMenuRoot : undefined}
            onMenu={() => setMenuFor(menuFor === file.path ? null : file.path)}
            onDragStart={() => setDragSrc(file.path)}
            onRename={() => { setMenuFor(null); setEdit({ kind: "rename", target: file.path, value: file.name }); }}
            onReveal={() => { setMenuFor(null); api.wsReveal(file.path); }}
            onTrash={() => trash(file.path)}
            onCopyPath={async () => { setMenuFor(null); try { await navigator.clipboard.writeText(file.path); onNotice("Path copied."); } catch { onNotice("Couldn't copy."); } }}
          />
        ))}
        {listing.folders.length === 0 && listing.files.length === 0 && depth > 0 && (
          depth === 1 ? (
            <RootEmptyState
              rootName={pathBasename(dir)}
              onNewFile={() => startNew(dir, "new-file")}
              onNewFolder={() => startNew(dir, "new-folder")}
            />
          ) : (
            <div style={{ paddingLeft: `${depth * 12 + 20}px` }} className="flex items-center gap-1.5 py-0.5 text-[10.5px] text-muted">
              <EmptyLeafIcon />
              <span>Empty folder</span>
            </div>
          )
        )}
      </>
    );
  };

  return (
    <div className="pt-1">
      {roots.map((root) => {
        const isDefaultRoot = root === defaultPath;
        return (
          <div key={root}>
            <div
              className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/40 rounded-md"
              onClick={() => toggle(root)}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); onDropInto(root); }}
            >
              <Chevron open={expanded.has(root)} />
              <span className="text-[11px] uppercase tracking-wide text-muted font-medium flex-1 truncate" title={root}>
                {pathBasename(root)}
              </span>
              {isDefaultRoot && (
                <span className="text-[9px] px-1 py-px rounded border border-border/80 text-muted shrink-0">
                  Default
                </span>
              )}
              <button onClick={(e) => { e.stopPropagation(); startNew(root, "new-folder"); }} title="New folder" className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted hover:text-foreground hover:bg-accent/40 text-[13px] transition">＋</button>
            </div>
            {expanded.has(root) && renderDir(root, 1)}
          </div>
        );
      })}
      <button onClick={addRoot} className="mt-1.5 ml-2 text-[11px] text-muted hover:text-foreground">+ Add folder</button>
    </div>
  );
}

function RootEmptyState({
  rootName,
  onNewFile,
  onNewFolder,
}: {
  rootName: string;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  return (
    <div className="pl-8 pr-2 py-1.5">
      <div className="rounded-md border border-border/70 bg-background/45 px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="text-[12px] text-foreground/90 font-medium truncate">
          {rootName} is ready
        </div>
        <div className="mt-0.5 text-[11px] text-muted leading-snug">
          Start with a markdown file or organize a folder.
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            data-workspace-new-file
            onClick={onNewFile}
            className="rounded-md bg-accent px-2 py-1 text-[11px] text-foreground hover:opacity-90"
          >
            New file
          </button>
          <button
            onClick={onNewFolder}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-accent/40 hover:text-foreground"
          >
            New folder
          </button>
        </div>
      </div>
    </div>
  );
}

const SKELETON_WIDTHS = ["70%", "48%", "62%", "82%", "40%"];

function FilesSkeleton() {
  return (
    <div className="pt-1" aria-busy="true">
      <span className="sr-only">Loading files</span>
      <div className="animate-pulse" aria-hidden="true">
        {SKELETON_WIDTHS.map((width, i) => (
          <div
            key={i}
            className="flex items-center gap-1.5 pr-2 py-1"
            style={{ paddingLeft: `${(i === 0 ? 0 : 12) + 8}px` }}
          >
            <div className="h-[11px] w-[11px] rounded bg-accent shrink-0" />
            <div className="h-[13px] w-[13px] rounded bg-accent shrink-0" />
            <div className="h-2.5 flex-1 rounded bg-accent" style={{ maxWidth: width }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyLeafIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </svg>
  );
}

function DesktopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-muted shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

interface RowProps {
  depth: number;
  isFolder: boolean;
  isOpen?: boolean;
  name: string;
  path: string;
  active: boolean;
  editing: string | null;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onClick: () => void;
  menuOpen: boolean;
  attachMenuRoot?: (node: HTMLDivElement | null) => void;
  onMenu: () => void;
  onDragStart: () => void;
  onDrop?: () => void;
  onNewFolder?: () => void;
  onNewFile?: () => void;
  onRename: () => void;
  onReveal: () => void;
  onTrash: () => void;
  onCopyPath: () => void;
}

function Row({
  depth,
  isFolder,
  isOpen,
  name,
  path,
  active,
  editing,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onClick,
  menuOpen,
  attachMenuRoot,
  onMenu,
  onDragStart,
  onDrop,
  onNewFolder,
  onNewFile,
  onRename,
  onReveal,
  onTrash,
  onCopyPath,
}: RowProps) {
  const pad = { paddingLeft: `${depth * 12 + 8}px` };
  return (
    <div ref={attachMenuRoot}>
      <div
        style={pad}
        draggable={!editing}
        onDragStart={onDragStart}
        onDragOver={isFolder ? (e) => e.preventDefault() : undefined}
        onDrop={isFolder && onDrop ? (e) => { e.preventDefault(); onDrop(); } : undefined}
        className={`group flex items-center gap-1.5 pr-2 py-1 rounded-md cursor-pointer ${
          active ? "bg-accent" : "hover:bg-accent/40"
        }`}
        onClick={editing ? undefined : onClick}
      >
        {isFolder ? <Chevron open={!!isOpen} /> : <span className="w-[11px] shrink-0" />}
        {isFolder ? <FolderIcon /> : <FileIcon />}
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit();
              if (e.key === "Escape") onEditCancel();
            }}
            onBlur={onEditSubmit}
            className="flex-1 text-[12px] bg-background border border-border rounded px-1 py-0 text-foreground outline-none focus:border-foreground/30"
          />
        ) : (
          <span className="text-[12.5px] text-foreground truncate flex-1" title={path}>{name}</span>
        )}
        <button
          data-file-actions-trigger
          onClick={(e) => { e.stopPropagation(); onMenu(); }}
          className="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-muted hover:text-foreground hover:bg-accent/40 shrink-0 transition"
          aria-label="Actions"
        >
          ⋯
        </button>
      </div>
      {menuOpen && (
        <div style={{ paddingLeft: `${depth * 12 + 26}px` }} className="flex flex-wrap gap-x-3 gap-y-1 pb-1 text-[11px]">
          {isFolder && <button className="text-muted hover:text-foreground" onClick={onNewFile}>New file</button>}
          {isFolder && <button className="text-muted hover:text-foreground" onClick={onNewFolder}>New folder</button>}
          <button className="text-muted hover:text-foreground" onClick={onRename}>Rename</button>
          <button className="text-muted hover:text-foreground" onClick={onCopyPath}>Copy path</button>
          <button className="text-muted hover:text-foreground" onClick={onReveal}>Reveal</button>
          <button className="text-[var(--status-red)] hover:underline" onClick={onTrash}>Trash</button>
        </div>
      )}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
