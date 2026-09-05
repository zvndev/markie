"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// What one picture in the document looks like to the viewer: the address the
// browser already loaded it from, and the words the author gave it.
export interface LightboxImage {
  src: string;
  alt: string;
}

// Every picture in the rendered document, in reading order. Only <img>: a
// clip has its own controls and full-screen button, so a viewer for it would
// be a second player drawn over the first.
//
// Pictures inside a link are left out. Clicking one of those is how you follow
// the link, and a viewer that opened on the same click would swallow it.
export function collectImages(root: ParentNode): LightboxImage[] {
  const out: LightboxImage[] = [];
  for (const img of root.querySelectorAll<HTMLImageElement>(".markdown-body img")) {
    if (img.closest("a")) continue;
    const src = img.getAttribute("src");
    if (!src) continue;
    out.push({ src, alt: img.getAttribute("alt") ?? "" });
  }
  return out;
}

/**
 * The picture you meant to look at, drawn as large as the window allows, with
 * every other picture in the document one arrow key away.
 *
 * Opens on a double-click while a document is being edited, so a single click
 * still does what it does in every editor (selects the picture), and on a
 * single click when the document is read-only, where a click has nothing else
 * to mean.
 */
export function ImageLightbox({
  container,
  openOn,
}: {
  container: HTMLElement | null;
  openOn: "click" | "dblclick";
}) {
  const [open, setOpen] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  // Drawn at its natural size rather than fitted to the window. A screenshot
  // of a whole page fitted to the window is a thumbnail, and the reason to
  // open it was to read it.
  const [actualSize, setActualSize] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Where the keyboard was before the viewer took it, so closing puts it back
  // in the document instead of nowhere.
  const restoreFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    setActualSize(false);
    const back = restoreFocus.current;
    restoreFocus.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, []);

  const step = useCallback((delta: number) => {
    setActualSize(false);
    setOpen((current) => {
      if (!current) return current;
      const index = current.index + delta;
      if (index < 0 || index >= current.images.length) return current;
      return { ...current, index };
    });
  }, []);

  useEffect(() => {
    if (!container) return;
    const onOpen = (event: MouseEvent) => {
      // A modified click is the user asking for something else (a context
      // menu, a link in a new window); an already-handled one belongs to
      // whoever handled it.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement)) return;
      if (!target.closest(".markdown-body") || target.closest("a")) return;
      const src = target.getAttribute("src");
      if (!src) return;
      const images = collectImages(container);
      const index = images.findIndex((image) => image.src === src);
      if (index < 0) return;
      // A double-click otherwise selects the picture and the paragraph around
      // it, which is still selected when the viewer closes.
      event.preventDefault();
      restoreFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setActualSize(false);
      setOpen({ images, index });
    };
    container.addEventListener(openOn, onOpen);
    return () => container.removeEventListener(openOn, onOpen);
  }, [container, openOn]);

  // The keys, taken at the window in the capture phase so the editor's own
  // keymap never sees an arrow meant for the viewer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        step(1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    dialogRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, step]);

  // A pane that has lost its container is on its way out; nothing to draw.
  if (!open || !container) return null;
  const { images, index } = open;
  const image = images[index];
  const many = images.length > 1;
  const caption = image.alt.trim();

  return (
    <div
      ref={dialogRef}
      data-markie-lightbox
      role="dialog"
      aria-modal="true"
      aria-label={caption ? `Picture: ${caption}` : "Picture"}
      tabIndex={-1}
      className="markie-scrim-strong overlay-scrim-enter fixed inset-0 z-[90] flex items-center justify-center outline-none"
      onMouseDown={(event) => {
        // The scrim is the biggest close button there is. The picture and
        // the controls are the only things on it that mean something else.
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`flex max-h-full max-w-full items-center justify-center ${
          actualSize ? "overflow-auto" : "overflow-hidden"
        }`}
        style={{ width: "100vw", height: "100vh" }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        {/* The picture is whatever the document already loaded, over the same
            address, so nothing is fetched twice and a private file needs no
            second permission. A statically exported app has no image
            optimizer to route it through. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={image.src}
          src={image.src}
          alt={image.alt}
          data-markie-lightbox-image
          draggable={false}
          onClick={() => setActualSize((value) => !value)}
          className={`select-none rounded-md shadow-2xl ${
            actualSize
              ? "m-auto max-h-none max-w-none cursor-zoom-out"
              : "max-h-[calc(100vh-96px)] max-w-[calc(100vw-96px)] cursor-zoom-in object-contain"
          }`}
        />
      </div>

      <button
        type="button"
        onClick={close}
        aria-label="Close picture"
        className="markie-lightbox-control absolute right-4 top-4 h-9 w-9 text-[20px] leading-none"
      >
        ×
      </button>

      {many && (
        <>
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={index === 0}
            aria-label="Previous picture"
            className="markie-lightbox-control absolute left-4 top-1/2 h-11 w-11 -translate-y-1/2 text-[22px] leading-none"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={index === images.length - 1}
            aria-label="Next picture"
            className="markie-lightbox-control absolute right-4 top-1/2 h-11 w-11 -translate-y-1/2 text-[22px] leading-none"
          >
            ›
          </button>
        </>
      )}

      {(caption || many) && (
        <div
          data-markie-lightbox-caption
          className="pointer-events-none absolute bottom-4 left-1/2 flex max-w-[80vw] -translate-x-1/2 items-baseline gap-3 rounded-md bg-[var(--surface-2)]/90 px-3 py-1.5 text-[12px] text-foreground shadow-md"
        >
          {caption && <span className="truncate">{caption}</span>}
          {many && (
            <span className="shrink-0 tabular-nums text-muted">
              {index + 1} / {images.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
