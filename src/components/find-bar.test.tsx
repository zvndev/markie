import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Match } from "@/lib/doc-search";
import type { FindTarget } from "@/lib/find-target";
import { FindBar } from "./find-bar";

type SpiedTarget = FindTarget & {
  highlight: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function makeTarget(text: string, caret = 0) {
  const state = { text };
  const target = {
    text: () => state.text,
    caret: () => caret,
    highlight: vi.fn(),
    reveal: vi.fn(),
    replace: vi.fn(),
    release: vi.fn(),
  } as unknown as SpiedTarget;
  return { target, state };
}

function renderBar(
  overrides: Partial<React.ComponentProps<typeof FindBar>> = {},
  text = "one two Two two three"
) {
  const { target, state } = makeTarget(text);
  const onClose = vi.fn();
  const props = {
    open: true,
    withReplace: false,
    target,
    canReplace: true,
    revision: "r0",
    onClose,
    ...overrides,
  };
  const view = render(<FindBar {...props} />);
  return { ...view, target, state, onClose, props };
}

describe("FindBar", () => {
  it("renders nothing while closed", () => {
    const { container } = renderBar({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("is a labelled search landmark with a focused query field", () => {
    renderBar();
    expect(screen.getByRole("search", { name: "Find in document" })).toBeInTheDocument();
    expect(screen.getByLabelText("Find")).toHaveFocus();
  });

  it("counts matches and highlights them as the user types", async () => {
    const user = userEvent.setup();
    const { target } = renderBar();

    await user.keyboard("two");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    const [matches, current] = target.highlight.mock.lastCall as [Match[], number];
    expect(matches).toHaveLength(3);
    expect(current).toBe(0);
    expect(target.reveal).toHaveBeenCalled();
  });

  it("reports no results and disables stepping for a query that misses", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard("zebra");
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByTitle("Next match (⏎)")).toBeDisabled();
    expect(screen.getByTitle("Previous match (⇧⏎)")).toBeDisabled();
  });

  it("steps forward and wraps with Enter", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard("two");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await user.keyboard("{Enter}{Enter}");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("steps backward with Shift+Enter", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard("two");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("narrows the match set when Match case is on", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard("two");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    const aa = screen.getByRole("button", { name: "Match case" });
    expect(aa).toHaveAttribute("aria-pressed", "false");
    await user.click(aa);
    expect(aa).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("narrows the match set when Whole word is on", async () => {
    const user = userEvent.setup();
    renderBar({}, "on one only on");
    await user.keyboard("on");
    expect(screen.getByText("1 of 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Whole word" }));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("hides the replace row until it is asked for", async () => {
    const user = userEvent.setup();
    renderBar();
    expect(screen.queryByLabelText("Replace with")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show replace" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByLabelText("Replace with")).toBeInTheDocument();
  });

  it("opens straight into replace mode when asked", () => {
    renderBar({ withReplace: true });
    expect(screen.getByLabelText("Replace with")).toBeInTheDocument();
  });

  it("replaces only the current match", async () => {
    const user = userEvent.setup();
    const { target } = renderBar({ withReplace: true });
    await user.click(screen.getByLabelText("Find"));
    await user.keyboard("two");
    await user.click(screen.getByLabelText("Replace with"));
    await user.keyboard("2");

    await user.click(screen.getByTitle("Replace this match"));
    const [matches, replacement] = target.replace.mock.lastCall as [Match[], string];
    expect(matches).toHaveLength(1);
    expect(replacement).toBe("2");
  });

  it("replaces every match at once", async () => {
    const user = userEvent.setup();
    const { target } = renderBar({ withReplace: true });
    await user.click(screen.getByLabelText("Find"));
    await user.keyboard("two");
    await user.click(screen.getByTitle("Replace every match"));
    const [matches] = target.replace.mock.lastCall as [Match[], string];
    expect(matches).toHaveLength(3);
  });

  it("says why instead of showing dead buttons on a read-only share", async () => {
    const user = userEvent.setup();
    const { target } = renderBar({ withReplace: true, canReplace: false });
    await user.click(screen.getByLabelText("Find"));
    await user.keyboard("two");

    expect(screen.getByText("View only")).toBeInTheDocument();
    expect(screen.queryByTitle("Replace this match")).toBeNull();
    expect(screen.queryByTitle("Replace every match")).toBeNull();
    expect(target.replace).not.toHaveBeenCalled();
  });

  it("hands the caret back to the pane on Escape", async () => {
    const user = userEvent.setup();
    const { target, onClose } = renderBar();
    await user.keyboard("two{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(target.release).toHaveBeenCalledTimes(1);
    expect(target.release.mock.lastCall?.[0]).toMatchObject({ from: expect.any(Number) });
  });

  it("closes from the ✕ button too", async () => {
    const user = userEvent.setup();
    const { onClose } = renderBar();
    await user.click(screen.getByTitle("Close (Esc)"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("steps with ⌘G from anywhere in the window", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard("two");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyG", metaKey: true, bubbles: true })
    );
    expect(await screen.findByText("2 of 3")).toBeInTheDocument();
  });

  it("stops listening for ⌘G once it closes", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderBar();
    await user.keyboard("two");
    rerender(<FindBar {...props} open={false} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG", metaKey: true }));
    // nothing rendered, and nothing threw
    expect(screen.queryByRole("search")).toBeNull();
  });

  it("recomputes the match set when the document changes underneath it", async () => {
    const user = userEvent.setup();
    const { rerender, props, state } = renderBar();
    await user.keyboard("two");
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    state.text = "two";
    rerender(<FindBar {...props} revision="r1" />);
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("does nothing at all with no pane mounted", async () => {
    const user = userEvent.setup();
    renderBar({ target: null });
    await user.keyboard("two");
    expect(screen.getByText("No results")).toBeInTheDocument();
  });
});
