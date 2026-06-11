"use client";

import { useState, useRef, useEffect, useSyncExternalStore } from "react";
import type { PDFTheme } from "@/lib/pdf-styles";
import { getElectronAPI } from "@/lib/electron";

type ViewMode = "edit" | "preview" | "split";

interface ToolbarProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  onOpenFile: () => void;
  onExportPDF: (theme: PDFTheme) => void;
  fileName: string | null;
}

export function Toolbar({
  mode,
  onModeChange,
  onOpenFile,
  onExportPDF,
  fileName,
}: ToolbarProps) {
  const [showPDFMenu, setShowPDFMenu] = useState(false);
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
          {fileName || "Open file…"}
        </button>
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

      {/* Right: spacer (stats moved to the menu bar) */}
      <div className="w-24" aria-hidden="true" />
    </div>
  );
}
