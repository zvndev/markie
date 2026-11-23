// Both copies of a document changed: the phone's edit and the cloud copy.
//
// This is the desktop's conflict dialog (src/components/conflict-dialog.tsx)
// as a sheet. It reads the cloud copy, says what each choice costs in lines
// with the desktop's own comparison (src/lib/line-diff.ts), and leads with
// the one choice that cannot lose work. Nothing is merged, ever.
//
// - Keep both: their version becomes a second document, then this one takes
//   the cloud copy. In that order, so a failure leaves them with what they had.
// - Keep mine: the cloud version is read again and their version is saved on
//   top of it.
// - Take the cloud copy: their version is dropped. Refused while their edit
//   never reached the server, exactly as the desktop refuses it.
import { useCallback, useEffect, useRef, useState } from "react";
import { describeDiff, lineDiff } from "@/lib/line-diff";
import { ApiError, type ApiClient } from "../lib/api";
import type { CloudDoc } from "../lib/docs";
import { haptics } from "../lib/native";
import { keepBothName, offlineOf, TAKE_CLOUD_REFUSAL } from "../lib/offline-api";
import { displayName } from "../lib/recent";
import { Sheet } from "./sheet";

export type ConflictChoice = "keep-both" | "keep-mine" | "take-cloud";

export interface ConflictOutcome {
  choice: ConflictChoice;
  /** Keep both: the second document that now holds their version. */
  copy?: { id: string; name: string; queued: boolean };
}

interface ConflictSheetProps {
  api: ApiClient;
  id: string;
  name: string;
  /** The editor's text, or the edit kept on the phone: what the person means by "mine". */
  mine: string;
  onClose: () => void;
  /** The document now holds something else; the screen underneath reads it again. */
  onResolved: (outcome: ConflictOutcome) => void;
  onUnauthorized: () => void;
}

type Stage =
  | { kind: "loading" }
  | { kind: "ready"; summary: string; identical: boolean }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string; outcome: ConflictOutcome };

/** What a failed step says. Nothing was changed in any of these cases. */
export function conflictErrorCopy(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return "You're offline. Nothing was changed. Try again when you're back online.";
  if (error instanceof ApiError && error.code === "unpushed") return error.message;
  if (error instanceof ApiError && error.status === 409) return "The cloud copy changed again. Nothing was changed.";
  return error instanceof Error && error.message ? `${error.message} Nothing was changed.` : "That didn't work. Nothing was changed.";
}

/** The three choices over a plain client, for a phone whose store couldn't open. */
function plainActions(api: ApiClient) {
  return {
    pending: () => null,
    cloudCopy: (id: string) => api.doc(id),
    async keepBoth(id: string, mine: string) {
      const cloud = await api.doc(id);
      const name = keepBothName(cloud.name, () => false) ?? `${cloud.name} (my version)`;
      const copy = await api.createDoc({ name, content: mine });
      return { copy: { id: copy.id, name, queued: false }, cloud };
    },
    async keepMine(id: string, mine: string) {
      const cloud = await api.doc(id);
      if (cloud.version === null) throw new ApiError(409, "The server didn't say which version this document is at.");
      return api.saveDoc({ id, name: cloud.name, content: mine, baseVersion: cloud.version });
    },
    takeCloud: (id: string): Promise<CloudDoc> => api.doc(id),
  };
}

export function ConflictSheet({ api, id, name, mine, onClose, onResolved, onUnauthorized }: ConflictSheetProps) {
  const actions = offlineOf(api) ?? plainActions(api);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [busy, setBusy] = useState<ConflictChoice | null>(null);
  // Their text as it stood when the sheet opened, so the line counts they
  // read are the counts of the copy "Keep both" rescues.
  const [frozen] = useState(mine);
  const run = useRef(0);
  const keepBoth = useRef<HTMLButtonElement>(null);
  const title = displayName(name);
  // Their edit never reached the server, so the cloud copy is strictly older
  // than it: taking the cloud copy would delete the only copy.
  const unpushed = actions.pending(id) === "unpushed";

  const compare = useCallback(async () => {
    const ticket = ++run.current;
    setStage({ kind: "loading" });
    try {
      const cloud = await actions.cloudCopy(id);
      if (ticket !== run.current) return;
      const diff = lineDiff(frozen, cloud.content);
      setStage({ kind: "ready", summary: describeDiff(diff), identical: diff.added === 0 && diff.removed === 0 });
    } catch (error) {
      if (ticket !== run.current) return;
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      setStage({
        kind: "error",
        message: error instanceof ApiError && error.status === 0
          ? "You're offline, so the cloud copy can't be read. Your version is kept on this phone. Try again when you're back online."
          : "Couldn't read the cloud copy. Your version is kept on this phone.",
      });
    }
    // The sheet is for one document and one text for its whole life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, frozen]);

  useEffect(() => {
    void compare();
    const token = run;
    return () => { token.current += 1; };
  }, [compare]);

  // Return lands on the choice that cannot lose anything.
  useEffect(() => {
    if (stage.kind === "ready") keepBoth.current?.focus();
  }, [stage.kind]);

  const act = async (choice: ConflictChoice) => {
    if (busy) return;
    setBusy(choice);
    try {
      if (choice === "keep-both") {
        const result = await actions.keepBoth(id, frozen);
        haptics.success();
        const copyTitle = displayName(result.copy.name);
        setStage({
          kind: "done",
          outcome: { choice, copy: result.copy },
          message: result.copy.queued
            ? `Your version is now "${copyTitle}". It is kept on this phone and goes out when you're back online. "${title}" has the cloud copy.`
            : `Your version is now "${copyTitle}". "${title}" has the cloud copy.`,
        });
        return;
      }
      if (choice === "keep-mine") await actions.keepMine(id, frozen);
      else await actions.takeCloud(id);
      haptics.success();
      onResolved({ choice });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      setStage({ kind: "error", message: conflictErrorCopy(error) });
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (busy) return;
    if (stage.kind === "done") onResolved(stage.outcome);
    else onClose();
  };

  return (
    <Sheet title={`Both copies of ${title} changed`} onClose={close} closeLabel={stage.kind === "done" ? "Done" : "Not now"} className="m-conflict-sheet">
      <div className="m-conflict" data-conflict-stage={stage.kind}>
        {stage.kind === "loading" ? <p className="m-conflict-note" role="status"><span className="m-spinner m-spinner-small" aria-hidden="true" />Comparing with the cloud copy…</p> : null}

        {stage.kind === "error" ? (
          <>
            <p className="m-conflict-error" role="alert">{stage.message}</p>
            <button type="button" className="m-button m-button-secondary" onClick={() => void compare()}>Try again</button>
          </>
        ) : null}

        {stage.kind === "done" ? (
          <>
            <p className="m-conflict-summary" role="status" data-conflict-done>{stage.message}</p>
            <button type="button" className="m-button m-button-primary" onClick={() => onResolved(stage.outcome)}>OK</button>
          </>
        ) : null}

        {stage.kind === "ready" ? (
          <>
            <p className="m-conflict-summary" data-conflict-summary>{stage.summary}</p>
            <p className="m-conflict-note">
              {stage.identical
                ? "Nothing of yours would be lost."
                : `Keep both saves your version as a second document, then puts the cloud copy in "${title}". Nothing is lost.`}
            </p>
            <div className="m-conflict-choices">
              <button ref={keepBoth} type="button" className="m-button m-button-primary" data-conflict-choice="keep-both" disabled={!!busy} onClick={() => void act("keep-both")}>
                {busy === "keep-both" ? "Working…" : "Keep both"}
              </button>
              <button type="button" className="m-button m-button-secondary" data-conflict-choice="keep-mine" disabled={!!busy} onClick={() => void act("keep-mine")}>
                {busy === "keep-mine" ? "Working…" : "Keep mine"}
              </button>
              <p className="m-conflict-hint">Saves your version over the cloud copy.</p>
              <button type="button" className="m-button m-button-secondary m-conflict-take" data-conflict-choice="take-cloud" disabled={!!busy || unpushed} onClick={() => void act("take-cloud")}>
                {busy === "take-cloud" ? "Working…" : "Take the cloud copy"}
              </button>
              <p className="m-conflict-hint" data-conflict-refusal={unpushed ? "" : undefined}>
                {unpushed ? TAKE_CLOUD_REFUSAL : "Deletes your version."}
              </p>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
