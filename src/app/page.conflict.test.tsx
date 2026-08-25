import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocUpdate, ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "mine\n" };
const REMOTE = "theirs\n";

const update = (o: Partial<DocUpdate> = {}): DocUpdate => ({
  path: OPEN.path,
  cloudId: "cloud-1",
  name: OPEN.name,
  localVersion: 3,
  remoteVersion: 5,
  syncState: "conflict",
  ...o,
});

async function bootWithUpdate(
  overrides: Partial<ElectronAPI> = {},
  updates: DocUpdate[] = [update()]
) {
  const api = installBridge({
    // Boot with the document already open, so nothing races the welcome sample.
    getInitialFile: vi.fn(async () => OPEN),
    docCheckUpdates: vi.fn(async () => ({ updates })),
    docRemoteContent: vi.fn(async () => ({ ok: true, content: REMOTE, version: 5 })),
    ...overrides,
  });
  render(<Home />);
  await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  await screen.findByText("mine");
  return api;
}

beforeEach(() => {
  localStorage.clear();
});

describe("page conflict", () => {
  it("offers a review, not a one-click pull, when the local copy has changes of its own", async () => {
    await bootWithUpdate();
    expect(
      await screen.findByText(/Updated on the server, and this copy has changes of its own/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  });

  it("opens the conflict dialog on the open document", async () => {
    await bootWithUpdate();
    await userEvent.click(await screen.findByRole("button", { name: "Review changes…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Both copies of notes.md changed");
  });

  it("keep both hands the dialog the open buffer and takes the server's copy into it", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true, content: REMOTE }));
    await bootWithUpdate({ docKeepBoth } as Partial<ElectronAPI>);
    await userEvent.click(await screen.findByRole("button", { name: "Review changes…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));
    await waitFor(() =>
      expect(docKeepBoth).toHaveBeenCalledExactlyOnceWith({
        path: OPEN.path,
        content: OPEN.content,
      })
    );
    // The dialog closes and the buffer follows what is now on disk.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("theirs")).toBeInTheDocument();
  });

  it("pull and overwrite resolves against the cloud", async () => {
    const docResolve = vi.fn(async () => ({ ok: true, content: REMOTE }));
    await bootWithUpdate({ docResolve } as Partial<ElectronAPI>);
    await userEvent.click(await screen.findByRole("button", { name: "Review changes…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pull and overwrite" }));
    await waitFor(() =>
      expect(docResolve).toHaveBeenCalledExactlyOnceWith({
        path: OPEN.path,
        strategy: "cloud",
      })
    );
    expect(await screen.findByText("theirs")).toBeInTheDocument();
  });

  it("cancel leaves the document and the strip alone", async () => {
    const docKeepBoth = vi.fn(async () => ({ ok: true }));
    const docResolve = vi.fn(async () => ({ ok: true }));
    await bootWithUpdate({ docKeepBoth, docResolve } as Partial<ElectronAPI>);
    await userEvent.click(await screen.findByRole("button", { name: "Review changes…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(docKeepBoth).not.toHaveBeenCalled();
    expect(docResolve).not.toHaveBeenCalled();
    expect(screen.getByText("mine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes…" })).toBeInTheDocument();
  });

  it("finishes a clean update in one click, with no dialog", async () => {
    const docResolve = vi.fn(async () => ({ ok: true, content: REMOTE }));
    await bootWithUpdate({ docResolve } as Partial<ElectronAPI>, [
      update({ syncState: "behind" }),
    ]);
    const button = await screen.findByRole("button", { name: "Update" });
    await userEvent.click(button);
    await waitFor(() =>
      expect(docResolve).toHaveBeenCalledExactlyOnceWith({
        path: OPEN.path,
        strategy: "cloud",
      })
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByText("theirs")).toBeInTheDocument();
    // Nothing is waiting any more, so the strip goes.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument()
    );
  });

  it("ignores an update for a document that is not open", async () => {
    await bootWithUpdate({}, [update({ path: "/notes/other.md" })]);
    await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
    expect(
      screen.queryByRole("button", { name: "Review changes…" })
    ).not.toBeInTheDocument();
  });

  it("dismisses the dialog when a different document is opened underneath it", async () => {
    await bootWithUpdate();
    await userEvent.click(await screen.findByRole("button", { name: "Review changes…" }));
    await screen.findByRole("dialog");
    await act(async () => {
      emit("onFileOpened", { name: "other.md", path: "/notes/other.md", content: "x\n" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
