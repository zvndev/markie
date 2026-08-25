"use client";

// Both copies of a document changed. The Library used to answer this with three
// unlabelled buttons, one of which ("Take cloud") silently destroyed every local
// line the server never received.
//
// This dialog says what each choice costs, in lines, before it happens, and
// leads with the only option that cannot lose work.

import { useCallback, useEffect, useRef, useState } from "react";
import { getElectronAPI } from "@/lib/electron";
import { lineDiff, describeDiff } from "@/lib/line-diff";

type Stage =
  | { kind: "loading" }
  | { kind: "ready"; summary: string; identical: boolean }
  | { kind: "error"; message: string };

interface ConflictDialogProps {
  filePath: string;
  fileName: string;
  /** The editor buffer, which may be ahead of what is on disk. */
  localContent: string;
  onClose: () => void;
  /** The document now holds this content; the buffer has to follow it. */
  onResolved: (content: string) => void;
  /** Library rows and the update strip re-read their state after this. */
  onChanged: () => void;
}

export function ConflictDialog({
  filePath,
  fileName,
  localContent,
  onClose,
  onResolved,
  onChanged,
}: ConflictDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  // The buffer as it stood when the dialog opened. Keeping it in state rather
  // than reading the prop is what stops a keystroke behind the dialog from
  // re-running the comparison — and from making the line counts the user is
  // reading disagree with the copy "keep both" would actually rescue.
  const [frozenLocal] = useState(localContent);
  // Invalidates a fetch that lands after the dialog closed or the file changed.
  const run = useRef(0);
  const keepBothRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ticket = ++run.current;
    const api = getElectronAPI();
    if (!api?.docRemoteContent) {
      setStage({ kind: "error", message: "Syncing isn't available here." });
      return;
    }
    api
      .docRemoteContent({ path: filePath })
      .then((res) => {
        if (ticket !== run.current) return;
        if (!res.ok || typeof res.content !== "string") {
          setStage({
            kind: "error",
            message: res.error ?? "Couldn't read the server's copy.",
          });
          return;
        }
        const d = lineDiff(frozenLocal, res.content);
        setStage({
          kind: "ready",
          summary: describeDiff(d),
          // The version moved but the text did not, so there is nothing to
          // weigh up: taking the server's copy changes no line.
          identical: d.added === 0 && d.removed === 0,
        });
      })
      .catch(() => {
        if (ticket !== run.current) return;
        setStage({ kind: "error", message: "Couldn't reach the server." });
      });
    const token = run;
    return () => {
      // Invalidate a comparison still in flight for the previous file.
      token.current++;
    };
  }, [filePath, frozenLocal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Return should land on the choice that cannot lose anything, not on the one
  // that overwrites.
  useEffect(() => {
    if (stage.kind === "ready") keepBothRef.current?.focus();
  }, [stage.kind]);

  const act = useCallback(
    async (which: "keep-both" | "overwrite") => {
      const api = getElectronAPI();
      setBusy(true);
      try {
        const res =
          which === "keep-both"
            ? await api?.docKeepBoth?.({ path: filePath, content: frozenLocal })
            : await api?.docResolve?.({ path: filePath, strategy: "cloud" });
        if (!res || res.error) {
          setStage({
            kind: "error",
            message: res?.error ?? "Couldn't finish that.",
          });
          return;
        }
        // The buffer still holds the replaced text; without this the next save
        // pushes it straight back over what was just pulled.
        if (typeof res.content === "string") onResolved(res.content);
        onChanged();
        onClose();
      } catch {
        setStage({ kind: "error", message: "Couldn't reach the server." });
      } finally {
        setBusy(false);
      }
    },
    [filePath, frozenLocal, onResolved, onChanged, onClose]
  );

  return (
    <div
      className="markie-scrim overlay-scrim-enter fixed inset-0 z-[100] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="markie-overlay-panel overlay-panel-enter w-[460px] max-w-[92vw] rounded-xl p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="markie-conflict-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="markie-conflict-title"
            className="text-[14px] font-medium text-foreground"
          >
            Both copies of {fileName} changed
          </h2>
          <button
            className="markie-overlay-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {stage.kind === "loading" && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Comparing with the server…
          </p>
        )}

        {stage.kind === "error" && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--status-red)]">
            {stage.message}
          </p>
        )}

        {stage.kind === "ready" && (
          <>
            <p className="mt-2 text-[12.5px] leading-relaxed text-foreground">
              {stage.summary}
            </p>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">
              {stage.identical
                ? "Nothing of yours would be lost."
                : `Keep both saves your version alongside the original and then pulls the server's copy into ${fileName}.`}
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                className="markie-overlay-button text-[12.5px] px-3 py-1.5 rounded-md text-muted hover:text-foreground disabled:opacity-60"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="markie-overlay-button text-[12.5px] px-3 py-1.5 rounded-md text-muted hover:text-foreground disabled:opacity-60"
                onClick={() => act("overwrite")}
                disabled={busy}
              >
                Pull and overwrite
              </button>
              <button
                ref={keepBothRef}
                className="markie-overlay-button text-[12.5px] px-3 py-1.5 rounded-md bg-accent text-foreground disabled:opacity-60"
                onClick={() => act("keep-both")}
                disabled={busy}
              >
                {busy ? "Working…" : "Keep both"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
