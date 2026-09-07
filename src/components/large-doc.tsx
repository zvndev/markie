// Two strips for the document size tiers (src/lib/doc-tiers.ts).
//
// LargeDocStrip sits above a document that opened in Source view because of
// its size. It is a statement, not a decision: there is nothing to click,
// because Rich is simply not available for this file and the mode buttons
// already say so when hovered.
//
// TooLargeStrip is what the user sees when main refused a file. It stays
// until dismissed, since the open that produced it made no other visible
// change, and a message that vanished on its own would leave "nothing
// happened" as the only explanation.
import { largeDocumentNote, tooLargeMessage, type RefusalVerb } from "@/lib/doc-tiers";

export function LargeDocStrip({ size }: { size: number }) {
  return (
    <div
      data-markie-large-doc-strip
      role="status"
      aria-live="polite"
      className="markie-banner shrink-0 flex items-center gap-2 px-3 py-1.5"
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        ≡
      </span>
      <span className="text-[11px] min-w-0 truncate text-muted">{largeDocumentNote(size)}</span>
    </div>
  );
}

interface TooLargeStripProps {
  size: number;
  fileName: string;
  /** What did not happen: an open, a reload of the open document, or a restore into it. */
  verb?: RefusalVerb;
  onDismiss: () => void;
}

export function TooLargeStrip({ size, fileName, verb = "opened", onDismiss }: TooLargeStripProps) {
  return (
    <div
      data-markie-too-large-strip
      role="alert"
      className="markie-banner shrink-0 flex items-center gap-2 px-3 py-1.5"
    >
      <span aria-hidden="true" className="text-[12px] leading-none">
        !
      </span>
      <span className="text-[11px] min-w-0 truncate text-muted">
        <span className="text-foreground">{fileName}</span> was not {verb}. {tooLargeMessage(size)}
      </span>
      <button
        onClick={onDismiss}
        className="markie-overlay-button ml-auto shrink-0 rounded px-2 py-0.5 text-[11px] text-foreground hover:bg-accent/40"
      >
        Dismiss
      </button>
    </div>
  );
}
