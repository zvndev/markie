// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./error-boundary";

function Boom(): React.ReactElement {
  throw new Error("kaboom in the preview");
}

describe("ErrorBoundary", () => {
  // React logs the caught error itself; keep the suite output readable.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("all good")).toBeTruthy();
  });

  it("shows the fallback with the error message when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Markie hit an error")).toBeTruthy();
    expect(document.body.textContent).toContain("kaboom in the preview");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy details" })).toBeTruthy();
  });

  it("says what is and is not at risk, with the stack behind a disclosure", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(document.body.textContent).toContain(
      "Your file on disk is untouched, but changes you hadn't saved may be lost."
    );
    const details = document.querySelector("details");
    expect(details).toBeTruthy();
    // closed by default: the trace is available, not in the way
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText("Show details")).toBeTruthy();
  });

  it("renders a caller's fallback instead of the full-window one", () => {
    render(
      <ErrorBoundary fallback={(error) => <p>pane broke: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText(/pane broke: kaboom in the preview/)).toBeTruthy();
    expect(screen.queryByText("Markie hit an error")).toBeNull();
  });

  it("reports the crash to main as { message, stack, componentStack, source }", () => {
    const logRendererError = vi.fn();
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      logRendererError,
    };
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      );
      expect(logRendererError).toHaveBeenCalled();
      const payload = logRendererError.mock.calls[0][0];
      expect(payload.message).toBe("kaboom in the preview");
      expect(typeof payload.stack).toBe("string");
      expect(typeof payload.componentStack).toBe("string");
      expect(payload.source).toBe("react");
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it("copies the details to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    screen.getByRole("button", { name: "Copy details" }).click();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("kaboom in the preview");
  });

  // Errors from event handlers and un-awaited promises never reach
  // componentDidCatch — the boundary logs them so they are not invisible in a
  // packaged build.
  it("logs uncaught window errors", () => {
    render(
      <ErrorBoundary global>
        <p>ok</p>
      </ErrorBoundary>
    );

    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("stray"), message: "stray" })
    );
    expect(console.error).toHaveBeenCalledWith("Uncaught error", expect.any(Error));
  });
});
