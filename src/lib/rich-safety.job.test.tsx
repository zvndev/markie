import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBlockCache } from "@/lib/rich-roundtrip";
import { clearReconstructionCache, startReconstructionJob } from "@/lib/rich-safety";
import type { IdleDeadline, IdleScheduler } from "@/lib/rich-warmup";

function fakeScheduler() {
  const queue: Array<(deadline: IdleDeadline) => void> = [];
  let handles = 0;
  const cancelled: number[] = [];
  const scheduler: IdleScheduler = {
    request: (cb) => {
      queue.push(cb);
      return ++handles;
    },
    cancel: (handle) => {
      cancelled.push(handle);
    },
  };
  return { scheduler, queue, cancelled };
}

const plenty: IdleDeadline = { timeRemaining: () => 50, didTimeout: false };
const starved: IdleDeadline = { timeRemaining: () => 0, didTimeout: true };

const doc = (blocks: number) =>
  Array.from({ length: blocks }, (_, i) => `Paragraph number ${i} with *emphasis*.`).join("\n\n") + "\n";

beforeEach(() => {
  clearReconstructionCache();
  clearBlockCache();
});
afterEach(() => vi.useRealTimers());

describe("startReconstructionJob", () => {
  it("answers a remembered verdict at once, with nothing scheduled", () => {
    const { scheduler, queue } = fakeScheduler();
    const onDone = vi.fn();
    startReconstructionJob("Hello.\n", onDone, scheduler);
    while (queue.length) queue.shift()!(plenty);
    expect(onDone).toHaveBeenCalledWith(true);
    const again = vi.fn();
    startReconstructionJob("Hello.\n", again, scheduler);
    expect(again).toHaveBeenCalledWith(true);
    expect(queue).toHaveLength(0);
  });

  it("warms the blocks over several slices and only then runs the round trip", () => {
    const { scheduler, queue } = fakeScheduler();
    const onDone = vi.fn();
    startReconstructionJob(doc(60), onDone, scheduler);
    // Starved slices: a bounded batch each, the verdict not yet decided.
    let slices = 0;
    while (queue.length === 1 && !onDone.mock.calls.length && slices < 10) {
      queue.shift()!(starved);
      slices += 1;
    }
    expect(slices).toBeGreaterThan(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("does nothing more once cancelled", () => {
    const { scheduler, queue, cancelled } = fakeScheduler();
    const onDone = vi.fn();
    const job = startReconstructionJob(doc(60), onDone, scheduler);
    queue.shift()!(starved);
    expect(queue).toHaveLength(1);
    job.cancel();
    expect(cancelled).toContain(2);
    // The cancelled slot fires anyway (a cancel can race the callback).
    queue.shift()!(plenty);
    expect(queue).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("falls back to one macrotask without a scheduler", () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    startReconstructionJob("Plain paragraph.\n", onDone, null);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("reports an unreconstructable document as not clean", () => {
    const { scheduler, queue } = fakeScheduler();
    const onDone = vi.fn();
    startReconstructionJob("See [the docs][ref].\n\nUnrelated paragraph.\n\n[ref]: https://example.com\n", onDone, scheduler);
    while (queue.length) queue.shift()!(plenty);
    expect(onDone).toHaveBeenCalledWith(false);
  });
});
