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
  it("is an icon button whose tooltip says Copy all", () => {
    render(<CopyAllButton text="hello" />);
    const button = screen.getByRole("button", { name: "Copy all" });
    expect(button).toHaveAttribute("title", "Copy all");
    expect(button.textContent).toBe("");
  });

  it("copies the raw text and says Copied for a moment", async () => {
    const writeText = stubClipboard();
    render(<CopyAllButton text={"# Title\n\n**bold** text"} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("# Title\n\n**bold** text");
    const button = screen.getByRole("button", { name: "Copied" });
    expect(button).toHaveAttribute("data-state", "copied");
    expect(button).toHaveAttribute("title", "Copied");
    expect(screen.getByRole("status")).toHaveTextContent("Document copied");
  });

  it("copies what read() returns at the moment of the click", async () => {
    const writeText = stubClipboard();
    render(<CopyAllButton text="stale" read={() => "fresh"} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("fresh");
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
    expect(screen.getByRole("button", { name: "Couldn't copy" })).toHaveAttribute("data-state", "failed");
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't copy the document");
  });

  it("is disabled when there is nothing to copy", async () => {
    const writeText = stubClipboard();
    render(<CopyAllButton text="" />);
    const button = screen.getByRole("button", { name: "Copy all" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Nothing to copy");
    await userEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });
});
