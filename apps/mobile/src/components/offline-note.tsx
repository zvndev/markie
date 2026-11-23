// What the screens say about the copies kept on this phone (offline-store.ts):
// the quiet mark on a Recent row, the line above an offline list, and the
// note on a document that came from the phone or holds an edit the server
// has not taken. They say "offline" and offer what still works.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { longAgo } from "@/lib/relative-time";
import { ApiError, type ApiClient } from "../lib/api";
import type { CloudDoc } from "../lib/docs";
import { offlineInfo, offlineOf, type OfflineMark, type OfflineSnapshot } from "../lib/offline-api";
import { displayName } from "../lib/recent";
import { ConflictSheet } from "./conflict-sheet";

const noSubscription = () => () => undefined;
const noSnapshot = () => null;

/** The store's state for a screen, or null on a phone whose store couldn't open. */
export function useOffline(api: ApiClient): OfflineSnapshot | null {
  const handle = offlineOf(api);
  return useSyncExternalStore(handle ? handle.subscribe : noSubscription, handle ? handle.snapshot : noSnapshot);
}

const MARK_LABEL: Record<OfflineMark, string> = {
  kept: "Available offline",
  unpushed: "Not sent yet",
  conflict: "Needs a choice",
  refused: "Not sent",
};

/** On a Recent row: a small arrow for a document that opens offline, words for one that needs attention. */
export function OfflineRowMark({ mark }: { mark: OfflineMark | undefined }) {
  if (!mark) return null;
  if (mark !== "kept") return <span className={`m-offline-badge is-${mark}`} data-offline-mark={mark}>{MARK_LABEL[mark]}</span>;
  return (
    <span className="m-offline-mark" role="img" aria-label={MARK_LABEL.kept} title={MARK_LABEL.kept} data-offline-mark="kept">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5" />
      </svg>
    </span>
  );
}

/** Above a list that came from the phone. */
export function OfflineListNote({ offline }: { offline: OfflineSnapshot | null }) {
  if (!offline || offline.listSavedAt === null) return null;
  return (
    <p className="m-offline-line" role="status" data-offline-list>
      {offline.offline ? "You're offline." : "Can't reach the server."} This is your list from {longAgo(offline.listSavedAt)}. Documents with the arrow still open.
    </p>
  );
}

interface OfflineNoteProps {
  api: ApiClient;
  doc: CloudDoc;
  /** The document changed (an edit went out, a choice was made): read it again. */
  onChanged: () => void;
  /** The document is no longer this account's to open: go back to the list. */
  onGone: () => void;
  onUnauthorized: () => void;
}

/** On a document: why this isn't simply the server's copy, and what can be done about it. */
export function OfflineNote({ api, doc, onChanged, onGone, onUnauthorized }: OfflineNoteProps) {
  const info = offlineInfo(doc);
  const handle = offlineOf(api);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!info || !handle) return null;
  const title = displayName(doc.name);

  const run = async (task: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await task());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
      setMessage(error instanceof ApiError && error.status === 0 ? "Still offline. Nothing was changed." : error instanceof Error ? error.message : "That didn't work. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  const send = () => run(async () => {
    const result = await handle.drain();
    onChanged();
    if (result.waiting > 0 && result.sent === 0 && result.conflicts === 0) return "Still offline. Your edit goes out on its own when the connection is back.";
    return null;
  });

  const rescue = () => run(async () => {
    const copy = await handle.rescue(doc.id);
    window.alert(copy.queued
      ? `Your edit is now "${displayName(copy.name)}". It is kept on this phone and goes out when you're back online.`
      : `Your edit is now "${displayName(copy.name)}".`);
    onGone();
    return null;
  });

  const discard = () => {
    if (!window.confirm(`Delete your unsent edit to "${title}"? This can't be undone.`)) return;
    void run(async () => { await handle.discard(doc.id); onChanged(); return null; });
  };

  let text: string;
  let actions: ReactNode = null;
  if (info.pending === "conflict") {
    text = "Both copies changed. This is your version, and it has not been sent.";
    actions = <button type="button" className="m-button m-button-small m-button-primary" onClick={() => setChoosing(true)}>Choose what to keep</button>;
  } else if (info.pending === "refused") {
    text = `Your edit can't be sent. ${info.reason ?? "The server refused it."} This is your version, kept on this phone.`;
    actions = (
      <>
        <button type="button" className="m-button m-button-small m-button-primary" disabled={busy} onClick={() => void rescue()}>Save as a new document</button>
        <button type="button" className="m-button m-button-small m-button-secondary" disabled={busy} onClick={discard}>Delete my edit</button>
      </>
    );
  } else if (info.pending === "unpushed") {
    text = info.behind
      ? "Your edit is kept on this phone and has not been sent. The cloud copy changed too."
      : "Your edit is kept on this phone. It goes out when you're back online.";
    actions = (
      <>
        <button type="button" className="m-button m-button-small m-button-secondary" disabled={busy} onClick={() => void send()}>{busy ? "Sending" : "Send now"}</button>
        {info.behind ? <button type="button" className="m-button m-button-small m-button-secondary" disabled={busy} onClick={() => setChoosing(true)}>Compare</button> : null}
      </>
    );
  } else {
    text = `You're offline. This is the copy kept on this phone ${longAgo(info.savedAt)}.`;
  }

  return (
    <>
      <div className={`m-offline-note${info.pending === "conflict" || info.pending === "refused" ? " is-attention" : ""}`} role="status" data-offline-note={info.pending ?? "kept"}>
        <p>{text}</p>
        {actions ? <div className="m-offline-note-actions">{actions}</div> : null}
        {message ? <p className="m-offline-note-message">{message}</p> : null}
      </div>
      {choosing ? (
        <ConflictSheet
          api={api}
          id={doc.id}
          name={doc.name}
          mine={doc.content}
          onClose={() => setChoosing(false)}
          onResolved={() => { setChoosing(false); onChanged(); }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
    </>
  );
}
