// Clicking a link in a document that points at a file beside it.
//
// `[the spec](spec.pdf)` used to do nothing: the anchor's href resolves against
// the renderer's own origin, and main forwards only http(s) to the browser, so
// the click was discarded in silence. A dead click is indistinguishable from a
// broken app, and "open the thing next to this document" is an ordinary thing
// to want from a report that ships with its attachments.
//
// The href on the anchor is still whatever the author wrote, so this reads that
// rather than the resolved `.href` property, and hands the original string to
// main along with the folder the document came from. That is the same base the
// images resolve against, on purpose: a link must not be able to reach
// anywhere a picture could not.
import { getSafeAPI } from "@/lib/electron";
import { getAssetBaseDir } from "@/lib/asset-url";

// Schemes the app already has an answer for. Everything else that carries a
// scheme is somebody else's problem and is left to the existing handlers.
const HANDLED_ELSEWHERE = /^(https?|mailto|markie|markie-asset|data|blob|javascript|file):/i;

export function localLinkTarget(anchor: HTMLAnchorElement | null): string | null {
  if (!anchor) return null;
  const href = anchor.getAttribute("href");
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (HANDLED_ELSEWHERE.test(raw)) return null;
  return raw;
}

/**
 * Handle a click inside a rendered document. Returns true when the click was
 * a local file link and has been taken over.
 */
export function handleDocumentClick(
  event: MouseEvent,
  onError: (message: string) => void
): boolean {
  // A modified click is the user asking their OS for something else; leave it.
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return false;
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
  const href = localLinkTarget(anchor);
  if (!href) return false;

  event.preventDefault();
  event.stopPropagation();

  const api = getSafeAPI();
  if (!api?.openLocalFile) return true;
  void api
    .openLocalFile({ href, docDir: getAssetBaseDir() })
    .then((result) => {
      if (result && result.ok === false && result.error) onError(result.error);
    })
    .catch(() => onError("Markie couldn't open that file."));
  return true;
}
