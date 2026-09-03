"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getElectronAPI, type LinkPreview } from "@/lib/electron";
import {
  getLinkPreviewsEnabled,
  linkPreviewsEnabledOnServer,
  subscribeLinkPreviews,
} from "@/lib/link-previews";

// How long the pointer has to rest before anything is fetched. Long enough
// that crossing a paragraph full of links asks for nothing, short enough that
// stopping on one feels like it answered rather than loaded.
const HOVER_MS = 450;
// A card that vanishes the instant the pointer leaves the link cannot be
// reached to read, so it survives the gap between the two.
const LEAVE_MS = 180;
const CARD_WIDTH = 320;
const GAP = 8;

type Placed = { preview: LinkPreview; top: number; left: number; below: boolean };

function positionFor(rect: DOMRect): { top: number; left: number; below: boolean } {
  const room = window.innerHeight - rect.bottom;
  // 172 is the tallest a card gets: picture, title, two lines and the host.
  const below = room > 172 || rect.top < 172;
  const left = Math.min(
    Math.max(GAP, rect.left),
    Math.max(GAP, window.innerWidth - CARD_WIDTH - GAP)
  );
  return {
    top: below ? rect.bottom + GAP : rect.top - GAP,
    left,
    below,
  };
}

/**
 * The card Slack and every other reader shows when you hover a link.
 *
 * Nothing is fetched when a document opens. A document is somebody else's text,
 * and opening it should not make your machine call out to every address in it.
 * This asks only after the pointer has deliberately rested on one link.
 */
export function LinkPreviewCard({ container }: { container: HTMLElement | null }) {
  const [placed, setPlaced] = useState<Placed | null>(null);
  const enabled = useSyncExternalStore(
    subscribeLinkPreviews,
    getLinkPreviewsEnabled,
    linkPreviewsEnabledOnServer
  );
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which link the pointer is on now, so an answer that arrives after the
  // pointer moved on is dropped instead of drawn somewhere else.
  const wanted = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    hoverTimer.current = null;
    leaveTimer.current = null;
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    wanted.current = null;
    setPlaced(null);
  }, [clearTimers]);

  useEffect(() => {
    // Turning the switch off, or changing document, runs the previous run's
    // cleanup, which takes any card on screen down with it.
    if (!container || !enabled) return;
    const api = getElectronAPI();
    if (!api?.linkPreview) return;

    const onOver = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return;
      if (href === wanted.current) return;

      clearTimers();
      wanted.current = href;
      hoverTimer.current = setTimeout(async () => {
        const preview = await api.linkPreview!(href).catch(() => null);
        // The pointer may have moved on while the site was answering.
        if (!preview || wanted.current !== href || !anchor.isConnected) return;
        setPlaced({ preview, ...positionFor(anchor.getBoundingClientRect()) });
      }, HOVER_MS);
    };

    const onOut = (event: MouseEvent) => {
      const to = event.relatedTarget as HTMLElement | null;
      if (to?.closest?.("[data-markie-link-card]")) return;
      clearTimers();
      leaveTimer.current = setTimeout(hide, LEAVE_MS);
    };

    // Clicking the card is how you follow the link, and the card is inside the
    // container, so a blanket hide here dismissed it before its own click ever
    // ran. Everything else in the document still puts it away.
    const onDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.("[data-markie-link-card]")) return;
      hide();
    };

    container.addEventListener("mouseover", onOver);
    container.addEventListener("mouseout", onOut);
    // Any of these mean the card is about to be in the wrong place or unwanted.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    container.addEventListener("mousedown", onDown);
    return () => {
      container.removeEventListener("mouseover", onOver);
      container.removeEventListener("mouseout", onOut);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      container.removeEventListener("mousedown", onDown);
      clearTimers();
      wanted.current = null;
      setPlaced(null);
    };
  }, [container, enabled, clearTimers, hide]);

  if (!placed || !enabled) return null;
  const { preview, top, left, below } = placed;
  return (
    // A button rather than a div: the card is the link, drawn larger, and a
    // card you cannot click is a card that makes you go back and find the link.
    <button
      type="button"
      data-markie-link-card
      role="tooltip"
      title={preview.url}
      onMouseEnter={() => {
        if (leaveTimer.current) clearTimeout(leaveTimer.current);
      }}
      onMouseLeave={hide}
      onClick={() => {
        hide();
        getElectronAPI()?.openExternal?.(preview.url);
      }}
      className="fixed z-[80] block w-[320px] cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-left shadow-lg"
      style={{
        top,
        left,
        transform: below ? undefined : "translateY(-100%)",
      }}
    >
      {preview.image && (
        // A data URI main already fetched and capped, in a statically exported
        // app with no image optimizer to route it through.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.image}
          alt=""
          // A hairline under it, so the picture and the words read as one card
          // rather than two things stacked.
          className="block h-[132px] w-full border-b border-[var(--border)] object-cover"
        />
      )}
      <div className="p-3">
        {preview.siteName && (
          <div className="mb-1 truncate text-[10px] uppercase tracking-wide text-muted">
            {preview.siteName}
          </div>
        )}
        {preview.title && (
          <div className="mb-1 line-clamp-2 text-[12px] font-semibold leading-snug text-foreground">
            {preview.title}
          </div>
        )}
        {preview.description && (
          <div className="line-clamp-3 text-[11px] leading-relaxed text-muted">
            {preview.description}
          </div>
        )}
      </div>
    </button>
  );
}
