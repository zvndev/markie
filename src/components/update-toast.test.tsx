import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { emit, installBridge } from "@/test/mock-bridge";
import { UpdateToast } from "./update-toast";

describe("UpdateToast", () => {
  it("shows nothing until the main process says an update is ready", () => {
    installBridge();
    const { container } = render(<UpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the restart prompt with the new version once one downloads", async () => {
    installBridge();
    render(<UpdateToast />);
    act(() => emit("update-ready", { version: "0.5.0" }));

    expect(await screen.findByText("Update ready (0.5.0)")).toBeInTheDocument();
    expect(
      screen.getByText(/A new version of Markie has downloaded/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart & update" })).toBeEnabled();
  });

  it("installs when the user restarts", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      // a successful install never resolves — the process is gone
      quitAndInstall: vi.fn(() => new Promise<never>(() => {})),
    });
    render(<UpdateToast />);
    act(() => emit("update-ready", { version: "0.5.0" }));

    await user.click(await screen.findByRole("button", { name: "Restart & update" }));
    expect(bridge.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Restarting…" })).toBeDisabled();
  });

  it("explains the failure and offers a retry when the install is refused", async () => {
    const user = userEvent.setup();
    installBridge({
      quitAndInstall: vi.fn(async () => ({ ok: false, error: "Another window is busy." })),
    });
    render(<UpdateToast />);
    act(() => emit("update-ready", { version: "0.5.0" }));

    await user.click(await screen.findByRole("button", { name: "Restart & update" }));
    expect(await screen.findByText("Another window is busy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("collapses to a sticky pill on Later and never dismisses itself", async () => {
    const user = userEvent.setup();
    installBridge();
    render(<UpdateToast />);
    act(() => emit("update-ready", { version: "0.5.0" }));

    await user.click(await screen.findByRole("button", { name: "Later" }));
    const pill = screen.getByRole("button", { name: /Update ready/ });
    expect(pill).toHaveAttribute("title", "A Markie update is ready to install");
    expect(screen.queryByRole("button", { name: "Restart & update" })).toBeNull();

    // and it re-expands on click — the only way out is installing
    await user.click(pill);
    expect(screen.getByRole("button", { name: "Restart & update" })).toBeInTheDocument();
  });

  it("recovers the prompt when the restart silently does nothing", async () => {
    vi.useFakeTimers();
    try {
      installBridge({ quitAndInstall: vi.fn(() => new Promise<never>(() => {})) });
      render(<UpdateToast />);
      act(() => emit("update-ready", { version: "0.5.0" }));
      const button = screen.getByRole("button", { name: "Restart & update" });
      await act(async () => {
        button.click();
      });
      await act(async () => {
        vi.advanceTimersByTime(21_000);
      });
      expect(screen.getByText(/Markie is still running/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes from the update channel on unmount", async () => {
    installBridge();
    const { unmount } = render(<UpdateToast />);
    await waitFor(() => expect(screen.queryByText("nothing")).toBeNull());
    unmount();
    act(() => emit("update-ready", { version: "0.5.0" }));
    expect(screen.queryByText(/Update ready/)).toBeNull();
  });
});
