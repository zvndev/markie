"use client";

import { useCallback, useEffect, useState } from "react";
import { getElectronAPI, type WsListing } from "@/lib/electron";

interface FilesViewProps {
  activePath: string | null;
  refreshKey: number;
  onOpenPath: (path: string) => void;
  onNotice: (msg: string | null) => void;
}

const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

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
    const [rs, dp] = await Promise.all([api.wsRoots(), api.wsDefaultPath()]);
    setRoots(rs);
    setDefaultPath(dp);
    // auto-expand + load each root
    setExpanded((prev) => {
      const next = new Set(prev);
      rs.forEach((r) => next.add(r));
      return next;
    });
    rs.forEach((r) => loadDir(r));
  }, [api, loadDir]);

  useEffect(() => {
    if (!api?.wsRoots) return;
    let alive = true;
    (async () => {
      const [rs, dp] = await Promise.all([api.wsRoots(), api.wsDefaultPath()]);
      if (!alive) return;
      setRoots(rs);
      setDefaultPath(dp);
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
  }, [api, loadDir, refreshKey]);

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
    let res: { ok?: boolean; error?: string } | undefined;
    let reloadDir: string | null = null;
    if (edit.kind === "new-folder") {
      res = await api.wsMkdir(edit.parent, value);
      reloadDir = edit.parent;
    } else if (edit.kind === "new-file") {
      res = await api.wsNewFile(edit.parent, value);
      reloadDir = edit.parent;
    } else if (edit.kind === "rename") {
      res = await api.wsRename(edit.target, value);
      reloadDir = dirname(edit.target);
    }
    setBusy(false);
    setEdit(null);
    if (res?.error) onNotice(res.error);
    else if (reloadDir) loadDir(reloadDir);
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
    else loadDir(dirname(target));
  };

  const onDropInto = async (folder: string) => {
    const src = dragSrc;
    setDragSrc(null);
    if (!src || src === folder || dirname(src) === folder) return;
    const res = await api?.wsMove?.(src, folder);
    if (res?.error) onNotice(res.error);
    else {
      loadDir(folder);
      loadDir(dirname(src));
    }
  };

  if (roots === null) {
    return <div className="px-2 py-4 text-[12px] text-muted">Loading…</div>;
  }

  if (!api?.wsRoots) {
    return (
      <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
        The Files workspace needs the desktop app.
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="px-2 py-4 text-[12px] text-muted leading-relaxed">
        <div className="mb-3">
          Organize your markdown in real folders on your Mac. Pick a home for it.
        </div>
        <button
          onClick={createDefault}
          disabled={busy}
          className="w-full text-[12px] py-1.5 mb-1.5 rounded-md bg-accent text-foreground hover:opacity-90 disabled:opacity-50"
        >
          Create {defaultPath.replace(/^.*\/(Documents\/Markie)$/, "~/$1")}
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
            onMenu={() => setMenuFor(menuFor === file.path ? null : file.path)}
            onDragStart={() => setDragSrc(file.path)}
            onRename={() => { setMenuFor(null); setEdit({ kind: "rename", target: file.path, value: file.name }); }}
            onReveal={() => { setMenuFor(null); api.wsReveal(file.path); }}
            onTrash={() => trash(file.path)}
            onCopyPath={async () => { setMenuFor(null); try { await navigator.clipboard.writeText(file.path); onNotice("Path copied."); } catch { onNotice("Couldn't copy."); } }}
          />
        ))}
        {listing.folders.length === 0 && listing.files.length === 0 && depth > 0 && (
          <div style={{ paddingLeft: `${depth * 12 + 20}px` }} className="text-[10.5px] text-muted/60 py-0.5">empty</div>
        )}
      </>
    );
  };

  return (
    <div className="pt-1">
      {roots.map((root) => (
        <div key={root}>
          <div
            className="group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-accent/40 rounded-md"
            onClick={() => toggle(root)}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); onDropInto(root); }}
          >
            <Chevron open={expanded.has(root)} />
            <span className="text-[11px] uppercase tracking-wide text-muted font-medium flex-1 truncate" title={root}>
              {basename(root)}
            </span>
            <button onClick={(e) => { e.stopPropagation(); startNew(root, "new-folder"); }} title="New folder" className="opacity-0 group-hover:opacity-100 text-muted hover:text-foreground text-[13px]">＋</button>
          </div>
          {expanded.has(root) && renderDir(root, 1)}
        </div>
      ))}
      <button onClick={addRoot} className="mt-1.5 ml-2 text-[11px] text-muted hover:text-foreground">+ Add folder</button>
    </div>
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

function Row(props: RowProps) {
  const pad = { paddingLeft: `${props.depth * 12 + 8}px` };
  return (
    <div>
      <div
        style={pad}
        draggable={!props.editing}
        onDragStart={props.onDragStart}
        onDragOver={props.isFolder ? (e) => e.preventDefault() : undefined}
        onDrop={props.isFolder && props.onDrop ? (e) => { e.preventDefault(); props.onDrop!(); } : undefined}
        className={`group flex items-center gap-1.5 pr-2 py-1 rounded-md cursor-pointer ${
          props.active ? "bg-accent" : "hover:bg-accent/40"
        }`}
        onClick={props.editing ? undefined : props.onClick}
      >
        {props.isFolder ? <Chevron open={!!props.isOpen} /> : <span className="w-[11px] shrink-0" />}
        {props.isFolder ? <FolderIcon /> : <FileIcon />}
        {props.editing !== null ? (
          <input
            autoFocus
            value={props.editing}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => props.onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onEditSubmit();
              if (e.key === "Escape") props.onEditCancel();
            }}
            onBlur={props.onEditSubmit}
            className="flex-1 text-[12px] bg-background border border-border rounded px-1 py-0 text-foreground outline-none focus:border-foreground/30"
          />
        ) : (
          <span className="text-[12.5px] text-foreground truncate flex-1" title={props.path}>{props.name}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); props.onMenu(); }}
          className="opacity-0 group-hover:opacity-100 text-muted hover:text-foreground shrink-0"
          aria-label="Actions"
        >
          ⋯
        </button>
      </div>
      {props.menuOpen && (
        <div style={{ paddingLeft: `${props.depth * 12 + 26}px` }} className="flex flex-wrap gap-x-3 gap-y-1 pb-1 text-[11px]">
          {props.isFolder && <button className="text-muted hover:text-foreground" onClick={props.onNewFile}>New file</button>}
          {props.isFolder && <button className="text-muted hover:text-foreground" onClick={props.onNewFolder}>New folder</button>}
          <button className="text-muted hover:text-foreground" onClick={props.onRename}>Rename</button>
          <button className="text-muted hover:text-foreground" onClick={props.onCopyPath}>Copy path</button>
          <button className="text-muted hover:text-foreground" onClick={props.onReveal}>Reveal</button>
          <button className="text-red-400 hover:text-red-300" onClick={props.onTrash}>Trash</button>
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
