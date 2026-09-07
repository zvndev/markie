import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cachedCollabRuntime, loadCollabRuntime, useCollabRuntime } from "@/lib/collab-loader";

describe("the live-session runtime loader", () => {
  it("hands out nothing when no session is wanted", () => {
    const { result } = renderHook(() => useCollabRuntime(false));
    expect(result.current).toBeNull();
    expect(cachedCollabRuntime()).toBeNull();
  });

  it("loads the runtime once, then answers on the first render", async () => {
    const first = renderHook(() => useCollabRuntime(true));
    expect(first.result.current).toBeNull();
    await waitFor(() => expect(first.result.current).not.toBeNull());
    const runtime = first.result.current!;
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
    expect(second.result.current).toBe(runtime);
  });
});
