import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { embedFrameUrl, embedLabel, parseEmbed } from "@/lib/embeds";
import { CLOSE_MEDIA_VIEWER_COMMAND, OPEN_VIDEO_VIEWER } from "@/lib/media-viewer-events";
import { isDocumentLinkActive } from "@/lib/external-link";
import { getElectronAPI } from "@/lib/electron";

// What one picture in the document looks like to the viewer: the address the
// browser already loaded it from, and the words the author gave it.
export interface LightboxImage {
  src: string;
  alt: string;
}

type Viewer = { source: HTMLElement; canvas: HTMLElement } & (
  | { kind: "image"; images: LightboxImage[]; index: number }
  | { kind: "video"; src: string; frame: boolean; title: string; startTime?: number }
);

function inactive(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]')) return true;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.style.display === "none" || current.style.visibility === "hidden") return true;
  }
  return false;
}

// Every picture in the rendered document, in reading order. Clips keep their
// own playback controls and are expanded separately from picture navigation.
//
// Pictures inside a link are left out. Clicking one of those is how you follow
// the link, and a viewer that opened on the same click would swallow it. So is
// a video card's thumbnail, which is a play button drawn large.
export function collectImages(root: ParentNode): LightboxImage[] {
  const out: LightboxImage[] = [];
  for (const img of root.querySelectorAll<HTMLImageElement>(".markdown-body img")) {
    if (img.closest("a, [data-markie-embed]")) continue;
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
  const [open, setOpen] = useState<Viewer | null>(null);
  // Drawn at its natural size rather than fitted to the window. A screenshot
  // of a whole page fitted to the window is a thumbnail, and the reason to
  // open it was to read it.
  const [actualSize, setActualSize] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Where the keyboard was before the viewer took it, so closing puts it back
  // in the document instead of nowhere.
  const restoreFocus = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const close = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
    }
    setOpen(null);
    setActualSize(false);
    const back = restoreFocus.current;
    restoreFocus.current = null;
    if (back && !inactive(back)) back.focus({ preventScroll: true });
  }, []);

  const step = useCallback((delta: number) => {
    setActualSize(false);
    setOpen((current) => {
      if (!current || current.kind !== "image") return current;
      const index = current.index + delta;
      if (index < 0 || index >= current.images.length) return current;
      return { ...current, index };
    });
  }, []);

  useEffect(() => {
    if (!container) return;
    const rememberFocus = () => {
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setActualSize(false);
    };
    const onOpen = (event: MouseEvent) => {
      // A modified click is the user asking for something else (a context
      // menu, a link in a new window); an already-handled one belongs to
      // whoever handled it.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target instanceof HTMLVideoElement && event.type === "dblclick") {
        const canvas = target.closest<HTMLElement>(".markdown-body");
        const src = target.getAttribute("src");
        if (!canvas || !src || !isDocumentLinkActive(target) || target.closest("a")) return;
        event.preventDefault();
        target.pause();
        rememberFocus();
        setOpen({ kind: "video", src, frame: false, title: "Video", startTime: target.currentTime, source: target, canvas });
        return;
      }
      if (event.type !== openOn) return;
      if (!(target instanceof HTMLImageElement)) return;
      if (!target.closest(".markdown-body") || target.closest("a, [data-markie-embed]")) return;
      const src = target.getAttribute("src");
      if (!src) return;
      const images = collectImages(container);
      const index = images.findIndex((image) => image.src === src);
      if (index < 0) return;
      // A double-click otherwise selects the picture and the paragraph around
      // it, which is still selected when the viewer closes.
      event.preventDefault();
      if (!isDocumentLinkActive(target)) return;
      rememberFocus();
      setOpen({ kind: "image", images, index, source: target, canvas: target.closest<HTMLElement>(".markdown-body")! });
    };
    const onVideo = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.target instanceof HTMLElement)) return;
      if (event.detail?.local === true) {
        const button = event.target.closest<HTMLElement>("[data-markie-video-expand]");
        const video = button?.parentElement?.querySelector("video");
        const canvas = video?.closest<HTMLElement>(".markdown-body");
        const src = video?.getAttribute("src");
        if (!button || !video || !canvas || !src || !isDocumentLinkActive(video)) return;
        video.pause();
        rememberFocus();
        restoreFocus.current = button;
        setOpen({ kind: "video", src, frame: false, title: "Video", startTime: video.currentTime, source: video, canvas });
        return;
      }
      const source = event.target.closest<HTMLElement>("[data-markie-embed-card]");
      const canvas = source?.closest<HTMLElement>(".markdown-body");
      const url = event.detail?.url;
      if (!source || !canvas || !isDocumentLinkActive(source) || typeof url !== "string") return;
      const embed = parseEmbed(url);
      if (!embed || source.closest<HTMLElement>("[data-markie-embed]")?.dataset.markieEmbed !== url) return;
      rememberFocus();
      // A card is the most useful keyboard destination when playback closes.
      restoreFocus.current = source;
      setOpen({ kind: "video", src: embedFrameUrl(embed), frame: true, title: `Video on ${embedLabel(embed)}`, source, canvas });
    };
    container.addEventListener(openOn, onOpen);
    if (openOn !== "dblclick") container.addEventListener("dblclick", onOpen);
    container.addEventListener(OPEN_VIDEO_VIEWER, onVideo);
    return () => {
      container.removeEventListener(openOn, onOpen);
      container.removeEventListener("dblclick", onOpen);
      container.removeEventListener(OPEN_VIDEO_VIEWER, onVideo);
    };
  }, [container, openOn]);

  // The viewer belongs to the current source, not a stale snapshot after a
  // file switch. Its portal is outside this subtree, so zooming or stepping
  // through pictures does not look like an edit. Card metadata is view-only.
  useEffect(() => {
    if (!open || !container) return;
    const observer = new MutationObserver((changes) => {
      if (inactive(container) || inactive(open.source) || !container.contains(open.source) || changes.some((change) => {
        const target = change.target instanceof Element ? change.target : change.target.parentElement;
        return open.canvas.contains(change.target) && !target?.closest("[data-markie-embed]") &&
          (change.type !== "attributes" || change.attributeName === "src");
      })) close();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "inert", "hidden", "style", "aria-hidden"] });
    return () => observer.disconnect();
  }, [open, container, close]);

  useEffect(() => {
    const video = videoRef.current;
    return () => { if (video) { video.pause(); video.removeAttribute("src"); } };
  }, [open]);

  // Electron forwards Escape even when keyboard focus belongs to a provider's
  // cross-origin frame. The player receives no Markie bridge or host access.
  useEffect(() => {
    if (!open) return;
    return getElectronAPI()?.onDocumentCommand?.((command) => {
      if (command === CLOSE_MEDIA_VIEWER_COMMAND) close();
    });
  }, [open, close]);

  // The keys, taken at the window in the capture phase so the editor's own
  // keymap never sees an arrow meant for the viewer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), video[controls], iframe')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
          event.preventDefault();
          event.stopPropagation();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      } else if (open.kind === "image" && (event.key === "ArrowRight" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopPropagation();
        step(1);
      } else if (open.kind === "image" && (event.key === "ArrowLeft" || event.key === "ArrowUp")) {
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
  const image = open.kind === "image" ? open.images[open.index] : null;
  const many = open.kind === "image" && open.images.length > 1;
  const caption = image?.alt.trim() ?? "";
  const dismissOutside = (event: React.SyntheticEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) { event.preventDefault(); close(); }
  };

  return createPortal(
    <div
      ref={dialogRef}
      data-markie-lightbox
      role="dialog"
      aria-modal="true"
      aria-label={open.kind === "video" ? open.title : caption ? `Picture: ${caption}` : "Picture"}
      tabIndex={-1}
      className="markie-scrim-strong overlay-scrim-enter fixed inset-0 z-[90] flex items-center justify-center outline-none [app-region:no-drag]"
      onPointerDown={dismissOutside}
      onMouseDown={dismissOutside}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className={`flex max-h-full max-w-full items-center justify-center ${
          actualSize ? "overflow-auto" : "overflow-hidden"
        }`}
        style={{ width: "100vw", height: "100vh" }}
        onPointerDown={dismissOutside}
        onMouseDown={dismissOutside}
      >
        {/* The picture is whatever the document already loaded, over the same
            address, so nothing is fetched twice and a private file needs no
            second permission. A statically exported app has no image
            optimizer to route it through. */}
        {image ? <img
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
        /> : open.kind === "video" && (open.frame ? <iframe
          src={open.src}
          title={open.title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="aspect-video w-[min(1120px,calc(100vw-48px),calc((100vh-96px)*16/9))] rounded-lg border-0 bg-black shadow-2xl"
        /> : <video
          ref={videoRef}
          src={open.src}
          controls
          autoPlay
          playsInline
          onLoadedMetadata={(event) => {
            if (Number.isFinite(open.startTime) && open.startTime! >= 0) event.currentTarget.currentTime = open.startTime!;
          }}
          className="max-h-[calc(100vh-96px)] max-w-[calc(100vw-48px)] rounded-lg bg-black shadow-2xl"
        />)}
      </div>

      <button
        type="button"
        onClick={close}
        aria-label={open.kind === "video" ? "Close video" : "Close picture"}
        className="markie-lightbox-control absolute right-4 top-4 h-9 w-9 text-[20px] leading-none"
      >
        ×
      </button>

      {many && open.kind === "image" && (
        <>
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={open.index === 0}
            aria-label="Previous picture"
            className="markie-lightbox-control absolute left-4 top-1/2 h-11 w-11 -translate-y-1/2 text-[22px] leading-none"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={open.index === open.images.length - 1}
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
          {many && open.kind === "image" && (
            <span className="shrink-0 tabular-nums text-muted">
              {open.index + 1} / {open.images.length}
            </span>
          )}
        </div>
      )}
    </div>, document.body
  );
}
