import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand } from "@/lib/commands";
import { CommandPalette } from "./command-palette";

function commands(): AppCommand[] {
  return [
    { id: "save", title: "Save", group: "File", shortcut: "⌘S", run: vi.fn() },
    { id: "save-as", title: "Save As…", group: "File", shortcut: "⇧⌘S", run: vi.fn() },
    { id: "toggle-preview", title: "Toggle Preview", group: "View", run: vi.fn() },
  ];
}

describe("CommandPalette", () => {
  it("is a labelled modal dialog listing every command", () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: "FileSave⌘S" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("⌘S")).toBeInTheDocument();
  });

  it("filters as the user types and points aria-activedescendant at the match", async () => {
    const user = userEvent.setup();
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    await user.keyboard("preview");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Toggle Preview");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "aria-activedescendant",
      "markie-command-toggle-preview"
    );
  });

  it("shows an empty state when nothing matches", async () => {
    const user = userEvent.setup();
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    await user.keyboard("zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No commands match")).toBeInTheDocument();
  });

  it("runs the arrow-selected command on Enter, after closing", async () => {
    const user = userEvent.setup();
    const list = commands();
    const onClose = vi.fn();
    render(<CommandPalette commands={list} onClose={onClose} />);

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
    // the palette closes first, then the command runs (deferred, so focus is
    // back in the editor by the time it does)
    await waitFor(() => expect(list[1].run).toHaveBeenCalledTimes(1));
    expect(list[0].run).not.toHaveBeenCalled();
  });

  it("clamps arrow navigation at both ends of the list", async () => {
    const user = userEvent.setup();
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);

    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
  });

  it("runs a clicked command", async () => {
    const user = userEvent.setup();
    const list = commands();
    const onClose = vi.fn();
    render(<CommandPalette commands={list} onClose={onClose} />);
    await user.click(screen.getByRole("option", { name: /Toggle Preview/ }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(list[2].run).toHaveBeenCalledTimes(1));
  });

  it("closes on Escape and on a click outside the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <CommandPalette commands={commands()} onClose={onClose} />
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close when the panel itself is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands()} onClose={onClose} />);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
