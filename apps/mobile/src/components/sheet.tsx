// A bottom sheet: the phone's way to put a panel over the screen it belongs
// to (comments, sharing, a link). It sits above the keyboard when one is up,
// and a tap on the dimmed screen behind it closes it. It is drawn in the
// screen's stack item (navigator.tsx StackItemContext), over the nav bar too.
import { useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeyboardInset } from "../lib/keyboard-inset";
import { StackItemContext } from "./navigator";

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Beside the title, opposite Done: a count, a toggle. */
  accessory?: ReactNode;
  /** Fills most of the screen rather than fitting its content. */
  tall?: boolean;
  className?: string;
  /** The word on the button that closes it. "Done" unless closing leaves something undecided. */
  closeLabel?: string;
}

export function Sheet({ title, onClose, children, accessory, tall = false, className = "", closeLabel = "Done" }: SheetProps) {
  const keyboard = useKeyboardInset();
  const titleId = useId();
  const layer = useContext(StackItemContext);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Closed by a tap that starts and ends on the dimmed screen. Not on the
  // press itself: the sheet would be gone before the tap's click, and the
  // click would land on whatever was under it (the screen's Edit button).
  // Not on any click either: a drag that starts inside the sheet and ends
  // outside clicks the backdrop too.
  const pressedBackdrop = useRef(false);
  const sheet = (
    <div
      className="m-sheet-scrim"
      onPointerDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        const close = pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (close) onClose();
      }}
    >
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
          <button type="button" className="m-nav-text m-nav-text-strong" onClick={onClose}>{closeLabel}</button>
        </header>
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>
  );
  return layer ? createPortal(sheet, layer) : sheet;
}
