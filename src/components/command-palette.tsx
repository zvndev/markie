"use client";

import { useEffect, useRef, useState } from "react";
import { filterCommands, type AppCommand } from "@/lib/commands";

interface CommandPaletteProps {
  commands: AppCommand[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = filterCommands(commands, query);
  const clamped = Math.min(selected, Math.max(0, results.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped, query]);

  const runCommand = (command: AppCommand) => {
    onClose();
    // run after the palette unmounts so focus returns to the editor first
    setTimeout(() => command.run(), 0);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-24 bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[480px] max-w-[90vw] rounded-xl border border-border shadow-2xl overflow-hidden"
        style={{ background: "var(--surface-2)" }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && results[clamped]) {
              e.preventDefault();
              runCommand(results[clamped]);
            }
          }}
          placeholder="Type a command…"
          className="w-full bg-transparent px-4 py-3 text-[14px] text-foreground outline-none border-b border-border"
        />
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-4 py-3 text-[12px] text-muted">No commands match</div>
          )}
          {results.map((c, i) => (
            <button
              key={c.id}
              data-selected={i === clamped}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runCommand(c)}
              className={`w-full flex items-center justify-between px-4 py-2 text-left text-[13px] transition-colors ${
                i === clamped ? "bg-accent text-foreground" : "text-muted"
              }`}
            >
              <span>
                <span className="text-[10px] uppercase tracking-wide opacity-50 mr-2">
                  {c.group}
                </span>
                {c.title}
              </span>
              {c.shortcut && (
                <span className="text-[11px] opacity-60 tabular-nums">{c.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
