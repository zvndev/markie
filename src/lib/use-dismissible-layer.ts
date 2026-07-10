"use client";

import { useEffect, useRef, type RefObject } from "react";

interface ContainmentTarget {
  contains(target: Node | null): boolean;
}

export function shouldDismissLayer(
  layer: ContainmentTarget | null,
  target: Node | null
): boolean {
  return !layer || !target || !layer.contains(target);
}

export function useDismissibleLayer<T extends HTMLElement>(
  open: boolean,
  layerRef: RefObject<T | null>,
  onDismiss: () => void
) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (shouldDismissLayer(layerRef.current, target)) {
        onDismissRef.current();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismissRef.current();
    };

    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [layerRef, open]);
}
