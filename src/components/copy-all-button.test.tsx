import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyAllButton } from "./copy-all-button";

function stubClipboard(impl: (text: string) => Promise<void> = async () => {}) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyAllButton", () => {
  it("copies the raw text and says Copied for a moment", async () => {
    const writeText = stubClipboard();
    render(<CopyAllButton text={"# Title\n\n**bold** text"} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("# Title\n\n**bold** text");
    const button = screen.getByRole("button", { name: "Copied" });
    expect(button).toHaveAttribute("data-copied", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Document copied");
  });

  it("goes back to Copy all after the feedback", async () => {
    stubClipboard();
    render(<CopyAllButton text="hello" />);
    vi.useFakeTimers();
    await act(async () => {
      screen.getByRole("button", { name: "Copy all" }).click();
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1600); });
    expect(screen.getByRole("button", { name: "Copy all" })).toBeInTheDocument();
  });

  it("says so when the clipboard refuses", async () => {
    stubClipboard(async () => { throw new Error("denied"); });
    render(<CopyAllButton text="hello" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(screen.getByRole("button", { name: "Couldn't copy" })).toBeInTheDocument();
  });
});
