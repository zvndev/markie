// Normalize a document's blocks while the app is idle, a few at a time.
//
// The rich pane's first autosave flush would otherwise normalize every block
// (a parse plus a serialize each) in one go and stall the save. Warming the
// memo ahead of time is the right idea; doing it in a single idle callback was
// not. requestIdleCallback hands over a deadline, and the old loop never
// looked at it: for a document with thousands of blocks the "idle" callback
// ran for seconds, and it was one of the sweeps that made a big file feel
// frozen after it had already opened.
//
// This one works until the deadline says stop, gives the thread back, and asks
// for the next idle slot. When the browser gave up waiting and fired the
// callback on its timeout instead, the deadline reports no time at all, so a
// small fixed batch runs regardless: a busy app must still make progress, or
// the warm-up would reschedule itself forever and never touch a block.
import { splitTopLevelBlocks } from "@/lib/rich-block-preserve";

export interface IdleDeadline {
  timeRemaining(): number;
  didTimeout: boolean;
}

export interface IdleScheduler {
  request(callback: (deadline: IdleDeadline) => void, options?: { timeout: number }): number;
  cancel(handle: number): void;
}

// Stop once less than this is left; a normalize can take a few milliseconds.
const MIN_SLICE_MS = 1;
// What a callback that fired on its timeout still does.
export const TIMED_OUT_BATCH = 24;
// How long the browser may keep the warm-up waiting before it fires anyway.
const IDLE_TIMEOUT_MS = 1000;

export function windowIdleScheduler(): IdleScheduler | null {
  if (typeof window === "undefined" || typeof window.requestIdleCallback !== "function") return null;
  return {
    request: (cb, options) => window.requestIdleCallback(cb, options),
    cancel: (handle) => window.cancelIdleCallback?.(handle),
  };
}

/**
 * Warm the block memo for `text`, cooperatively. Returns a cancel function;
 * call it when the document changes, so a sweep never runs on behalf of a
 * document that is no longer open.
 */
export function warmBlocks(
  text: string,
  normalize: (block: string) => string,
  scheduler: IdleScheduler | null = windowIdleScheduler(),
  onDone?: () => void
): () => void {
  if (!scheduler) return () => {};
  const blocks = splitTopLevelBlocks(text)
    .map((block) => block.text.replace(/(?:\r?\n)+$/, ""))
    .filter((block) => block !== "");
  let next = 0;
  let cancelled = false;
  let handle: number | null = null;

  const slice = (deadline: IdleDeadline) => {
    if (cancelled) return;
    const forced = deadline.didTimeout ? TIMED_OUT_BATCH : 0;
    let done = 0;
    while (next < blocks.length && (done < forced || deadline.timeRemaining() > MIN_SLICE_MS)) {
      normalize(blocks[next]);
      next += 1;
      done += 1;
    }
    if (cancelled) return;
    if (next < blocks.length) {
      handle = scheduler.request(slice, { timeout: IDLE_TIMEOUT_MS });
    } else {
      handle = null;
      onDone?.();
    }
  };

  if (blocks.length > 0) handle = scheduler.request(slice, { timeout: IDLE_TIMEOUT_MS });
  else onDone?.();
  return () => {
    cancelled = true;
    if (handle !== null) scheduler.cancel(handle);
  };
}
