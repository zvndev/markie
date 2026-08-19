"use client";

// The grab handle on the side panel's right edge.
//
// Pointer capture rather than window-level mousemove listeners: a drag is
// faster than React's re-render, so the cursor routinely leaves a 4px strip
// mid-gesture. Capture keeps the events coming to this element until release,
// which is the difference between a resize that tracks the mouse and one that
// silently gives up halfway across the screen.

import { useCallback, useRef } from "react";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_FRACTION,
  PANEL_MIN_WIDTH,
  panelSizeFor,
} from "@/lib/panel-resize";

interface PanelResizerProps {
  /** Current panel width, so keyboard steps have somewhere to start. */
  width: number;
  /** A new width was chosen. */
  onResize: (width: number) => void;
  /** Dragged past the snap point: the panel should close. */
  onCollapse: () => void;
}

// Arrow keys move by this much; with shift, by a chunk.
const STEP = 16;
const BIG_STEP = 64;

export function PanelResizer({ width, onResize, onCollapse }: PanelResizerProps) {
  // The panel's left edge in viewport coordinates. Captured once per drag so a
  // mid-drag layout change cannot make the panel jump.
  const originX = useRef(0);

  const apply = useCallback(
    (desired: number) => {
      const size = panelSizeFor(desired, window.innerWidth);
      if (size.collapsed) onCollapse();
      else onResize(size.width);
    },
    [onCollapse, onResize]
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button starts a resize; a right-click here should not
    // begin a drag the user can never end.
    if (e.button !== 0) return;
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    originX.current = panel.getBoundingClientRect().left;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      apply(e.clientX - originX.current);
    },
    [apply]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? BIG_STEP : STEP;
      if (e.key === "ArrowLeft") apply(width - step);
      else if (e.key === "ArrowRight") apply(width + step);
      else if (e.key === "Home") onCollapse();
      else if (e.key === "Enter" || e.key === " ") onCollapse();
      else return;
      e.preventDefault();
    },
    [apply, onCollapse, width]
  );

  return (
    <div
      // A 4px visual seam with a wider invisible grab area: the border the user
      // aims at is thin, but a 4px hit target is a frustrating thing to hit.
      className="markie-panel-resizer absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={Math.round(
        (typeof window === "undefined" ? 0 : window.innerWidth) * PANEL_MAX_FRACTION
      )}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(PANEL_DEFAULT_WIDTH)}
    />
  );
}
