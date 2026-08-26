"use client";
// The bridge between "the user typed" and "the bytes are on disk".
//
// It lives outside page.tsx because it has to hold three things that must not
// drift apart: one scheduler per open document, the current answer to whether
// this document may be written at all, and the current save function. Getting
// any of them from a stale closure is how an autosave writes the wrong file.
import { useEffect, useMemo, useRef } from "react";
import { createAutosave, type Autosave } from "@/lib/autosave";

export interface SaveGuardInputs {
  /** Runs one save. Resolves true when the bytes committed. */
  save: () => Promise<boolean>;
  /** Whether a typed change may schedule a write to the real file. */
  eligible: boolean;
  /** Changes when the open document does, so pending work never crosses over. */
  docKey: string | null;
}

export interface SaveGuard {
  /** A user edit landed in the buffer. Arms a write if this document allows one. */
  noteEdit(): void;
  /** Drop pending work: a manual save is about to do it by hand. */
  cancel(): void;
}

export function useSaveGuard({ save, eligible, docKey }: SaveGuardInputs): SaveGuard {
  const saveRef = useRef(save);
  const eligibleRef = useRef(eligible);
  useEffect(() => {
    saveRef.current = save;
    eligibleRef.current = eligible;
  });

  const autosaveRef = useRef<Autosave | null>(null);
  useEffect(() => {
    // One scheduler per document: a timer armed for the file that just closed
    // must never fire into the file that replaced it.
    const scheduler = createAutosave({ save: () => saveRef.current() });
    autosaveRef.current = scheduler;
    return () => {
      scheduler.cancel();
      if (autosaveRef.current === scheduler) autosaveRef.current = null;
    };
  }, [docKey]);

  return useMemo<SaveGuard>(
    () => ({
      noteEdit() {
        // Eligibility is read at the moment of the edit, not captured: a
        // document that became unwritable (a disk conflict appeared, the share
        // turned read-only) must stop arming writes immediately.
        if (eligibleRef.current) autosaveRef.current?.noteChange();
      },
      cancel() {
        autosaveRef.current?.cancel();
      },
    }),
    []
  );
}
