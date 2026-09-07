import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SourceEditor } from "@/components/source-editor";
import type { SourceHandle } from "@/lib/source-handle";

describe("the lazily loaded source editor", () => {
  it("shows the head of the text while the chunk loads, then hands over a handle", async () => {
    const onReady = vi.fn<(handle: SourceHandle | null) => void>();
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const value = `# Title\n\n${lines.join("\n")}`;
    const view = render(<SourceEditor value={value} onChange={() => {}} onReady={onReady} />);

    // The first render of the session sees the placeholder: the document's
    // own text, capped to its head so a large file costs no layout.
    const placeholder = view.container.querySelector("[data-markie-source-loading]");
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain("# Title");
    expect(placeholder!.textContent!.split("\n").length).toBeLessThanOrEqual(200);
    expect(view.container.querySelector(".cm-editor")).toBeNull();

    await waitFor(() => expect(view.container.querySelector(".cm-editor")).not.toBeNull());
    expect(view.container.querySelector("[data-markie-source-loading]")).toBeNull();
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    const handle = onReady.mock.calls[0][0]!;
    expect(typeof handle.undo).toBe("function");
    expect(typeof handle.redo).toBe("function");
    expect(typeof handle.focus).toBe("function");
    expect(handle.findTarget()).toBeTruthy();

    view.unmount();
    expect(onReady).toHaveBeenLastCalledWith(null);
  });
});
