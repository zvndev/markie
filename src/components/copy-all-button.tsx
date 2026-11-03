import { useEffect, useRef, useState } from "react";

// The toolbar's "Copy all" button: copies the whole document as it is stored,
// raw Markdown for a Markdown file and the text itself for a plain-text one.
//
// Self-contained on purpose. It needs nothing from the desktop shell (no
// Electron bridge, no page state), only the text, so the web app can put the
// same button in its own toolbar. `read` lets a host hand over the freshest
// text at the moment of the click (the desktop flushes the rich pane's
// debounce there); without it the button copies `text`.
const COPIED_MS = 1500;

export interface CopyAllButtonProps {
  /** The document as it stands. Empty means there is nothing to copy. */
  text: string;
  /** Optional: read the latest text at click time instead of `text`. */
  read?: () => string;
}

export function CopyAllButton({ text, read }: CopyAllButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const empty = text.length === 0;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(read ? read() : text);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  const label = empty ? "Nothing to copy" : state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy all";
  return (
    <>
      <button
        type="button"
        data-markie-copy-all
        data-state={state}
        disabled={empty}
        onClick={() => void copy()}
        title={label}
        aria-label={empty ? "Copy all" : label}
        className={`markie-toolbar-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md disabled:opacity-40 ${
          state === "copied" ? "text-[var(--status-green)]" : state === "failed" ? "text-[var(--status-red)]" : "text-muted hover:text-foreground"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {state === "copied"
            ? <path d="m5 12.5 4.5 4.5L19 7.5" />
            : <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>}
        </svg>
      </button>
      <span role="status" className="sr-only">{state === "copied" ? "Document copied" : state === "failed" ? "Couldn't copy the document" : ""}</span>
    </>
  );
}
