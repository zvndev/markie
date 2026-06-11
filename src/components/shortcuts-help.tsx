"use client";

import { useEffect } from "react";
import type { AppCommand } from "@/lib/commands";

interface ShortcutsHelpProps {
  commands: AppCommand[];
  onClose: () => void;
}

export function ShortcutsHelp({ commands, onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const groups = new Map<string, AppCommand[]>();
  for (const c of commands) {
    if (!c.shortcut) continue;
    const list = groups.get(c.group) ?? [];
    list.push(c);
    groups.set(c.group, list);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-xl border border-border shadow-2xl p-5"
        style={{ background: "var(--surface-2)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[14px] font-semibold text-foreground">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            aria-label="Close shortcuts"
            className="text-muted hover:text-foreground"
          >
            ×
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-4">
          {[...groups.entries()].map(([group, cmds]) => (
            <div key={group}>
              <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
                {group}
              </div>
              {cmds.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between py-0.5 text-[12px]"
                >
                  <span className="text-foreground/80">{c.title}</span>
                  <span className="text-muted tabular-nums">{c.shortcut}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
