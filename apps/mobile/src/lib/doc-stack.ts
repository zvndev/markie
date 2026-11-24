// What opening a document link does to the stack of screens. Kept apart from
// app.tsx so the one case with no device to try it on can be tested: a tapped
// notification about a different thread of the document already on screen.
import type { LinkTarget } from "./deep-links";

export function sameTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.kind !== b.kind || a.origin !== b.origin) return false;
  return a.kind === "doc" ? a.id === (b as typeof a).id : a.token === (b as typeof a).token;
}

export function threadOf(target: LinkTarget): string | null {
  return target.kind === "doc" ? target.thread ?? null : null;
}

/**
 * - "push": a different document (or none on top). It goes on the stack.
 * - "retarget": the same document, and the link names a thread the screen is
 *   not already showing. The screen stays and is handed the new link, so it
 *   opens that thread without a second copy of the document.
 * - "keep": the same document, nothing new to show.
 */
export type OpenDecision = "push" | "retarget" | "keep";

export function openDecision(top: LinkTarget | null, next: LinkTarget): OpenDecision {
  if (!top || !sameTarget(top, next)) return "push";
  const thread = threadOf(next);
  return thread && thread !== threadOf(top) ? "retarget" : "keep";
}
