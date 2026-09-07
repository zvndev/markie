import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cachedCollabRuntime, loadCollabRuntime, useCollabRuntime } from "@/lib/collab-loader";

// The runtime chunk, with a way to make its next load fail: a packaged chunk
// can be missing or corrupt, and the loader must not remember that forever.
const chunk = vi.hoisted(() => ({ failNextLoad: false }));
vi.mock("@/lib/collab-runtime", async (importOriginal) => {
  if (chunk.failNextLoad) {
    chunk.failNextLoad = false;
    throw new Error("chunk missing");
  }
  return importOriginal();
});

describe("the live-session runtime loader", () => {
  // First in the file on purpose: vitest keeps a mock factory's result once
  // it has resolved, so the load that fails has to come before any that
  // succeeds.
  it("reports a load that failed and imports again for the next session", async () => {
    // A loader with nothing cached yet, as at launch.
    vi.resetModules();
    const loader = await import("@/lib/collab-loader");

    chunk.failNextLoad = true;
    const failed = renderHook(() => loader.useCollabRuntime(true));
    await waitFor(() => expect(failed.result.current.failed).toBe(true));
    expect(failed.result.current.runtime).toBeNull();
    expect(loader.cachedCollabRuntime()).toBeNull();

    // The rejection was not kept: the next session imports again and gets in.
    const next = renderHook(() => loader.useCollabRuntime(true));
    await waitFor(() => expect(next.result.current.runtime).not.toBeNull());
    expect(next.result.current.failed).toBe(false);
    expect(typeof next.result.current.runtime!.Y.Doc).toBe("function");
    expect(await loader.loadCollabRuntime()).toBe(next.result.current.runtime);
  });

  it("hands out nothing when no session is wanted", () => {
    const { result } = renderHook(() => useCollabRuntime(false));
    expect(result.current).toEqual({ runtime: null, failed: false });
    expect(cachedCollabRuntime()).toBeNull();
  });

  it("loads the runtime once, then answers on the first render", async () => {
    const first = renderHook(() => useCollabRuntime(true));
    expect(first.result.current).toEqual({ runtime: null, failed: false });
    await waitFor(() => expect(first.result.current.runtime).not.toBeNull());
    const runtime = first.result.current.runtime!;
    expect(typeof runtime.Y.Doc).toBe("function");
    expect(typeof runtime.WebsocketProvider).toBe("function");
    expect(typeof runtime.Collaboration.configure).toBe("function");
    expect(typeof runtime.CollaborationCaret.configure).toBe("function");
    expect(typeof runtime.selectionToAnchor).toBe("function");
    expect(typeof runtime.anchorToAbsolute).toBe("function");
    expect(await loadCollabRuntime()).toBe(runtime);
    expect(cachedCollabRuntime()).toBe(runtime);

    // A second session (a fresh mount, keyed per room) never sees the wait.
    const second = renderHook(() => useCollabRuntime(true));
    expect(second.result.current.runtime).toBe(runtime);
    expect(second.result.current.failed).toBe(false);
  });
});
