import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSaveGuard, type SaveGuardInputs } from "@/lib/use-save-guard";

interface DraftCall {
  path: string | null;
  name: string | null;
  content: string;
}

// The guard is mounted the way page.tsx mounts it, with the buffer arriving as
// a new prop on every keystroke. Nothing here is eligible to autosave: this is
// about the crash journal, which runs whether the file can be written or not.
function mountGuard(content: string) {
  const draftSave = vi.fn<(entry: DraftCall) => void>();
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    draftSave,
    draftCheck: vi.fn(() => Promise.resolve([])),
  };
  const inputs = (text: string): SaveGuardInputs => ({
    save: async () => true,
    eligible: false,
    docKey: "/doc.md",
    document: { path: "/doc.md", name: "doc.md", content: text, dirty: true },
    booted: false,
  });
  const view = renderHook((text: string) => useSaveGuard(inputs(text)), {
    initialProps: content,
  });
  return { ...view, draftSave };
}

/** Five edits, one every `gap` ms, the way a person typing produces them. */
function typeFiveTimes(
  rerender: (text: string) => void,
  base: string,
  gap: number
) {
  for (let i = 1; i <= 5; i += 1) {
    rerender(base + "y".repeat(i));
    act(() => {
      vi.advanceTimersByTime(gap);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("the crash journal's pace", () => {
  it("journals an ordinary document once per 250 ms window", () => {
    const small = "x".repeat(10 * 1024);
    const { rerender, draftSave } = mountGuard(small);
    typeFiveTimes(rerender, small, 250);
    expect(draftSave).toHaveBeenCalledTimes(5);
  });

  it("still coalesces a burst inside one window into a single write", () => {
    const small = "x".repeat(10 * 1024);
    const { rerender, draftSave } = mountGuard(small);
    typeFiveTimes(rerender, small, 20);
    expect(draftSave).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(draftSave).toHaveBeenCalledTimes(1);
  });

  it("slows to one write every 2 s once the buffer is big", () => {
    // Each journal write posts the whole buffer across the IPC boundary and
    // main writes it to disk. At a third of a megabyte, five of those in a
    // second is the stall; one is not. The largest documents skip the journal
    // altogether, which is the tier above this.
    const big = "x".repeat(300 * 1024);
    const { rerender, draftSave } = mountGuard(big);
    typeFiveTimes(rerender, big, 250);
    expect(draftSave).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(draftSave).toHaveBeenCalledTimes(1);
    // And what lands is the last thing typed, not an earlier version of it.
    expect(draftSave.mock.calls[0][0].content).toBe(big + "yyyyy");
  });

  it("writes nothing at all for a document the journal is off for", () => {
    const big = "x".repeat(300 * 1024);
    const draftSave = vi.fn<(entry: DraftCall) => void>();
    (window as unknown as { electronAPI?: unknown }).electronAPI = { draftSave };
    renderHook(() =>
      useSaveGuard({
        save: async () => true,
        eligible: false,
        docKey: "/doc.md",
        document: { path: "/doc.md", name: "doc.md", content: big, dirty: true },
        booted: false,
        journal: false,
      })
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(draftSave).not.toHaveBeenCalled();
  });
});
