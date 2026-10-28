import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";

// A context menu for one row: opened from the row's "..." button or by
// right-clicking the row. It is portalled to <body> and positioned fixed,
// because the Library list scrolls and would clip an absolutely positioned
// popover at its edge.

export interface FileMenuEntry {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  tone?: "default" | "accent" | "danger";
  // Draws a separator above this entry.
  separated?: boolean;
}

export interface FileMenuAnchor {
  x: number;
  y: number;
  // The element focus goes back to when the menu closes from the keyboard.
  returnFocus?: HTMLElement | null;
}

const EDGE = 8;

export function FileMenu({
  label,
  anchor,
  entries,
  onClose,
}: {
  label: string;
  anchor: FileMenuAnchor;
  entries: FileMenuEntry[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  const close = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) anchor.returnFocus?.focus();
  };

  useDismissibleLayer(true, menu, () => close(false));

  // Keep the whole menu on screen: flip left of the anchor when it would run
  // off the right edge, and above it when it would run off the bottom.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = anchor.x, top = anchor.y;
    if (left + width > vw - EDGE) left = Math.max(EDGE, anchor.x - width);
    if (top + height > vh - EDGE) top = Math.max(EDGE, vh - height - EDGE);
    setPosition({ left, top });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
      : event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : -1;
    if (next >= 0) {
      event.preventDefault();
      buttons[next]?.focus();
    }
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      onKeyDown={keys}
      // React events bubble through the portal to the row underneath; a click
      // in the menu must not also open the file.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{ left: position.left, top: position.top }}
      className="markie-file-menu markie-menu-panel overlay-popover-enter fixed z-[120] min-w-[184px] max-w-[260px] rounded-[10px] p-1"
    >
      {entries.map((entry) => (
        <div key={entry.key}>
          {entry.separated ? <div role="separator" className="markie-file-menu-separator" /> : null}
          <button
            type="button"
            role="menuitem"
            data-tone={entry.tone ?? "default"}
            onClick={() => {
              close(true);
              entry.onSelect();
            }}
            className="markie-file-menu-item"
          >
            <span aria-hidden="true" className="markie-file-menu-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{entry.icon}</svg>
            </span>
            <span className="truncate">{entry.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

// Icon paths, drawn on a 24px grid at stroke 1.8 like the rest of the app.
export const MENU_ICONS = {
  link: <><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></>,
  path: <><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></>,
  retry: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4h-4" /></>,
  upload: <><path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z" /><path d="M12 15.5v-5M9.8 12.6 12 10.4l2.2 2.2" /></>,
  download: <><path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z" /><path d="M12 10v5M9.8 12.8 12 15l2.2-2.2" /></>,
  review: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 16.8v.2" /></>,
  people: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="10" r="2.3" /><path d="M16 14.6a4.5 4.5 0 0 1 5 4.4" /></>,
  cloudOff: <><path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.55-1.4A4.25 4.25 0 0 1 17.5 18z" /><path d="M4 4l16 16" /></>,
  trash: <><path d="M4 7h16" /><path d="M9.5 7V4.5h5V7" /><path d="M6 7l1 12.5h10L18 7" /><path d="M10 11v5M14 11v5" /></>,
  remove: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12h7" /></>,
} as const;
