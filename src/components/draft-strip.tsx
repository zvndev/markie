"use client";

import { relativeTime } from "@/lib/relative-time";

export function DraftStrip({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      data-markie-draft-strip
      className="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-foreground flex items-center gap-2"
    >
      <span className="min-w-0 flex-1">
        Markie recovered unsaved changes from {relativeTime(savedAt)}.
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="h-6 px-2 rounded-md border border-border hover:bg-accent/40 text-[11.5px]"
      >
        Restore
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className="h-6 px-2 rounded-md text-muted hover:text-foreground text-[11.5px]"
      >
        Discard
      </button>
    </div>
  );
}
