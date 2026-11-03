// Whether the bar over a document is put away, on the web: the read view's
// bar and the editor's. A reader can hide it (its own control, or Escape) to
// read full-bleed, and a small floating control brings it back. The choice is
// remembered per browser, each surface on its own, so hiding the bar to read
// does not hide the editor's tools the next time you edit.
import { useCallback, useEffect, useState } from "react";

export type BarSurface = "view" | "editor";

const KEY = (surface: BarSurface) => `markie.web.bar-hidden.${surface}`;

export function readBarHidden(surface: BarSurface, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(KEY(surface)) === "1";
  } catch {
    return false;
  }
}

export function writeBarHidden(surface: BarSurface, hidden: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): void {
  try {
    if (hidden) storage?.setItem(KEY(surface), "1");
    else storage?.removeItem(KEY(surface));
  } catch {
    // Still applies in this tab.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether Escape, pressed now, is free to put the bar away. Not when it is
 * already closing something else (a menu, a dialog, the picture viewer) or
 * belongs to a field or an editor that is being typed in.
 */
export function escapeIsFree(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (doc.querySelector('[role="menu"], [role="dialog"], [role="listbox"], [data-markie-lightbox]')) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor')) return false;
  return true;
}

/** `active`: whether a document is open here, so Escape has a bar to put away. */
export function useBarVisibility(surface: BarSurface, active = true) {
  const [hidden, setHiddenState] = useState(() => readBarHidden(surface));
  const setHidden = useCallback((next: boolean) => {
    setHiddenState(next);
    writeBarHidden(surface, next);
  }, [surface]);

  useEffect(() => {
    if (hidden || !active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!escapeIsFree(event)) return;
      setHidden(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, active, setHidden]);

  return { hidden, hide: useCallback(() => setHidden(true), [setHidden]), show: useCallback(() => setHidden(false), [setHidden]) };
}
