import { useEffect, useRef, useState } from "react";

// A small button in the top-right corner of the document area that copies the
// whole document as it is stored: raw Markdown for a Markdown file, the text
// itself for a plain-text one. It stays out of the way until the pointer is
// over the document (see .markie-copy-all in globals.css).
const COPIED_MS = 1500;

export function CopyAllButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };

  const label = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy all";
  return (
    <>
    <button
      type="button"
      data-markie-copy-all
      data-copied={state === "copied" ? "true" : undefined}
      onClick={() => void copy()}
      title="Copy the whole document"
      aria-label={state === "idle" ? "Copy all" : label}
      className="markie-copy-all"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {state === "copied"
          ? <path d="m5 12.5 4.5 4.5L19 7.5" />
          : <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>}
      </svg>
      <span>{label}</span>
    </button>
    <span role="status" className="sr-only">{state === "copied" ? "Document copied" : ""}</span>
    </>
  );
}
