"use client";

import { useEffect } from "react";
import { computeStats } from "@/lib/stats";

interface StatsPanelProps {
  content: string;
  onClose: () => void;
}

export function StatsPanel({ content, onClose }: StatsPanelProps) {
  const stats = computeStats(content);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: Array<[string, string]> = [
    ["Words", stats.words.toLocaleString()],
    ["Characters", stats.chars.toLocaleString()],
    ["Characters (no spaces)", stats.charsNoSpaces.toLocaleString()],
    ["Lines", stats.lines.toLocaleString()],
    ["Headings", stats.headings.toLocaleString()],
    ["Code blocks", stats.codeBlocks.toLocaleString()],
    ["Links", stats.links.toLocaleString()],
    ["Reading time", stats.readingTimeMin ? `${stats.readingTimeMin} min` : "—"],
  ];

  return (
    <div
      className="absolute top-12 right-4 z-50 w-60 bg-surface-2 border border-border rounded-lg shadow-xl py-2"
      style={{ background: "#1c1c20" }}
    >
      <div className="flex items-center justify-between px-3 pb-1.5 border-b border-border">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Statistics
        </span>
        <button
          onClick={onClose}
          aria-label="Close statistics"
          className="text-muted hover:text-foreground text-[13px] leading-none"
        >
          ×
        </button>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between px-3 py-1">
          <span className="text-[12px] text-muted">{label}</span>
          <span className="text-[12px] text-foreground tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}
