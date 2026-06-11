"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import type { PDFTheme } from "@/lib/pdf-styles";
import { getElectronAPI } from "@/lib/electron";
import { initials, type PeerUser } from "@/lib/collab";

type ViewMode = "edit" | "preview" | "split";

interface ToolbarProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onOpenFile: () => void;
  onExportPDF: (theme: PDFTheme) => void;
  fileName: string | null;
  isDirty: boolean;
  canRename: boolean;
  onRename: (newName: string) => void;
  // Cloud-synced docs get a Share button; live docs add presence
  onShare?: (() => void) | null;
  live?: boolean;
  liveStatus?: "connecting" | "connected" | "disconnected";
  peers?: PeerUser[];
}

export function Toolbar({
  mode,
  onModeChange,
  onOpenFile,
  onExportPDF,
  fileName,
  isDirty,
  canRename,
  onRename,
  onShare,
  live = false,
  liveStatus = "disconnected",
  peers = [],
}: ToolbarProps) {
  const [showPDFMenu, setShowPDFMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  // Clear the macOS window buttons (hiddenInset traffic lights at x:14).
  // useSyncExternalStore reads the never-changing platform hydration-safely.
  const trafficLightPad = useSyncExternalStore(
    () => () => {},
    () => getElectronAPI()?.platform === "darwin",
    () => false
  );

  useEffect(() => {
    if (!showPDFMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowPDFMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPDFMenu]);

  return (
    <div
      className={`h-11 border-b border-border bg-surface flex items-center justify-between pr-4 select-none shrink-0 ${
        trafficLightPad ? "pl-[84px]" : "pl-4"
      }`}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Left: App name + file + export */}
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <span className="text-[13px] font-semibold tracking-tight text-foreground/90">
          Markie
        </span>
        <div className="w-px h-4 bg-border" />
        <button
          onClick={onOpenFile}
          className="text-[12px] text-muted hover:text-foreground transition-colors flex items-center gap-1.5"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          {fileName ? "Open" : "Open file…"}
        </button>
        {fileName &&
          (renaming ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onRename(draftName);
                  setRenaming(false);
                } else if (e.key === "Escape") {
                  setRenaming(false);
                }
              }}
              className="text-[12px] bg-background border border-border rounded px-1.5 py-0.5 w-44 text-foreground outline-none"
            />
          ) : (
            <button
              onClick={() => {
                if (!canRename) return;
                setDraftName(fileName);
                setRenaming(true);
              }}
              title={canRename ? "Click to rename" : undefined}
              className="text-[12px] text-foreground/80 hover:text-foreground transition-colors"
            >
              {fileName}
              {isDirty && <span className="text-muted ml-1.5">•</span>}
            </button>
          ))}
        <div className="w-px h-4 bg-border" />
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowPDFMenu(!showPDFMenu)}
            className="text-[12px] text-muted hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <polyline points="9 15 12 18 15 15" />
            </svg>
            PDF
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showPDFMenu && (
            <div className="absolute top-full left-0 mt-1.5 bg-surface-2 border border-border rounded-lg shadow-xl py-1 min-w-[140px] z-50"
              style={{ background: "#1c1c20" }}
            >
              <button
                onClick={() => { onExportPDF("dark"); setShowPDFMenu(false); }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-muted hover:text-foreground hover:bg-accent/50 transition-colors flex items-center gap-2"
              >
                <span className="w-3 h-3 rounded-sm bg-zinc-800 border border-zinc-600 shrink-0" />
                Export Dark
              </button>
              <button
                onClick={() => { onExportPDF("light"); setShowPDFMenu(false); }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-muted hover:text-foreground hover:bg-accent/50 transition-colors flex items-center gap-2"
              >
                <span className="w-3 h-3 rounded-sm bg-white border border-zinc-300 shrink-0" />
                Export Light
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Center: Mode toggle — View is primary, Edit/Split are icons */}
      <div
        className="flex items-center bg-background rounded-md p-0.5 gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={() => onModeChange("preview")}
          title="View (⌘1)"
          className={`px-3 py-1 text-[11px] font-medium rounded transition-all ${
            mode === "preview"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          View
        </button>
        <button
          onClick={() => onModeChange("edit")}
          title="Edit (⌘2)"
          aria-label="Edit mode"
          className={`px-2 py-1 rounded transition-all ${
            mode === "edit"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </button>
        <button
          onClick={() => onModeChange("split")}
          title="Split (⌘3)"
          aria-label="Split mode"
          className={`px-2 py-1 rounded transition-all ${
            mode === "split"
              ? "bg-accent text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        </button>
      </div>

      {/* Right: presence + share (stats moved to the menu bar) */}
      <div
        className="w-44 flex items-center justify-end gap-2.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {live && (
          <div className="flex items-center gap-1.5" title={`Live session: ${liveStatus}`}>
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                liveStatus === "connected"
                  ? "bg-emerald-400"
                  : liveStatus === "connecting"
                    ? "bg-amber-400"
                    : "bg-zinc-500"
              }`}
            />
            <span className="text-[10px] uppercase tracking-wide text-muted">
              Live
            </span>
          </div>
        )}
        {peers.length > 0 && (
          <div className="flex -space-x-1.5">
            {peers.slice(0, 4).map((p, i) => (
              <span
                key={`${p.name}-${i}`}
                title={p.name}
                className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-semibold text-black/80 ring-2 ring-surface"
                style={{ background: p.color }}
              >
                {initials(p.name)}
              </span>
            ))}
            {peers.length > 4 && (
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-semibold bg-accent text-foreground ring-2 ring-surface">
                +{peers.length - 4}
              </span>
            )}
          </div>
        )}
        {onShare && (
          <button
            onClick={onShare}
            className="text-[12px] text-muted hover:text-foreground transition-colors flex items-center gap-1.5"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            Share
          </button>
        )}
      </div>
    </div>
  );
}
