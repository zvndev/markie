import { getElectronAPI } from "@/lib/electron";

/** Web content leaves Markie through the existing system-browser bridge. */
export function externalWebTarget(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw) || raw.length > 8192 || /[\s\x00-\x20\x7f\\]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function isDocumentLinkActive(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  // A portal must not remain interactive above a newly opened modal.
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  if (modal && !modal.contains(element)) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

/** Returns false on the web, where the anchor keeps normal browser behavior. */
export function handleExternalLinkClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return false;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor) return false;
  const raw = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(raw)) return false;
  const api = getElectronAPI();
  if (!api?.openExternal) return false;
  event.preventDefault(); event.stopPropagation();
  const href = externalWebTarget(raw);
  if (href && isDocumentLinkActive(anchor)) void api.openExternal(href).catch(() => {});
  return true;
}
