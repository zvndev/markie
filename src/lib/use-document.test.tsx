import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDocument } from "@/lib/use-document";

describe("useDocument", () => {
  it("tracks dirty state across edit and markSaved", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.edit("one two"));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.markSaved("one two"));
    expect(result.current.isDirty).toBe(false);
  });

  it("load with unsaved keeps the buffer dirty (snapshot/draft restore)", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "fresh", path: "/a.md" }));
    act(() =>
      result.current.load({ name: "a.md", content: "old version", path: "/a.md", unsaved: true })
    );
    expect(result.current.content).toBe("old version");
    expect(result.current.isDirty).toBe(true);
  });

  it("applyExternal replaces content without dirtying", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    act(() => result.current.edit("local work"));
    act(() => result.current.applyExternal("server copy"));
    expect(result.current.content).toBe("server copy");
    expect(result.current.isDirty).toBe(false);
  });

  it("reset clears to an untitled buffer", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    act(() => result.current.reset());
    expect(result.current.filePath).toBeNull();
    expect(result.current.fileName).toBeNull();
    expect(result.current.content).toBe("");
    expect(result.current.isDirty).toBe(false);
  });

  it("edit accepts a functional update so a transform reads the live buffer", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    act(() => {
      result.current.edit("two");
      result.current.edit((prev) => `${prev} three`);
    });
    expect(result.current.content).toBe("two three");
  });

  it("setLocation moves the document without touching the buffer", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "body", path: "/a.md" }));
    act(() => result.current.setLocation("/b/copy.md", "copy.md"));
    expect(result.current.filePath).toBe("/b/copy.md");
    expect(result.current.fileName).toBe("copy.md");
    expect(result.current.content).toBe("body");
    expect(result.current.isDirty).toBe(false);
  });

  it("keeps the transition functions stable across renders", () => {
    const { result, rerender } = renderHook(() => useDocument());
    const first = result.current;
    act(() => result.current.edit("changed"));
    rerender();
    expect(result.current.edit).toBe(first.edit);
    expect(result.current.load).toBe(first.load);
    expect(result.current.applyExternal).toBe(first.applyExternal);
    expect(result.current.markSaved).toBe(first.markSaved);
    expect(result.current.reset).toBe(first.reset);
    expect(result.current.setLocation).toBe(first.setLocation);
  });
});

describe("useDocument.latest", () => {
  // Autosave fires from a timer and can beat React to a re-render. A save that
  // read `content` in that window wrote the document as it stood one
  // serializer tick ago, which on a flush-before-close is a lost tick.
  it("reports the last write, before the render that would show it", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "one", path: "/a.md" }));
    const before = result.current;
    // No act(): the state update is deliberately left unflushed.
    before.edit("two");
    expect(before.content).toBe("one"); // React has not caught up...
    expect(before.latest()).toBe("two"); // ...but the buffer has moved.
  });

  it("tracks every transition, not just typing", () => {
    const { result } = renderHook(() => useDocument());
    act(() => result.current.load({ name: "a.md", content: "loaded", path: "/a.md" }));
    expect(result.current.latest()).toBe("loaded");
    act(() => result.current.applyExternal("pulled"));
    expect(result.current.latest()).toBe("pulled");
    act(() => result.current.reset());
    expect(result.current.latest()).toBe("");
  });
});
