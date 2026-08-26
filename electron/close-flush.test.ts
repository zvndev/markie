import { describe, expect, it, vi } from "vitest";
const { createCloseFlusher } = require("./close-flush.js");

describe("createCloseFlusher", () => {
  it("destroys after the renderer reports ready", () => {
    vi.useFakeTimers();
    let ready: () => void = () => {};
    const destroy = vi.fn();
    const send = vi.fn();
    const f = createCloseFlusher({
      send,
      onReady: (cb: () => void) => {
        ready = cb;
      },
      timeoutMs: 2000,
      destroy,
    });
    f.requestClose();
    expect(send).toHaveBeenCalledWith("app-will-close");
    expect(destroy).not.toHaveBeenCalled();
    ready();
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(destroy).toHaveBeenCalledTimes(1); // late timeout is a no-op
    vi.useRealTimers();
  });

  it("destroys after the timeout when the renderer hangs", () => {
    vi.useFakeTimers();
    const destroy = vi.fn();
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: () => {},
      timeoutMs: 2000,
      destroy,
    });
    f.requestClose();
    vi.advanceTimersByTime(1999);
    expect(destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("requestClose is idempotent while pending", () => {
    const destroy = vi.fn();
    const send = vi.fn();
    const f = createCloseFlusher({ send, onReady: () => {}, timeoutMs: 2000, destroy });
    f.requestClose();
    f.requestClose();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports settled so the close handler stops intercepting", () => {
    let ready: () => void = () => {};
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: (cb: () => void) => {
        ready = cb;
      },
      timeoutMs: 2000,
      destroy: vi.fn(),
    });
    expect(f.isSettled()).toBe(false);
    f.requestClose();
    expect(f.isSettled()).toBe(false); // still waiting on the renderer
    ready();
    expect(f.isSettled()).toBe(true);
  });

  it("resumes the quit that its own preventDefault cancelled", () => {
    let ready: () => void = () => {};
    const destroy = vi.fn();
    const quit = vi.fn();
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: (cb: () => void) => {
        ready = cb;
      },
      timeoutMs: 2000,
      destroy,
      quitting: () => true,
      quit,
    });
    f.requestClose();
    expect(quit).not.toHaveBeenCalled(); // not until the document is safe
    ready();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("resumes the quit even when the renderer never answers", () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: () => {},
      timeoutMs: 2000,
      destroy: vi.fn(),
      quitting: () => true,
      quit,
    });
    f.requestClose();
    vi.advanceTimersByTime(2000);
    expect(quit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("closing a window on its own does not quit the app", () => {
    let ready: () => void = () => {};
    const quit = vi.fn();
    const f = createCloseFlusher({
      send: vi.fn(),
      onReady: (cb: () => void) => {
        ready = cb;
      },
      timeoutMs: 2000,
      destroy: vi.fn(),
      quitting: () => false,
      quit,
    });
    f.requestClose();
    ready();
    // On macOS a closed window leaves the app running by design; only a quit
    // that we interrupted may be restarted.
    expect(quit).not.toHaveBeenCalled();
  });

  it("a ready that arrives before any close request destroys nothing", () => {
    let ready: () => void = () => {};
    const destroy = vi.fn();
    createCloseFlusher({
      send: vi.fn(),
      onReady: (cb: () => void) => {
        ready = cb;
      },
      timeoutMs: 2000,
      destroy,
    });
    // A stray app-close-ready (a reload, a second window) must not close the app.
    ready();
    expect(destroy).not.toHaveBeenCalled();
  });
});
