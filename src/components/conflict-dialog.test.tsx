import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installBridge } from "@/test/mock-bridge";
import type { ElectronAPI } from "@/lib/electron";
import { ConflictDialog } from "./conflict-dialog";

const LOCAL = "one\ntwo\nthree\n";
const REMOTE = "one\ntwo\nfour\n";

function renderDialog(
  overrides: Partial<ElectronAPI> = {},
  props: Partial<React.ComponentProps<typeof ConflictDialog>> = {}
) {
  const api = installBridge({
    docRemoteContent: vi.fn(async () => ({ ok: true, content: REMOTE, version: 4 })),
    ...overrides,
  });
  const onClose = vi.fn();
  const onResolved = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <ConflictDialog
      filePath="/tmp/notes.md"
      fileName="notes.md"
      localContent={LOCAL}
      onClose={onClose}
      onResolved={onResolved}
      onChanged={onChanged}
      {...props}
    />
  );
  return { api, onClose, onResolved, onChanged, view };
}

describe("ConflictDialog", () => {
  it("names the file and reports how far the two copies have drifted", async () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: /Both copies of notes\.md changed/ })
    ).toBeInTheDocument();
    // Loading first, then the counted comparison of local against remote.
    expect(screen.getByText(/Comparing with the server/)).toBeInTheDocument();
    await screen.findByText(/Keep both saves your version alongside the original/);
    // One line replaced, one brought in.
    expect(screen.getByText(/1 .*line/)).toBeInTheDocument();
  });

  it("says nothing would be lost when only the version moved", async () => {
    renderDialog({
      docRemoteContent: vi.fn(async () => ({ ok: true, content: LOCAL, version: 9 })),
    });
    expect(await screen.findByText("Nothing of yours would be lost.")).toBeInTheDocument();
  });

  it("keep both calls docKeepBoth once with the frozen buffer, then resolves and closes", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true, content: REMOTE }));
    const docResolve = vi.fn(async () => ({ ok: true }));
    const { onClose, onResolved, onChanged } = renderDialog({
      docKeepBoth,
      docResolve,
    } as Partial<ElectronAPI>);
    const button = await screen.findByRole("button", { name: "Keep both" });
    await userEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(docKeepBoth).toHaveBeenCalledTimes(1);
    expect(docKeepBoth).toHaveBeenCalledWith({ path: "/tmp/notes.md", content: LOCAL });
    expect(docResolve).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(REMOTE);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("pull and overwrite calls docResolve once with the cloud strategy", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true }));
    const docResolve = vi.fn(async () => ({ ok: true, content: REMOTE }));
    const { onClose, onResolved, onChanged } = renderDialog({
      docKeepBoth,
      docResolve,
    } as Partial<ElectronAPI>);
    await userEvent.click(
      await screen.findByRole("button", { name: "Pull and overwrite" })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(docResolve).toHaveBeenCalledExactlyOnceWith({
      path: "/tmp/notes.md",
      strategy: "cloud",
    });
    expect(docKeepBoth).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(REMOTE);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("cancel closes without touching either resolution", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true }));
    const docResolve = vi.fn(async () => ({ ok: true }));
    const { onClose, onChanged } = renderDialog({
      docKeepBoth,
      docResolve,
    } as Partial<ElectronAPI>);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(docKeepBoth).not.toHaveBeenCalled();
    expect(docResolve).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Escape cancels", async () => {
    const { onClose } = renderDialog();
    await screen.findByRole("button", { name: "Keep both" });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused resolution instead of closing", async () => {
    const { onClose, onResolved } = renderDialog({
      docKeepBoth: vi.fn(async () => ({ error: "Server said no." })),
    } as Partial<ElectronAPI>);
    await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));
    expect(await screen.findByText("Server said no.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("says so when the server's copy cannot be read", async () => {
    renderDialog({
      docRemoteContent: vi.fn(async () => ({ ok: false, error: "Not found." })),
    });
    expect(await screen.findByText("Not found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep both" })).not.toBeInTheDocument();
  });

  it("freezes the buffer it counted, so a keystroke behind the dialog cannot change the offer", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true }));
    const { view } = renderDialog({ docKeepBoth } as Partial<ElectronAPI>);
    const button = await screen.findByRole("button", { name: "Keep both" });
    view.rerender(
      <ConflictDialog
        filePath="/tmp/notes.md"
        fileName="notes.md"
        localContent={`${LOCAL}typed after opening\n`}
        onClose={vi.fn()}
        onResolved={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    await userEvent.click(button);
    await waitFor(() => expect(docKeepBoth).toHaveBeenCalledTimes(1));
    // The content the dialog rescues is the one whose lines it counted.
    expect(docKeepBoth).toHaveBeenCalledWith({ path: "/tmp/notes.md", content: LOCAL });
  });
});
