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

  it("still writes once on settle when the journal is off and the save did not land", async () => {
    const big = "x".repeat(300 * 1024);
    const draftSave = vi.fn<(entry: DraftCall) => void>();
    (window as unknown as { electronAPI?: unknown }).electronAPI = { draftSave };
    const mount = (save: () => Promise<boolean>) =>
      renderHook(() =>
        useSaveGuard({
          save,
          eligible: true,
          docKey: "/doc.md",
          document: { path: "/doc.md", name: "doc.md", content: big, dirty: true },
          booted: false,
          journal: false,
        })
      );

    // The save refused (a conflict, a read-only share): the buffer is the
    // only copy, so closing journals it once.
    const refused = mount(async () => false);
    act(() => refused.result.current.noteEdit());
    await act(() => refused.result.current.settle());
    expect(draftSave).toHaveBeenCalledTimes(1);
    expect(draftSave.mock.calls[0][0].content).toBe(big);
    refused.unmount();

    // The save landed: nothing to recover, so nothing is written.
    draftSave.mockClear();
    const landed = mount(async () => true);
    act(() => landed.result.current.noteEdit());
    await act(() => landed.result.current.settle());
    expect(draftSave).not.toHaveBeenCalled();
  });

  it("always journals a dirty document with no path on settle, whatever the journal setting", async () => {
    // An untitled document has nowhere to autosave to, and once it has grown
    // past the journal's size it has no periodic journal either. The write on
    // the way out is the only copy that survives closing it.
    const big = "x".repeat(300 * 1024);
    const draftSave = vi.fn<(entry: DraftCall) => void>();
    (window as unknown as { electronAPI?: unknown }).electronAPI = { draftSave };
    const { result } = renderHook(() =>
      useSaveGuard({
        save: async () => true,
        eligible: false,
        docKey: null,
        document: { path: null, name: null, content: big, dirty: true },
        booted: false,
        journal: false,
      })
    );
    await act(() => result.current.settle());
    expect(draftSave).toHaveBeenCalledTimes(1);
    expect(draftSave.mock.calls[0][0]).toEqual({ path: null, name: null, content: big });
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
