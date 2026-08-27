"use client";
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
import { cachedReconstruction, resolveReconstruction } from "@/lib/rich-safety";
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
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setVerdict(verdictFor(resolveReconstruction(pending), pending));
      setPending(null);
    };
    // requestIdleCallback where it exists, so the probe waits for a frame that
    // is not already busy; the timeout keeps it from waiting on a busy app.
    const idle = window.requestIdleCallback;
    if (typeof idle === "function") {
      const handle = idle(run, { timeout: 200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(handle);
      };
    }
    const handle = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [pending]);

  const override = useCallback(() => {
    setRichOverride(pathRef.current, true);
    setOverridden(true);
  }, []);

  return {
    assess,
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
