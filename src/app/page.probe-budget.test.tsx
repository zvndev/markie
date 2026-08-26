// The budget this pins: opening a document does no reconstruction-probe work
// on the synchronous path. The probe costs 152ms at the median and 2.9s at
// p99 over real files, and opening a document is the most common action in
// the app, so it must never be what the user waits for.
import { render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

// Wrap the real module so the verdict is genuine and only the call is watched.
vi.mock("@/lib/rich-safety", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rich-safety")>();
  return { ...real, resolveReconstruction: vi.fn(real.resolveReconstruction) };
});

import { clearReconstructionCache, resolveReconstruction } from "@/lib/rich-safety";
import Home from "./page";

const probe = vi.mocked(resolveReconstruction);
const OPEN = {
  name: "notes.md",
  path: "/notes/notes.md",
  content: "Wrapped\nprose lands here.\n\nAnother paragraph.\n",
};

beforeEach(() => {
  localStorage.clear();
  clearReconstructionCache();
  probe.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => vi.useRealTimers());

// Let promises and React work settle without letting any macrotask run, so the
// only thing that could call the probe is the synchronous open path itself.
async function settleMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe("document open budget", () => {
  it("paints the opened document before the probe has run at all", async () => {
    installBridge({ getInitialFile: vi.fn(async () => OPEN) } as Partial<ElectronAPI>);
    render(<Home />);
    await settleMicrotasks();

    // The document is on screen...
    expect(document.title).toBe("notes.md — Markie");
    expect(document.body.textContent).toContain("prose lands here");
    // ...and nothing has probed it yet. This is the budget.
    expect(probe).not.toHaveBeenCalled();

    // It resolves right after, off the critical path.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not probe again when the same document is reopened", async () => {
    const api = installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      openFile: vi.fn(async () => OPEN),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await settleMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(probe).toHaveBeenCalledTimes(1);

    // Open a different document, then come back to the first one.
    const other = { name: "b.md", path: "/notes/b.md", content: "Second document.\n" };
    vi.mocked(api.openFile).mockResolvedValueOnce(other);
    await act(async () => {
      emit("onMenuOpenFile");
    });
    await settleMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(probe).toHaveBeenCalledTimes(2);

    vi.mocked(api.openFile).mockResolvedValueOnce(OPEN);
    await act(async () => {
      emit("onMenuOpenFile");
    });
    await settleMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    // The verdict for the first document was remembered.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("prose lands here");
  });
});
