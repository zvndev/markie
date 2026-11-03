// The two controls that put a document's bar away and bring it back, on the
// read view and in the web editor (bar-visibility.ts holds the choice).
import "./doc-view.css";
import { useEffect, useRef } from "react";

const CHEVRON_UP = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const CHEVRON_DOWN = <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function HideBarButton({ onHide, className }: { onHide: () => void; className: string }) {
  return <button type="button" data-web-bar-hide onClick={onHide} title="Hide the bar (Esc)" aria-label="Hide the bar" className={className}>
    {CHEVRON_UP}<span className="hidden sm:inline">Hide</span>
  </button>;
}

/**
 * The small floating control that brings the bar back. It takes the focus
 * when it appears from the bar's own control, so the keyboard is never left
 * on a button that no longer exists.
 */
export function ShowBarButton({ onShow }: { onShow: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
  }, []);
  return <button ref={ref} type="button" data-web-bar-show onClick={onShow} className="markie-view-restore" aria-label="Show the bar" title="Show the bar">
    {CHEVRON_DOWN}Show bar
  </button>;
}
