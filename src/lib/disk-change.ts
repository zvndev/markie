// The file moved underneath you.
//
// Markie already noticed this, but only at the moment you pressed save — by
// which point you had been typing into a stale document for however long, and
// the only choices left were "throw away theirs" or "throw away yours".
//
// Noticing earlier turns the same event into a much smaller decision, and adds
// a third answer that loses nothing: keep both.

import { lineDiff } from "./line-diff";

export type DiskChangeKind = "clean" | "dirty";

/**
 * How much this interruption is worth. With an unmodified buffer a reload
 * cannot destroy anything, so it gets a strip rather than a modal — the same
 * judgement UpdateStrip already makes about server changes, and for the same
 * reason: modals people dismiss unread are worse than none.
 */
export function diskChangeKind(dirty: boolean): DiskChangeKind {
  return dirty ? "dirty" : "clean";
}

/** What the two copies differ by, in the only unit that means anything: lines. */
export function describeDiskChange(local: string, disk: string): string {
  const d = lineDiff(local, disk);
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  if (d.added === 0 && d.removed === 0) return "The two copies are identical.";
  if (d.removed === 0) return `The file on disk has ${lines(d.added)} yours does not.`;
  if (d.added === 0) return `The file on disk is missing ${lines(d.removed)} of yours.`;
  return `The file on disk has ${lines(d.added)} yours does not, and is missing ${lines(
    d.removed
  )} of yours.`;
}

// "notes (copy).md" → "notes (copy 2).md", so resolving the same conflict twice
// does not produce "notes (copy) (copy).md".
const COPY_SUFFIX = /\s\(copy(?:\s(\d+))?\)$/;

/** The default filename offered by "Save a copy", which keeps both versions. */
export function copyNameFor(fileName: string): string {
  if (!fileName) return "untitled (copy).md";
  const dot = fileName.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension.
  const hasExt = dot > 0;
  const stem = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : "";

  const existing = stem.match(COPY_SUFFIX);
  if (existing) {
    const next = existing[1] ? Number(existing[1]) + 1 : 2;
    return `${stem.replace(COPY_SUFFIX, "")} (copy ${next})${ext}`;
  }
  return `${stem} (copy)${ext}`;
}
