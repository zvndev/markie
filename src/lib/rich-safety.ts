// Whether the preservation pipeline can reconstruct a document byte for byte,
// remembered so reopening one is instant.
//
// probeReconstruction is not cheap: measured over 150 real files it takes
// 152ms at the median, 501ms at p90 and 2.9s at p99. Reopening a document is
// one of the most common things anyone does in Markie, so the answer is
// cached, and the answer for a document that has not been opened yet is
// resolved off the open path (see use-rich-safety.ts).
//
// The key is the document's own bytes, not a hash of them. A hash collision
// would arm rich editing, and with it autosave, on a document the pipeline
// cannot reconstruct, which is the single failure this whole workstream exists
// to prevent. Holding the text costs memory instead, so the store is bounded
// both ways and evicts least-recently-used first.
import { createBlockNormalizer, probeReconstruction } from "@/lib/rich-roundtrip";
import { splitFrontMatter } from "@/lib/front-matter";
import { extractHoldAsides } from "@/lib/rich-hold-aside";
import { warmBlocks, windowIdleScheduler, type IdleScheduler } from "@/lib/rich-warmup";

const MAX_ENTRIES = 24;
const MAX_BYTES = 4 * 1024 * 1024;

const verdicts = new Map<string, boolean>();
let heldBytes = 0;

function evict(): void {
  while (verdicts.size > MAX_ENTRIES || heldBytes > MAX_BYTES) {
    const oldest = verdicts.keys().next();
    if (oldest.done) break;
    heldBytes -= oldest.value.length;
    verdicts.delete(oldest.value);
  }
}

/** The remembered verdict for this exact text, or null when it is unknown. */
export function cachedReconstruction(markdown: string): boolean | null {
  const hit = verdicts.get(markdown);
  if (hit === undefined) return null;
  // Re-insert so the key counts as recently used.
  verdicts.delete(markdown);
  verdicts.set(markdown, hit);
  return hit;
}

/** Run the probe (or answer from cache) and remember the verdict. */
export function resolveReconstruction(markdown: string): boolean {
  const known = cachedReconstruction(markdown);
  if (known !== null) return known;
  const clean = probeReconstruction(markdown).clean;
  verdicts.set(markdown, clean);
  heldBytes += markdown.length;
  evict();
  return clean;
}

/** Tests only. */
export function clearReconstructionCache(): void {
  verdicts.clear();
  heldBytes = 0;
}

export interface ReconstructionJob {
  /** The document changed; whatever this job has not done, it never will. */
  cancel(): void;
}

// Resolve a verdict without stalling the app.
//
// The probe is a whole-document round trip followed by a per-block
// normalization pass (a parse plus a serialize each, memoized). The blocks are
// nearly all of the cost and they are independent of one another, so they can
// be done a few at a time while the app is idle; only the final round trip and
// comparison must happen in one piece, and with the memo warm that piece is
// short. Between slices the renderer answers input, which is what a document
// that "froze while preparing" was missing.
//
// A remembered verdict answers at once, and without an idle scheduler (tests,
// and any window without requestIdleCallback) the probe runs whole on the next
// macrotask, exactly as it did before.
export function startReconstructionJob(
  markdown: string,
  onDone: (clean: boolean) => void,
  scheduler: IdleScheduler | null = windowIdleScheduler()
): ReconstructionJob {
  const known = cachedReconstruction(markdown);
  if (known !== null) {
    onDone(known);
    return { cancel: () => {} };
  }
  let cancelled = false;
  if (!scheduler) {
    const timer = setTimeout(() => {
      if (!cancelled) onDone(resolveReconstruction(markdown));
    }, 0);
    return {
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
      },
    };
  }
  const { body } = splitFrontMatter(markdown);
  const { text } = extractHoldAsides(body);
  const { normalize } = createBlockNormalizer();
  let finalHandle: number | null = null;
  const cancelWarm = warmBlocks(text, normalize, scheduler, () => {
    if (cancelled) return;
    // Not the tail of the slice that finished the warm-up: the round trip is
    // the one piece that cannot yield, so it gets a slot of its own.
    finalHandle = scheduler.request(
      () => {
        if (cancelled) return;
        onDone(resolveReconstruction(markdown));
      },
      { timeout: 500 }
    );
  });
  return {
    cancel: () => {
      cancelled = true;
      cancelWarm();
      if (finalHandle !== null) scheduler.cancel(finalHandle);
    },
  };
}
