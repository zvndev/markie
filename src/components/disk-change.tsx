"use client";

// Something else edited the file you have open.
//
// Two surfaces, split by what is actually at stake. With an unmodified buffer,
// reloading cannot destroy anything, so it is a strip you can ignore. With
// unsaved work it is a real decision, so it is a dialog — and one that leads
// with the answer that loses nothing, because the other two both destroy
// somebody's writing.

import { useEffect, useState } from "react";
import { copyNameFor, describeDiskChange } from "@/lib/disk-change";

interface DiskChangeStripProps {
  fileName: string;
  onReload: () => void;
}

/** Nothing local is at risk: one button finishes it. */
export function DiskChangeStrip({ fileName, onReload }: DiskChangeStripProps) {
  return (
    <div
      data-markie-disk-strip
      role="status"
      aria-live="polite"
      className="markie-banner shrink-0 flex items-center gap-2 px-3 py-1.5"
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        ↻
      </span>
      <span className="text-[11px] min-w-0 truncate text-muted">
        {fileName} changed on disk.
      </span>
      <button
        onClick={onReload}
        className="markie-overlay-button ml-auto shrink-0 rounded px-2 py-0.5 text-[11px] text-foreground hover:bg-accent/40"
      >
        Reload
      </button>
    </div>
  );
}

interface DiskConflictDialogProps {
  fileName: string;
  /** The editor buffer, which is ahead of what was on disk when we read it. */
  localContent: string;
  /** What is on disk now. */
  diskContent: string;
  onClose: () => void;
  /** Keep both: save the buffer under a new name, leaving the file alone. */
  onSaveCopy: (suggestedName: string) => void;
  /** Write the buffer over the file, discarding whatever changed it. */
  onOverwrite: () => void;
  /** Take the file and lose the unsaved buffer. */
  onDiscardMine: () => void;
}

export function DiskConflictDialog({
  fileName,
  localContent,
  diskContent,
  onClose,
  onSaveCopy,
  onOverwrite,
  onDiscardMine,
}: DiskConflictDialogProps) {
  const [confirming, setConfirming] = useState<"overwrite" | "discard" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const summary = describeDiskChange(localContent, diskContent);

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[480px] max-w-[92vw] rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-disk-conflict-title"
      >
        <h2
          id="markie-disk-conflict-title"
          className="text-[14px] font-medium text-foreground"
        >
          {fileName} changed on disk
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Something else edited this file while you had unsaved changes, most likely an
          agent, another editor, or a sync client. {summary}
        </p>

        <div className="mt-4 space-y-2">
          {/* First, and the only one that destroys nothing. */}
          <Choice
            label="Save a copy…"
            detail="Keeps both. Your version is saved under a new name and the file on disk is left alone."
            primary
            onClick={() => onSaveCopy(copyNameFor(fileName))}
          />
          <Choice
            label={confirming === "overwrite" ? "Yes, overwrite the file" : "Overwrite the file"}
            detail={
              confirming === "overwrite"
                ? "The changes made on disk will be gone."
                : "Writes your version over the file, discarding what changed it."
            }
            destructive
            onClick={() =>
              confirming === "overwrite" ? onOverwrite() : setConfirming("overwrite")
            }
          />
          <Choice
            label={confirming === "discard" ? "Yes, discard my changes" : "Discard my changes"}
            detail={
              confirming === "discard"
                ? "Your unsaved edits will be gone."
                : "Loads the file from disk and throws away what you have typed."
            }
            destructive
            onClick={() =>
              confirming === "discard" ? onDiscardMine() : setConfirming("discard")
            }
          />
        </div>

        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="text-[11px] text-muted hover:text-foreground">
            Decide later
          </button>
        </div>
      </div>
    </div>
  );
}

function Choice({
  label,
  detail,
  onClick,
  primary,
  destructive,
}: {
  label: string;
  detail: string;
  onClick: () => void;
  primary?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`markie-overlay-button w-full rounded-md border px-3 py-2 text-left ${
        primary
          ? "border-foreground/30 bg-accent"
          : "border-border hover:bg-accent/40"
      }`}
    >
      <span
        className={`block text-[12.5px] ${
          destructive ? "text-[color:var(--status-red)]" : "text-foreground"
        }`}
      >
        {label}
      </span>
      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{detail}</span>
    </button>
  );
}
