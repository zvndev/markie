"use client";
// The bridge between "the user typed" and "the bytes are on disk".
//
// It lives outside page.tsx because it has to hold three things that must not
// drift apart: one scheduler per open document, the current answer to whether
// this document may be written at all, and the current save function. Getting
// any of them from a stale closure is how an autosave writes the wrong file.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAutosave, type Autosave } from "@/lib/autosave";
import { getElectronAPI, type DraftEntry } from "@/lib/electron";

// The journal runs ahead of the file: one serializer tick behind the buffer,
// where the file write is up to a second behind. That gap is the kill window.
const DRAFT_DEBOUNCE_MS = 250;

export interface SaveGuardInputs {
  /** Runs one save. Resolves true when the bytes committed. */
  save: () => Promise<boolean>;
  /** Whether a typed change may schedule a write to the real file. */
  eligible: boolean;
  /** Changes when the open document does, so pending work never crosses over. */
  docKey: string | null;
  /**
   * The buffer as it stands, for the crash journal. Journalled whatever the
   * eligibility gate says: a pathless or rich-blocked document deserves crash
   * safety just as much, it simply has nowhere to autosave to.
   */
  document: {
    path: string | null;
    name: string | null;
    content: string;
    dirty: boolean;
  };
  /** The first document has landed, so a recovered draft can be matched to it. */
  booted: boolean;
}

export interface SaveGuard {
  /** A user edit landed in the buffer. Arms a write if this document allows one. */
  noteEdit(): void;
  /** Drop pending work: a manual save is about to do it by hand. */
  cancel(): void;
  /**
   * Everything pending must be on disk before the caller goes on. Used by the
   * transitions that would otherwise drop it: opening another file, starting a
   * new one, and the window closing.
   */
  settle(): Promise<void>;
  /** Unsaved work from a previous session that belongs to the open document. */
  recovered: (DraftEntry & { content: string }) | null;
  /** The user took the draft: stop offering it (it stays until a save clears it). */
  acceptRecovered(): void;
  /** The user does not want it: forget it here and on disk. */
  discardRecovered(): void;
}

export function useSaveGuard({
  save,
  eligible,
  docKey,
  document: doc,
  booted,
}: SaveGuardInputs): SaveGuard {
  const saveRef = useRef(save);
  const eligibleRef = useRef(eligible);
  const docRef = useRef(doc);
  useEffect(() => {
    saveRef.current = save;
    eligibleRef.current = eligible;
    docRef.current = doc;
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

  // Journal the buffer while it is dirty. Debounced, so a burst of keystrokes
  // is one write, and cleared on the way past a committed save.
  useEffect(() => {
    if (!doc.dirty) return;
    const timer = setTimeout(() => {
      void getElectronAPI()?.draftSave?.({
        path: docRef.current.path,
        name: docRef.current.name,
        content: docRef.current.content,
      });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc.content, doc.dirty, doc.path, doc.name]);

  const [recovered, setRecovered] = useState<(DraftEntry & { content: string }) | null>(
    null
  );
  const checkedRef = useRef(false);
  useEffect(() => {
    if (!booted || checkedRef.current) return;
    checkedRef.current = true;
    const openPath = docRef.current.path;
    void getElectronAPI()
      ?.draftCheck?.()
      .then((entries) => {
        const list = Array.isArray(entries) ? entries : [];
        // The draft for the document that is open, or the untitled one when
        // this launch has no document. Anything else belongs to a file the
        // user has not asked for and must not interrupt them.
        const match = list.find((entry) =>
          openPath ? entry.path === openPath : entry.path === null
        );
        if (match && typeof match.content === "string") {
          setRecovered(match as DraftEntry & { content: string });
        }
      })
      .catch(() => {
        // No journal, no recovery. Never a reason to fail a launch.
      });
  }, [booted]);

  const acceptRecovered = useCallback(() => setRecovered(null), []);
  const discardRecovered = useCallback(() => {
    setRecovered((entry) => {
      if (entry) void getElectronAPI()?.draftDiscard?.(entry.key);
      return null;
    });
  }, []);

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
      async settle() {
        try {
          await autosaveRef.current?.flush();
        } catch {
          // A failed flush has already reported itself through the save path.
          // Blocking the transition on it would trap the user in a document
          // they cannot leave, and the draft journal holds what did not land.
        }
        // One last journal write, so closing never races the debounce above.
        // Whatever the save could not commit is still recoverable.
        if (docRef.current.dirty) {
          try {
            await getElectronAPI()?.draftSave?.({
              path: docRef.current.path,
              name: docRef.current.name,
              content: docRef.current.content,
            });
          } catch {
            // Nothing left to fall back to; the window is closing regardless.
          }
        }
      },
      recovered,
      acceptRecovered,
      discardRecovered,
    }),
    [recovered, acceptRecovered, discardRecovered]
  );
}
