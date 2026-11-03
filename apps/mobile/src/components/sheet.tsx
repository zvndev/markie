// A bottom sheet: the phone's way to put a panel over the screen it belongs
// to (comments, sharing, a link). It sits above the keyboard when one is up,
// and a tap on the dimmed screen behind it closes it.
import { useEffect, useId, type ReactNode } from "react";
import { useKeyboardInset } from "../lib/keyboard-inset";

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Beside the title, opposite Done: a count, a toggle. */
  accessory?: ReactNode;
  /** Fills most of the screen rather than fitting its content. */
  tall?: boolean;
  className?: string;
}

export function Sheet({ title, onClose, children, accessory, tall = false, className = "" }: SheetProps) {
  const keyboard = useKeyboardInset();
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="m-sheet-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`m-sheet${tall ? " is-tall" : ""} ${className}`}
        style={keyboard ? { marginBottom: keyboard, maxHeight: `calc(100% - ${keyboard}px - var(--sat) - 24px)` } : undefined}
      >
        <span className="m-sheet-grabber" aria-hidden="true" />
        <header className="m-sheet-head">
          <h2 id={titleId}>{title}</h2>
          {accessory}
          <button type="button" className="m-nav-text m-nav-text-strong" onClick={onClose}>Done</button>
        </header>
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>
  );
}
