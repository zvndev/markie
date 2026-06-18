"use client";

import { useEffect, useState } from "react";
import { authClient, type MarkieUser } from "@/lib/auth-client";
import { colorForName, initials } from "@/lib/collab";

export type LeftView = "library" | "browse" | "shared" | "skills";

interface ActivityBarProps {
  // which side-panel view is selected, and whether the panel is open
  activeView: LeftView;
  panelOpen: boolean;
  onSelectView: (v: LeftView) => void;
  onNewFile: () => void;
  onAgents: () => void;
  onShortcuts: () => void;
  onAccount: () => void;
  // bumps when auth changes elsewhere (deep-link sign-in, sign-out)
  authNonce: number;
}

export function ActivityBar({
  activeView,
  panelOpen,
  onSelectView,
  onNewFile,
  onAgents,
  onShortcuts,
  onAccount,
  authNonce,
}: ActivityBarProps) {
  const [user, setUser] = useState<MarkieUser | null>(null);

  useEffect(() => {
    let alive = true;
    authClient.me().then((u) => {
      if (alive) setUser(u);
    });
    return () => {
      alive = false;
    };
  }, [authNonce]);

  const isActive = (v: LeftView) => panelOpen && activeView === v;

  return (
    <div className="w-[52px] shrink-0 h-full flex flex-col items-center py-2 gap-1 border-r border-border bg-surface">
      {/* New file — primary action, set apart by a divider */}
      <NavButton label="New file (⌘N)" onClick={onNewFile}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6M12 12v6M9 15h6" />
        </svg>
      </NavButton>
      <div className="w-7 h-px bg-border my-1" />

      <NavButton label="Library — recent & files (⌘L)" active={isActive("library")} onClick={() => onSelectView("library")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </NavButton>
      <NavButton label="Browse all markdown" active={isActive("browse")} onClick={() => onSelectView("browse")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <polygon points="15.5 8.5 10.5 10.5 8.5 15.5 13.5 13.5" />
        </svg>
      </NavButton>
      <NavButton label="Shared with you" active={isActive("shared")} onClick={() => onSelectView("shared")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </NavButton>
      <NavButton label="Skills & agent files" active={isActive("skills")} onClick={() => onSelectView("skills")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
          <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z" />
        </svg>
      </NavButton>

      <div className="flex-1" />

      <IconButton label="Connect an agent (MCP)" onClick={onAgents}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="8" width="14" height="11" rx="2.5" />
          <path d="M12 8V4M9 4h6" />
          <circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none" />
          <path d="M2 12v3M22 12v3" />
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

// A selectable side-panel view icon (shows an active rail state).
function NavButton({
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
      className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
        active
          ? "bg-accent text-foreground"
          : "text-muted hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {active && <span className="absolute left-[-8px] top-1.5 bottom-1.5 w-0.5 rounded-full bg-foreground" />}
      {children}
    </button>
  );
}

// A plain action icon (no active state).
function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-muted hover:text-foreground hover:bg-accent/40"
    >
      {children}
    </button>
  );
}
