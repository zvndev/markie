// A file on this phone changed while it was open in the editor: another app
// saved it, or iCloud brought in a newer version. Nothing was written. This
// is the cloud conflict sheet (conflict-sheet.tsx) for a local file: it says
// what each choice costs in lines, leads with the one that cannot lose work,
// and never merges.
//
// - Keep both (in a folder): the text typed here becomes a second file beside
//   the first, which is left as it is.
// - Keep mine: the text typed here is written over the file.
// - Take the file's version: the text typed here is dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { lineDiff } from "@/lib/line-diff";
import { haptics } from "../lib/native";
import type { LocalEditing } from "../lib/local-editing";
import { LocalFileError } from "../lib/local-files";
import { displayName } from "../lib/recent";
import { Sheet } from "./sheet";

type Stage =
  | { kind: "loading" }
  | { kind: "ready"; summary: string; identical: boolean }
  | { kind: "gone" }
  | { kind: "error"; message: string }
  | { kind: "kept"; message: string; gone: boolean };

/** What the comparison says, in lines. `added` is in the file and not in the editor; `removed` the other way. */
export function localDiffSummary({ added, removed }: { added: number; removed: number }): string {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  if (added === 0 && removed === 0) return "The file and your version are the same.";
  if (removed === 0) return `The file has ${lines(added)} your version doesn't.`;
  if (added === 0) return `Your version has ${lines(removed)} the file doesn't.`;
  return `Your version has ${lines(removed)} the file doesn't, and the file has ${lines(added)} yours doesn't.`;
}

export function LocalConflictSheet({ local, name, mine, onClose }: { local: LocalEditing; name: string; mine: string; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  // The text as it stood when the sheet opened: the counts read are the counts of what is kept.
  const [frozen] = useState(mine);
  const run = useRef(0);
  const first = useRef<HTMLButtonElement>(null);
  const title = displayName(name);

  const compare = useCallback(async () => {
    const ticket = ++run.current;
    setStage({ kind: "loading" });
    try {
      const theirs = await local.current();
      if (ticket !== run.current) return;
      const diff = lineDiff(frozen, theirs);
      setStage({ kind: "ready", summary: localDiffSummary(diff), identical: diff.added === 0 && diff.removed === 0 });
    } catch (error) {
      if (ticket !== run.current) return;
      if (error instanceof LocalFileError && (error.code === "missing" || error.code === "unreachable")) { setStage({ kind: "gone" }); return; }
      setStage({ kind: "error", message: "Markie couldn't read the file to compare. Your text is still here." });
    }
  }, [local, frozen]);

  useEffect(() => {
    void compare();
    const token = run;
    return () => { token.current += 1; };
  }, [compare]);
  useEffect(() => { if (stage.kind === "ready") first.current?.focus(); }, [stage.kind]);

  const act = async (choice: "keep-both" | "keep-mine" | "take-file", gone = false) => {
    if (busy) return;
    setBusy(choice);
    try {
      if (choice === "keep-both" && local.keepBoth) {
        const copy = await local.keepBoth(frozen);
        haptics.success();
        setStage({ kind: "kept", gone, message: gone ? `Your version is now "${displayName(copy.name)}", in the same folder.` : `Your version is now "${displayName(copy.name)}", in the same folder. "${title}" is as the other app left it.` });
        return;
      }
      if (choice === "keep-mine") await local.save(frozen, { overwrite: true });
      else await local.takeFile();
      haptics.success();
    } catch (error) {
      setStage({ kind: "error", message: `${error instanceof Error && error.message ? error.message : "That didn't work."} Nothing was changed.` });
    } finally {
      setBusy(null);
    }
  };

  const finishKept = async (gone: boolean) => {
    if (gone) { local.leave(); return; }
    try {
      await local.takeFile();
    } catch {
      local.leave();
    }
  };

  const close = () => {
    if (busy) return;
    if (stage.kind === "kept") void finishKept(stage.gone);
    else onClose();
  };

  return (
    <Sheet title={stage.kind === "gone" ? `${title} is gone` : `${title} changed`} onClose={close} closeLabel={stage.kind === "kept" ? "Done" : "Not now"} className="m-conflict-sheet">
      <div className="m-conflict" data-local-conflict={stage.kind}>
        {stage.kind === "loading" ? <p className="m-conflict-note" role="status"><span className="m-spinner m-spinner-small" aria-hidden="true" />Comparing with the file…</p> : null}

        {stage.kind === "error" ? (
          <>
            <p className="m-conflict-error" role="alert">{stage.message}</p>
            <button type="button" className="m-button m-button-secondary" onClick={() => void compare()}>Try again</button>
          </>
        ) : null}

        {stage.kind === "kept" ? (
          <>
            <p className="m-conflict-summary" role="status">{stage.message}</p>
            <button type="button" className="m-button m-button-primary" onClick={() => void finishKept(stage.gone)}>OK</button>
          </>
        ) : null}

        {stage.kind === "gone" ? (
          <>
            <p className="m-conflict-summary">This file was moved or deleted, or Markie can't reach it any more. Your text is still here.</p>
            {local.keepBoth ? (
              <div className="m-conflict-choices">
                <button type="button" className="m-button m-button-primary" disabled={!!busy} onClick={() => void act("keep-both", true)}>
                  {busy ? "Working…" : "Save as a new file in this folder"}
                </button>
              </div>
            ) : <p className="m-conflict-note">Copy your text somewhere safe before you close the editor.</p>}
          </>
        ) : null}

        {stage.kind === "ready" ? (
          <>
            <p className="m-conflict-summary" data-conflict-summary>Another app changed this file while you were editing. {stage.summary}</p>
            <p className="m-conflict-note">
              {local.keepBoth
                ? "Keep both saves your version as a second file in the same folder and leaves this one alone. Nothing is lost."
                : "Nothing has been written. Not now leaves your text in the editor."}
            </p>
            <div className="m-conflict-choices">
              {local.keepBoth ? (
                <button ref={first} type="button" className="m-button m-button-primary" data-conflict-choice="keep-both" disabled={!!busy} onClick={() => void act("keep-both")}>
                  {busy === "keep-both" ? "Working…" : "Keep both"}
                </button>
              ) : null}
              <button ref={local.keepBoth ? undefined : first} type="button" className="m-button m-button-secondary" data-conflict-choice="keep-mine" disabled={!!busy} onClick={() => void act("keep-mine")}>
                {busy === "keep-mine" ? "Working…" : "Keep mine"}
              </button>
              <p className="m-conflict-hint">Writes your version over the file.</p>
              <button type="button" className="m-button m-button-secondary m-conflict-take" data-conflict-choice="take-file" disabled={!!busy} onClick={() => void act("take-file")}>
                {busy === "take-file" ? "Working…" : "Take the file's version"}
              </button>
              <p className="m-conflict-hint">Deletes your version.</p>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
