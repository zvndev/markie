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
import { probeReconstruction } from "@/lib/rich-roundtrip";

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
