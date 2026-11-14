// The open tabs of hosted Live Docs, so losing access closes them at once.
//
// Every Live Doc page keeps one server-sent event stream open to its own host
// (live-docs.ts, LIVE_DOC_CHANNEL_PATH). Each stream re-checks access on a
// timer, and the routes that take access away (removing a member, rotating or
// revoking the public link, deleting the document) also call
// recheckLiveDocChannels, so a removed person's tab goes blank in the same
// moment rather than at the next tick.
//
// Dependency-free on purpose: shares.ts and docs.ts import it, and live-docs.ts
// imports shares.ts, so anything heavier here would close an import cycle.

export interface LiveDocChannel {
  /** Re-reads access from the database and closes the stream if it is gone. */
  recheck(): void;
  /** The document now has this version: tell the page if it shows an older one. No access check. */
  versionChanged(version: number): void;
}

const byDoc = new Map<string, Set<LiveDocChannel>>();
let open = 0;

/**
 * At most one "the document changed" notice per document per this interval.
 * The first write after a quiet spell goes out at once; writes after it fold
 * into one trailing notice carrying the newest version. A writer saving in a
 * loop therefore reloads its readers no faster than this, and the notice
 * costs one pass over the open pages, with no access checks (a write never
 * changes who may read).
 */
export const LIVE_DOC_UPDATE_INTERVAL_MS = 5_000;
const updates = new Map<string, { version: number; last: number; timer: ReturnType<typeof setTimeout> | null }>();

function sendUpdate(docId: string) {
  const pending = updates.get(docId);
  if (!pending) return;
  pending.timer = null;
  pending.last = Date.now();
  for (const channel of [...(byDoc.get(docId) ?? [])]) {
    try {
      channel.versionChanged(pending.version);
    } catch (error) {
      console.error("live doc update notice failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** A write gave `docId` this version. Called after the write commits. */
export function noteLiveDocWrite(docId: string, version: number, intervalMs = LIVE_DOC_UPDATE_INTERVAL_MS): void {
  if (!byDoc.has(docId)) {
    updates.delete(docId);
    return;
  }
  const pending = updates.get(docId) ?? { version, last: 0, timer: null };
  pending.version = Math.max(pending.version, version);
  updates.set(docId, pending);
  if (pending.timer) return;
  const wait = Math.max(0, pending.last + intervalMs - Date.now());
  pending.timer = setTimeout(() => sendUpdate(docId), wait);
  pending.timer.unref?.();
}

export function registerLiveDocChannel(docId: string, channel: LiveDocChannel): () => void {
  let set = byDoc.get(docId);
  if (!set) byDoc.set(docId, (set = new Set()));
  set.add(channel);
  open += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    open -= 1;
    set!.delete(channel);
    if (set!.size === 0 && byDoc.get(docId) === set) {
      byDoc.delete(docId);
      const pending = updates.get(docId);
      if (pending?.timer) clearTimeout(pending.timer);
      updates.delete(docId);
    }
  };
}

/** Re-checks every open tab of one document now. Safe to call for any id. */
export function recheckLiveDocChannels(docId: string): void {
  const set = byDoc.get(docId);
  if (!set) return;
  // A recheck can close and unregister its channel, so walk a copy.
  for (const channel of [...set]) {
    try {
      channel.recheck();
    } catch (error) {
      console.error("live doc recheck failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** How many Live Doc streams are open in this process. */
export function openLiveDocChannels(): number {
  return open;
}
