import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LiveSourceBanner, ShareBanner, UpdateStrip } from "./share-banner";

describe("ShareBanner", () => {
  it("renders nothing with no view and no error", () => {
    const { container } = render(<ShareBanner view={null} onMakeCopy={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the view-only reason and offers a copy", async () => {
    const user = userEvent.setup();
    const onMakeCopy = vi.fn();
    render(
      <ShareBanner
        view={{ kind: "view-only", message: "Ada shared this with you to read." }}
        onMakeCopy={onMakeCopy}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Ada shared this with you to read.");

    await user.click(screen.getByRole("button", { name: "Make a copy" }));
    expect(onMakeCopy).toHaveBeenCalledTimes(1);
  });

  it("shows the checking state without a copy button", () => {
    render(
      <ShareBanner
        view={{ kind: "checking", message: "Checking your access…" }}
        onMakeCopy={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking your access…");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the view-only reason on screen alongside a failure", () => {
    render(
      <ShareBanner
        view={{ kind: "view-only", message: "Read only." }}
        error="Could not write the copy."
        onMakeCopy={vi.fn()}
      />
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Could not write the copy.");
    // the standing reason the document cannot be typed in is still true
    expect(status).toHaveTextContent("Read only.");
    // the way out stays available after a failure
    expect(screen.getByRole("button", { name: "Make a copy" })).toBeInTheDocument();
  });

  it("lets an error wrap instead of truncating it to one line", () => {
    render(
      <ShareBanner
        view={null}
        error="Saved as CSV: 42 lines outside the first table are not in that file."
        onMakeCopy={vi.fn()}
      />
    );
    const line = screen.getByText(/Saved as CSV/);
    expect(line.className).not.toContain("truncate");
    expect(line.className).toContain("line-clamp-2");
  });

  it("dismisses the error without touching the role line", async () => {
    const user = userEvent.setup();
    const onDismissError = vi.fn();
    render(
      <ShareBanner
        view={{ kind: "view-only", message: "Read only." }}
        error="Disk full."
        onDismissError={onDismissError}
        onMakeCopy={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissError).toHaveBeenCalledTimes(1);
    // dismissing is the parent's job; the standing view stays put
    expect(screen.getByRole("status")).toHaveTextContent("Read only.");
  });

  it("offers no dismiss when the parent cannot clear the error", () => {
    render(<ShareBanner view={null} error="Disk full." onMakeCopy={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows a copy error even with no share view", () => {
    render(<ShareBanner view={null} error="Disk full." onMakeCopy={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Disk full.");
  });
});

describe("UpdateStrip", () => {
  it("offers a one-click update when nothing local is at risk", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onReview = vi.fn();
    render(
      <UpdateStrip kind="clean" busy={false} error={null} onUpdate={onUpdate} onReview={onReview} />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Updated on the server.");
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onReview).not.toHaveBeenCalled();
  });

  it("sends a dirty document through review instead of overwriting it", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onReview = vi.fn();
    render(
      <UpdateStrip kind="dirty" busy={false} error={null} onUpdate={onUpdate} onReview={onReview} />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Updated on the server, and this copy has changes of its own."
    );
    await user.click(screen.getByRole("button", { name: "Review changes…" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("disables the button and says so while the update runs", () => {
    render(
      <UpdateStrip kind="clean" busy error={null} onUpdate={vi.fn()} onReview={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("replaces the message with the failure and keeps the retry", () => {
    render(
      <UpdateStrip
        kind="clean"
        busy={false}
        error="Server unreachable."
        onUpdate={vi.fn()}
        onReview={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Server unreachable.");
    expect(screen.queryByText("Updated on the server.")).toBeNull();
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });
});

describe("LiveSourceBanner", () => {
  it("tells the user where editing happens during a live session", () => {
    render(<LiveSourceBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Live session. Edit in Rich.");
  });
});
