import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "@/lib/autosave";

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves once after the idle delay", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    a.noteChange();
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(a.isPending()).toBe(false);
  });

  it("resets the idle timer on each change but honors maxWait", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save, idleMs: 1000, maxWaitMs: 5000 });
    // Type every 500ms forever; the idle timer alone would never fire.
    for (let i = 0; i < 9; i++) {
      a.noteChange();
      await vi.advanceTimersByTimeAsync(500);
    }
    // 4500ms into the burst; maxWait forces a save at 5000ms.
    expect(save).not.toHaveBeenCalled();
    a.noteChange();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush saves immediately when dirty and is a no-op when clean", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    await expect(a.flush()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    a.noteChange();
    await expect(a.flush()).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1); // timer was cleared by flush
  });

  it("changes during an in-flight save trigger one follow-up save", async () => {
    let release!: (v: boolean) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((r) => (release = r))
      )
      .mockImplementation(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    await vi.advanceTimersByTimeAsync(1000); // first save starts, hangs
    a.noteChange(); // edit while saving
    release(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("never runs two saves at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    const releases: Array<() => void> = [];
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          releases.push(() => {
            inFlight -= 1;
            resolve(true);
          });
        })
    );
    const a = createAutosave({ save });
    a.noteChange();
    await vi.advanceTimersByTimeAsync(1000);
    a.noteChange();
    void a.flush(); // asks for a second save while the first still hangs
    expect(save).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await vi.runAllTimersAsync();
    expect(overlapped).toBe(false);
  });

  it("cancel drops pending work silently", async () => {
    const save = vi.fn(async () => true);
    const a = createAutosave({ save });
    a.noteChange();
    a.cancel();
    await vi.runAllTimersAsync();
    expect(save).not.toHaveBeenCalled();
  });

  it("a save that reports false stays quiet until the next change", async () => {
    const save = vi.fn(async () => false);
    const a = createAutosave({ save });
    a.noteChange();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    // No retry loop: a refused save (disk conflict) waits for the caller to
    // resolve the situation and call noteChange again.
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a save that throws resolves false rather than escaping", async () => {
    const save = vi.fn(async () => {
      throw new Error("disk on fire");
    });
    const a = createAutosave({ save });
    a.noteChange();
    await expect(a.flush()).resolves.toBe(false);
    // The scheduler is usable afterwards: a thrown save must not wedge the chain.
    const ok = vi.fn(async () => true);
    const b = createAutosave({ save: ok });
    b.noteChange();
    await expect(b.flush()).resolves.toBe(true);
  });

  it("isPending covers both the waiting timer and the in-flight write", async () => {
    let release!: (v: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const a = createAutosave({ save });
    expect(a.isPending()).toBe(false);
    a.noteChange();
    expect(a.isPending()).toBe(true); // timer waiting
    await vi.advanceTimersByTimeAsync(1000);
    expect(a.isPending()).toBe(true); // write in flight
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.isPending()).toBe(false);
  });
});
