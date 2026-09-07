// Is rich editing armed for the open document?
//
// Rendering rich is always safe, because rendering never writes. What the
// reconstruction probe gates is EDITABILITY: whether a rich edit can be
// serialized back without rewriting bytes the user did not touch. So the
// document paints immediately and the probe runs afterwards, yielding to the
// event loop first, which keeps the most common action in the app (opening a
// document) off a 150ms to 2.9s synchronous stall.
//
// Until the verdict lands the document is "checking": the rich pane renders,
// rich editing is not armed, autosave is not armed for rich, and Source is
// fully available and byte-faithful as always. A remembered verdict resolves
// in the same tick, so reopening a document never shows that state at all.
import { useCallback, useEffect, useRef, useState } from "react";
import { describeLossRisks, type LossRisk } from "@/lib/rich-roundtrip";
import { cachedReconstruction, startReconstructionJob } from "@/lib/rich-safety";
import { richOverride, setRichOverride } from "@/lib/rich-override";

export type RichSafety = "checking" | "safe" | "blocked";

// Long enough that an ordinary document resolves without ever painting the
// note, and short enough that a document big enough to stall says something.
// The probe runs on this thread, so a plain timeout could not fire during it:
// the note has to be committed to the screen BEFORE the probe starts, which
// means deciding from the one thing known in advance, the document's size.
// 40KB is the size at which the measured verdict cost crosses a quarter of a
// second (60 real files, jsdom: p50 28ms up to 5KB, 66ms to 10KB, 170ms to
// 20KB, 250ms to 40KB). Nothing in that sample was larger, so in practice this
// note is for the rare very large document and no other open ever sees it.
export const PREPARING_NOTE_BYTES = 40_000;

interface Verdict {
  safety: RichSafety;
  risks: LossRisk[] | null;
}

const verdictFor = (clean: boolean, md: string): Verdict =>
  clean ? { safety: "safe", risks: null } : { safety: "blocked", risks: describeLossRisks(md) };

export function useRichSafety() {
  const [verdict, setVerdict] = useState<Verdict>({ safety: "safe", risks: null });
  const [pending, setPending] = useState<string | null>(null);
  const [overridden, setOverridden] = useState(false);
  const pathRef = useRef<string | null>(null);

  // Called as each document lands, never per keystroke: the probe protects the
  // bytes as they were opened, and once the user edits (or overrides) the
  // decision stands until the next document arrives.
  const assess = useCallback((md: string, path: string | null) => {
    pathRef.current = path;
    setOverridden(richOverride(path));
    const known = cachedReconstruction(md);
    if (known !== null) {
      setPending(null);
      setVerdict(verdictFor(known, md));
      return;
    }
    setPending(md);
    setVerdict({ safety: "checking", risks: null });
  }, []);

  useEffect(() => {
    if (pending === null) return;
    // In idle slices, yielding between them, and cancelled the moment another
    // document replaces this one; see startReconstructionJob.
    const job = startReconstructionJob(pending, (clean) => {
      setVerdict(verdictFor(clean, pending));
      setPending(null);
    });
    return () => job.cancel();
  }, [pending]);

  // A document that never gets a rich pane (too large for it, see
  // src/lib/doc-tiers.ts) gets no probe either: the probe exists to decide
  // whether rich edits may be written back, and there will be none. Rich stays
  // unarmed for it, and whatever was pending for the previous document stops.
  const skip = useCallback((path: string | null) => {
    pathRef.current = path;
    setOverridden(false);
    setPending(null);
    setVerdict({ safety: "blocked", risks: null });
  }, []);

  const override = useCallback(() => {
    setRichOverride(pathRef.current, true);
    setOverridden(true);
  }, []);

  return {
    assess,
    skip,
    override,
    risks: verdict.risks,
    /** Rich edits are refused: the pipeline cannot promise this file's bytes. */
    blocked: verdict.safety === "blocked" && !overridden,
    /** Rich edits are allowed to reach the buffer and to arm autosave. */
    armed: verdict.safety === "safe" || overridden,
    /** The verdict is still being worked out, and the document is big enough to say so. */
    preparing: pending !== null && pending.length >= PREPARING_NOTE_BYTES,
  };
}
