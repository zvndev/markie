"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import type { PDFTheme } from "@/lib/pdf-styles";
import { getElectronAPI } from "@/lib/electron";
import { initials, type PeerUser } from "@/lib/collab";
import { getColorMode, applyColorMode, type ColorMode } from "@/lib/color-mode";

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
  // Share lives in the top bar now; always shown. onShare handles both the
  // shareable and the "sign in / sync first" cases. canShare drives styling.
  onShare: () => void;
  canShare?: boolean;
  // Open the theme-presets dialog (palette button next to the mode switch).
  onThemePresets: () => void;
  live?: boolean;
  liveStatus?: "connecting" | "connected" | "disconnected";
  peers?: PeerUser[];
  // The doc owner pinned their theme; the local theme choice is paused
  themeLocked?: boolean;
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
  canShare = false,
  onThemePresets,
  live = false,
  liveStatus = "disconnected",
  peers = [],
  themeLocked = false,
}: ToolbarProps) {
  const [showPDFMenu, setShowPDFMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [colorMode, setColorMode] = useState<ColorMode>(() => getColorMode());
  const menuRef = useRef<HTMLDivElement>(null);

  const pickColorMode = (m: ColorMode) => {
    setColorMode(m);
    applyColorMode(m);
  };

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

      {/* Right: theme/mode + presence + share */}
      <div
        className="flex items-center justify-end gap-2"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {themeLocked && (
          <div
            className="flex items-center gap-1 text-muted"
            title="The owner pinned their theme to this doc"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span className="text-[10px] uppercase tracking-wide">Owner theme</span>
          </div>
        )}
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
        {/* Color mode: System / Light / Dark */}
        <div className="flex items-center bg-background rounded-md p-0.5 gap-0.5">
          <ModeBtn label="System theme" active={colorMode === "system"} onClick={() => pickColorMode("system")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
            </svg>
          </ModeBtn>
          <ModeBtn label="Light theme" active={colorMode === "light"} onClick={() => pickColorMode("light")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </ModeBtn>
          <ModeBtn label="Dark theme" active={colorMode === "dark"} onClick={() => pickColorMode("dark")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
            </svg>
          </ModeBtn>
        </div>
        <button
          onClick={onThemePresets}
          title="Theme presets"
          aria-label="Theme presets"
          className="p-1 rounded text-muted hover:text-foreground transition-colors"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="13.5" cy="6.5" r="1.5" /><circle cx="17.5" cy="10.5" r="1.5" /><circle cx="8.5" cy="7.5" r="1.5" /><circle cx="6.5" cy="12.5" r="1.5" />
            <path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 11c0-4.97-4.48-9-10-9z" />
          </svg>
        </button>
        <div className="w-px h-4 bg-border" />
        <button
          onClick={onShare}
          title={canShare ? "Share this document" : "Share — sign in and sync this file first"}
          className={`text-[12px] transition-colors flex items-center gap-1.5 ${
            canShare ? "text-foreground hover:opacity-80" : "text-muted hover:text-foreground"
          }`}
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
      </div>
    </div>
  );
}

function ModeBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`px-1.5 py-1 rounded transition-all ${
        active ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
