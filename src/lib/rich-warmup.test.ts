import { describe, expect, it, vi } from "vitest";
import { TIMED_OUT_BATCH, warmBlocks, type IdleDeadline, type IdleScheduler } from "./rich-warmup";

// An idle scheduler the test drives by hand: nothing runs until `fire` is
// called with the deadline the browser would have handed over.
function fakeScheduler() {
  const queue: Array<(deadline: IdleDeadline) => void> = [];
  const cancelled: number[] = [];
  let handles = 0;
  const scheduler: IdleScheduler = {
    request: (cb) => {
      queue.push(cb);
      return ++handles;
    },
    cancel: (handle) => {
      cancelled.push(handle);
    },
  };
  const fire = (deadline: IdleDeadline) => {
    const cb = queue.shift();
    if (!cb) throw new Error("nothing scheduled");
    cb(deadline);
  };
  return { scheduler, fire, queue, cancelled };
}

const doc = (blocks: number) =>
  Array.from({ length: blocks }, (_, i) => `Paragraph ${i}.`).join("\n\n") + "\n";

const plenty: IdleDeadline = { timeRemaining: () => 50, didTimeout: false };
const none: IdleDeadline = { timeRemaining: () => 0, didTimeout: false };
const timedOut: IdleDeadline = { timeRemaining: () => 0, didTimeout: true };

describe("warmBlocks", () => {
  it("normalizes every block when there is time, and stops asking once done", () => {
    const { scheduler, fire, queue } = fakeScheduler();
    const normalize = vi.fn((b: string) => b);
    warmBlocks(doc(5), normalize, scheduler);
    expect(queue).toHaveLength(1);
    fire(plenty);
    expect(normalize).toHaveBeenCalledTimes(5);
    expect(queue).toHaveLength(0);
  });

  it("does a bounded amount per slice and reschedules the rest", () => {
    const { scheduler, fire, queue } = fakeScheduler();
    const normalize = vi.fn((b: string) => b);
    // Two blocks' worth of time, then the deadline is up.
    let calls = 0;
    const twoBlocks: IdleDeadline = {
      timeRemaining: () => (calls++ < 2 ? 10 : 0),
      didTimeout: false,
    };
    warmBlocks(doc(100), normalize, scheduler);
    fire(twoBlocks);
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(1);
    fire(none);
    // No time at all and not timed out: nothing done, but still rescheduled.
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(1);
  });

  it("still makes progress when the browser fired it on the timeout", () => {
    const { scheduler, fire } = fakeScheduler();
    const normalize = vi.fn((b: string) => b);
    warmBlocks(doc(100), normalize, scheduler);
    fire(timedOut);
    expect(normalize).toHaveBeenCalledTimes(TIMED_OUT_BATCH);
    expect(normalize.mock.calls[0][0]).toBe("Paragraph 0.");
    expect(normalize.mock.calls[TIMED_OUT_BATCH - 1][0]).toBe(`Paragraph ${TIMED_OUT_BATCH - 1}.`);
  });

  it("stops at cancel and cancels the pending slot", () => {
    const { scheduler, fire, queue, cancelled } = fakeScheduler();
    const normalize = vi.fn((b: string) => b);
    const cancel = warmBlocks(doc(100), normalize, scheduler);
    fire(timedOut);
    expect(queue).toHaveLength(1);
    cancel();
    expect(cancelled).toEqual([2]);
    // A slice that fires anyway (the cancel raced it) does nothing.
    fire(plenty);
    expect(normalize).toHaveBeenCalledTimes(TIMED_OUT_BATCH);
  });

  it("does nothing for an empty document or without a scheduler", () => {
    const { scheduler, queue } = fakeScheduler();
    const normalize = vi.fn((b: string) => b);
    warmBlocks("\n\n", normalize, scheduler);
    expect(queue).toHaveLength(0);
    expect(warmBlocks(doc(3), normalize, null)).toBeTypeOf("function");
    expect(normalize).not.toHaveBeenCalled();
  });
});
