"use client";

import { useEffect, useState } from "react";
import { authClient, type MarkieUser } from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";
import {
  getColorMode,
  applyColorMode,
  type ColorMode,
} from "@/lib/color-mode";

interface ActivityBarProps {
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  onOpenFile: () => void;
  onShortcuts: () => void;
  onThemePresets: () => void;
  onAccount: () => void;
  // bumps when auth changes elsewhere (deep-link sign-in, sign-out)
  authNonce: number;
}

export function ActivityBar({
  libraryOpen,
  onToggleLibrary,
  onOpenFile,
  onShortcuts,
  onThemePresets,
  onAccount,
  authNonce,
}: ActivityBarProps) {
  const [user, setUser] = useState<MarkieUser | null>(null);
  const [mode, setMode] = useState<ColorMode>(() => getColorMode());

  useEffect(() => {
    let alive = true;
    authClient.me().then((u) => {
      if (alive) setUser(u);
    });
    return () => {
      alive = false;
    };
  }, [authNonce]);

  const pickMode = (m: ColorMode) => {
    setMode(m);
    applyColorMode(m);
  };

  return (
    <div className="w-[52px] shrink-0 h-full flex flex-col items-center py-2 gap-1 border-r border-border bg-surface">
      <IconButton label="Library (⌘L)" active={libraryOpen} onClick={onToggleLibrary}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </IconButton>
      <IconButton label="Open file (⌘O)" onClick={onOpenFile}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z" />
          <polyline points="13 3 13 10 20 10" />
        </svg>
      </IconButton>

      <div className="flex-1" />

      {/* Color mode: System / Light / Dark */}
      <div className="flex flex-col items-center gap-0.5 mb-1 p-0.5 rounded-lg bg-background/60">
        <ModeButton label="System theme" active={mode === "system"} onClick={() => pickMode("system")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
        </ModeButton>
        <ModeButton label="Light theme" active={mode === "light"} onClick={() => pickMode("light")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        </ModeButton>
        <ModeButton label="Dark theme" active={mode === "dark"} onClick={() => pickMode("dark")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
          </svg>
        </ModeButton>
      </div>

      <IconButton label="Theme presets" onClick={onThemePresets}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13.5" cy="6.5" r="1.5" /><circle cx="17.5" cy="10.5" r="1.5" /><circle cx="8.5" cy="7.5" r="1.5" /><circle cx="6.5" cy="12.5" r="1.5" />
          <path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 11c0-4.97-4.48-9-10-9z" />
        </svg>
      </IconButton>
      <IconButton label="Keyboard shortcuts (⌘/)" onClick={onShortcuts}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6" />
        </svg>
      </IconButton>

      <button
        onClick={onAccount}
        title={user ? `${user.name || user.email} — Account` : "Sign in"}
        aria-label={user ? "Account" : "Sign in"}
        className="mt-0.5 w-9 h-9 rounded-full flex items-center justify-center hover:opacity-90 transition-opacity"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {user ? (
          <span className="relative w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold text-black/80" style={{ background: colorForName(user.name || user.email) }}>
            {initials(user.name || user.email)}
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-surface" />
          </span>
        ) : (
          <span className="w-7 h-7 rounded-full border border-border flex items-center justify-center text-muted">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
            </svg>
          </span>
        )}
      </button>
    </div>
  );
}

function IconButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {children}
    </button>
  );
}

function ModeButton({
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
      className={`w-8 h-7 rounded-md flex items-center justify-center transition-colors ${
        active ? "bg-accent text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
