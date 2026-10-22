import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getElectronAPI, type LinkPreview } from "@/lib/electron";
import { externalWebTarget, isDocumentLinkActive } from "@/lib/external-link";
import { getLinkPreviewsEnabled, linkPreviewsEnabledOnServer, subscribeLinkPreviews } from "@/lib/link-previews";

const HOVER_MS = 450, LEAVE_MS = 180, CARD_WIDTH = 320, GAP = 8;
type Pending = { anchor: HTMLAnchorElement; href: string };
type Placed = Pending & { preview: LinkPreview; top: number; left: number; below: boolean };

function positionFor(rect: DOMRect) {
  const below = window.innerHeight - rect.bottom > 280 || rect.top < 280;
  return { top: below ? rect.bottom + GAP : rect.top - GAP, left: Math.min(Math.max(GAP, rect.left), Math.max(GAP, window.innerWidth - CARD_WIDTH - GAP)), below };
}

/** Only plain, bounded metadata is displayed. Main owns the guarded fetch. */
export function LinkPreviewCard({ container, documentKey, revision }: { container: HTMLElement | null; documentKey?: string | null; revision?: unknown }) {
  const [placed, setPlaced] = useState<Placed | null>(null);
  const enabled = useSyncExternalStore(subscribeLinkPreviews, getLinkPreviewsEnabled, linkPreviewsEnabledOnServer);
  const card = useRef<HTMLDivElement>(null), id = useId();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null), leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Identity is the exact anchor/request, not its URL: another document may
  // contain the same URL while an older request is still answering.
  const wanted = useRef<Pending | null>(null);
  const clearTimers = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    hoverTimer.current = null; leaveTimer.current = null;
  }, []);
  const hide = useCallback(() => { clearTimers(); wanted.current = null; setPlaced(null); }, [clearTimers]);

  useEffect(() => {
    if (!container || !enabled) return;
    const api = getElectronAPI();
    if (!api?.linkPreview) return;
    const onOver = (event: MouseEvent | FocusEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || !container.contains(anchor) || !isDocumentLinkActive(anchor)) return;
      const href = externalWebTarget(anchor.getAttribute("href") ?? "");
      if (!href) return;
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (wanted.current?.anchor === anchor && wanted.current.href === href) return;
      clearTimers(); setPlaced(null);
      const request = { anchor, href }; wanted.current = request;
      hoverTimer.current = setTimeout(async () => {
        hoverTimer.current = null;
        if (wanted.current !== request || !isDocumentLinkActive(anchor) || !getLinkPreviewsEnabled()) return;
        const preview = await api.linkPreview(href).catch(() => null);
        if (!preview || wanted.current !== request || !container.contains(anchor) || externalWebTarget(anchor.getAttribute("href") ?? "") !== href || !isDocumentLinkActive(anchor) || !getLinkPreviewsEnabled()) return;
        const url = externalWebTarget(preview.url);
        if (!url) return;
        setPlaced({ ...request, preview: { ...preview, url }, ...positionFor(anchor.getBoundingClientRect()) });
      }, HOVER_MS);
    };
    const onOut = (event: MouseEvent | FocusEvent) => {
      const to = event.relatedTarget;
      if (to instanceof Node && (card.current?.contains(to) || wanted.current?.anchor.contains(to))) return;
      // The grace period makes an existing card reachable. It must not turn
      // a near-miss hover into a new network request after the pointer left.
      if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; wanted.current = null; }
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      leaveTimer.current = setTimeout(hide, LEAVE_MS);
    };
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Node && card.current?.contains(event.target))) hide(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !wanted.current) return;
      const anchor = wanted.current.anchor;
      if (card.current?.contains(document.activeElement)) anchor.focus();
      hide();
    };
    const observer = new MutationObserver(() => {
      const anchor = wanted.current?.anchor;
      if (anchor && (!container.contains(anchor) || externalWebTarget(anchor.getAttribute("href") ?? "") !== wanted.current?.href || !isDocumentLinkActive(anchor))) hide();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert", "hidden", "aria-hidden", "aria-modal", "style", "class", "href"] });
    container.addEventListener("mouseover", onOver); container.addEventListener("mouseout", onOut);
    container.addEventListener("focusin", onOver); container.addEventListener("focusout", onOut);
    window.addEventListener("scroll", hide, true); window.addEventListener("resize", hide); window.addEventListener("blur", hide);
    window.addEventListener("mousedown", onDown); window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      container.removeEventListener("mouseover", onOver); container.removeEventListener("mouseout", onOut);
      container.removeEventListener("focusin", onOver); container.removeEventListener("focusout", onOut);
      window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); window.removeEventListener("blur", hide);
      window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey);
      hide();
    };
  }, [container, enabled, documentKey, revision, clearTimers, hide]);

  useLayoutEffect(() => {
    if (!placed || !card.current) return;
    const rect = card.current.getBoundingClientRect();
    const top = Math.min(Math.max(GAP, rect.top), Math.max(GAP, window.innerHeight - rect.height - GAP));
    card.current.style.top = `${top}px`; card.current.style.transform = "none";
    const previous = placed.anchor.getAttribute("aria-describedby");
    placed.anchor.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => { if (previous === null) placed.anchor.removeAttribute("aria-describedby"); else placed.anchor.setAttribute("aria-describedby", previous); };
  }, [placed, id]);

  if (!placed || !enabled) return null;
  const { preview, top, left, below } = placed;
  const host = new URL(preview.url).hostname;
  const open = () => {
    if (isDocumentLinkActive(placed.anchor)) void getElectronAPI()?.openExternal?.(preview.url).catch(() => {});
    hide();
  };
  return createPortal(<div ref={card} id={id} data-markie-link-card role="tooltip"
    onMouseEnter={() => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }}
    onMouseLeave={() => { leaveTimer.current = setTimeout(hide, LEAVE_MS); }}
    onFocusCapture={() => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }}
    onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) hide(); }}
    className="fixed z-[80] overflow-auto rounded-lg border border-border bg-surface text-foreground shadow-lg"
    style={{ top, left, width: CARD_WIDTH, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)", transform: below ? undefined : "translateY(-100%)" }}>
    <button type="button" title={preview.url} aria-label={`Open ${preview.title || host} in default browser`}
      onClick={(event) => { event.stopPropagation(); open(); }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); open(); } }}
      className="block w-full cursor-pointer bg-surface text-left focus-visible:outline-2 focus-visible:outline-blue-400 focus-visible:-outline-offset-2">
      {preview.image && /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(preview.image) ? <img src={preview.image} alt="" className="block h-[132px] w-full border-b border-border object-cover" /> : null}
      <div className="p-3">
        {preview.siteName ? <div className="mb-1 truncate text-[10px] uppercase tracking-wide text-muted">{preview.siteName}</div> : null}
        {preview.title ? <div className="mb-1 line-clamp-2 text-[12px] font-semibold leading-snug">{preview.title}</div> : null}
        {preview.description ? <div className="line-clamp-3 text-[11px] leading-relaxed text-muted">{preview.description}</div> : null}
        <div className="mt-2 truncate text-[10px] text-muted">{host} <span aria-hidden="true">↗</span></div>
      </div>
    </button>
  </div>, document.body);
}
