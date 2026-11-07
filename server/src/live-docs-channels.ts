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
}

const byDoc = new Map<string, Set<LiveDocChannel>>();
let open = 0;

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
    if (set!.size === 0 && byDoc.get(docId) === set) byDoc.delete(docId);
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
