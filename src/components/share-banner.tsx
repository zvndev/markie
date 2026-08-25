"use client";

import type { ShareBannerView } from "@/lib/share-role";

interface ShareBannerProps {
  view: ShareBannerView | null;
  // A copy that could not be written, a save that reshaped the file. It gets a
  // row of its own under the role line — the reason the document is read-only
  // is still true while the failure is on screen, and hiding it left people
  // reading an error with no idea why they could not simply type. There is no
  // toast system yet.
  error?: string | null;
  // Clears the error row only. Without it a one-off failure sat on the banner
  // for the rest of the session.
  onDismissError?: () => void;
  onMakeCopy: () => void;
}

// The strip above the document that explains why typing does nothing. Not a
// modal, not dismissible: it has to be true for as long as the state it
// describes is true.
export function ShareBanner({
  view,
  error,
  onDismissError,
  onMakeCopy,
}: ShareBannerProps) {
  if (!view && !error) return null;
  return (
    <div
      data-markie-share-banner
      // Announced rather than only drawn: the reason the document is locked has
      // to reach someone who is not looking at the strip.
      role="status"
      aria-live="polite"
      className="markie-banner shrink-0 flex flex-col gap-1 px-3 py-1.5"
    >
      {view && (
        <div className="flex items-center gap-2">
          {view.kind === "view-only" && (
            <span aria-hidden="true" className="text-[12px] leading-none">
              👁
            </span>
          )}
          <span className="text-[11px] min-w-0 truncate text-muted">
            {view.message}
          </span>
          {view.kind === "view-only" && (
            <button
              type="button"
              onClick={onMakeCopy}
              className="markie-overlay-button ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-foreground"
            >
              Make a copy
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2">
          {/* Not truncated: a failure explains itself in a sentence, and half a
              sentence with an ellipsis is not an explanation. Two lines. */}
          <span className="text-[11px] leading-snug min-w-0 line-clamp-2 text-[color:var(--status-red)]">
            {error}
          </span>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss"
              className="markie-overlay-button ml-auto shrink-0 rounded border border-border px-1.5 leading-none text-[12px] text-muted hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface UpdateStripProps {
  // "clean": nothing local is at risk, so one button finishes it.
  // "dirty": pulling would replace local work, so the button opens the dialog.
  kind: "clean" | "dirty";
  busy: boolean;
  error: string | null;
  onUpdate: () => void;
  onReview: () => void;
}

// Someone else (or another machine) moved this document on. Shown above the
// document rather than as a dialog: an update that cannot lose anything does
// not deserve a modal, and modals people dismiss unread are worse than none.
export function UpdateStrip({
  kind,
  busy,
  error,
  onUpdate,
  onReview,
}: UpdateStripProps) {
  const clean = kind === "clean";
  return (
    <div
      data-markie-update-strip
      role="status"
      aria-live="polite"
      className="markie-banner shrink-0 flex items-center gap-2 px-3 py-1.5"
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        ↓
      </span>
      <span
        className={`text-[11px] min-w-0 truncate ${
          error ? "text-[color:var(--status-red)]" : "text-muted"
        }`}
      >
        {error ??
          (clean
            ? "Updated on the server."
            : // Deliberately not "unsaved changes": a file whose push was
              // rejected has changes of its own with nothing unsaved on screen.
              "Updated on the server, and this copy has changes of its own.")}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={clean ? onUpdate : onReview}
        className="markie-overlay-button ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
      >
        {busy ? "Updating…" : clean ? "Update" : "Review changes…"}
      </button>
    </div>
  );
}

// The rich pane owns the shared document while a session is live: it is the one
// bound to the Yjs doc, so the source pane is a read-only mirror of it.
export function LiveSourceBanner() {
  return (
    <div
      role="status"
      className="markie-banner shrink-0 px-3 py-1 text-[11px] text-muted"
    >
      Live session. Edit in Rich.
    </div>
  );
}
