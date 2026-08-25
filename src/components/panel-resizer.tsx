"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_STEP,
  LEFT_PANEL_STEP_LARGE,
  clampPanelWidth,
  maxPanelWidth,
  nudgePanelWidth,
  resizePanelWidth,
} from "@/lib/panel-width";

interface PanelResizerProps {
  width: number;
  // live width while dragging — cheap, unpersisted
  onWidth: (width: number) => void;
  // the width worth remembering: end of a drag, a reset, a keyboard step
  onCommit: (width: number) => void;
}

// The window width the clamp is measured against. Read lazily so a server
// render (static export) never touches `window`.
function viewport(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

// A 7px grab strip straddling the panel's right border. It sits outside the
// panel's own padding (right:-3px) so the target is forgiving without stealing
// clicks from the rows underneath.
export function PanelResizer({ width, onWidth, onCommit }: PanelResizerProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // aria-valuemax has to follow the window, not just the panel.
  const [vw, setVw] = useState(() => viewport());

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const endDrag = useCallback((el: Element | null, pointerId: number) => {
    dragRef.current = null;
    setDragging(false);
    document.documentElement.classList.remove("markie-resizing");
    try {
      (el as HTMLElement | null)?.releasePointerCapture?.(pointerId);
    } catch {
      // the pointer was already released (cancel, window blur)
    }
  }, []);

  // Unmounting mid-drag (the panel closes under the pointer) never fires
  // pointerup, so the grab cursor stayed clamped over the whole app until the
  // next drag. Nothing else removes this class.
  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      dragRef.current = null;
      document.documentElement.classList.remove("markie-resizing");
      if (!drag) return;
      try {
        document
          .querySelector("[data-left-panel-resizer]")
          ?.releasePointerCapture?.(drag.pointerId);
      } catch {
        // the pointer was already released
      }
    };
  }, []);

  // Escape abandons the drag and puts the panel back where it started —
  // the same promise a drag makes everywhere else in the app.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      onWidth(clampPanelWidth(drag.startWidth, viewport()));
      endDrag(document.querySelector("[data-left-panel-resizer]"), drag.pointerId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, onWidth, endDrag]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: width };
    setDragging(true);
    document.documentElement.classList.add("markie-resizing");
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    onWidth(resizePanelWidth(drag.startWidth, e.clientX - drag.startX, viewport()));
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = resizePanelWidth(drag.startWidth, e.clientX - drag.startX, viewport());
    endDrag(e.currentTarget, e.pointerId);
    onCommit(next);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? LEFT_PANEL_STEP_LARGE : LEFT_PANEL_STEP;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = nudgePanelWidth(width, -step, viewport());
    else if (e.key === "ArrowRight") next = nudgePanelWidth(width, step, viewport());
    else if (e.key === "Home") next = LEFT_PANEL_MIN_WIDTH;
    else if (e.key === "End") next = maxPanelWidth(viewport());
    else if (e.key === "Enter") next = clampPanelWidth(LEFT_PANEL_DEFAULT_WIDTH, viewport());
    if (next === null) return;
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      data-left-panel-resizer
      data-dragging={dragging ? "true" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize library panel"
      title="Drag to resize · double-click to reset"
      aria-valuenow={width}
      aria-valuemin={LEFT_PANEL_MIN_WIDTH}
      aria-valuemax={maxPanelWidth(vw)}
      tabIndex={0}
      className="markie-panel-resizer absolute top-0 bottom-0 right-[-3px] w-[7px] z-20 cursor-col-resize"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      // Losing capture (another element grabs it, the node is re-attached) ends
      // the gesture without a pointerup: finish it rather than staying "dragging"
      // with a stuck cursor.
      onLostPointerCapture={finish}
      onDoubleClick={() => onCommit(clampPanelWidth(LEFT_PANEL_DEFAULT_WIDTH, viewport()))}
      onKeyDown={onKeyDown}
    />
  );
}
