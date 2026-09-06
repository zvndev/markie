import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, LibraryItem } from "@/lib/electron";
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

// The Library is a list the main process owns. Two things used to change that
// list without the panel hearing about it: a rename (the row kept the old name
// until you left and came back) and another machine syncing a document to the
// same account (the row never appeared at all until the panel was reopened).

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "opened content\n" };

const local = (o: Partial<LibraryItem> = {}): LibraryItem =>
  ({
    kind: "local",
    path: OPEN.path,
    name: OPEN.name,
    cloudId: null,
    state: "local-only",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    remoteVersion: null,
    exists: true,
    ...o,
  }) as LibraryItem;

async function boot(overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    ...overrides,
  });
  render(<Home />);
  await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  await screen.findByText("opened content");
  // The Library panel, the way the File menu opens it.
  await act(async () => {
    emit("onMenuLibrary");
  });
  return api;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("markie.libtab.v4", "recent");
});

// The toolbar shows the open file's name too; a Library row is the one inside
// a row group.
const libraryRow = (name: string) =>
  screen.queryAllByText(name).map((el) => el.closest("div.group")).find(Boolean) ?? null;
const findLibraryRow = (name: string) =>
  waitFor(() => {
    const row = libraryRow(name);
    expect(row).not.toBeNull();
    return row as HTMLElement;
  });

describe("the Library staying current", () => {
  it("shows the new name right after a rename, without leaving the panel", async () => {
    // What main will list: the old row until the rename, the new row after.
    let items = [local()];
    const libraryState = vi.fn(async () => ({ signedIn: false, items }));
    const renameFile = vi.fn(async ({ newName }: { oldPath: string; newName: string }) => {
      items = [local({ path: `/notes/${newName}`, name: newName })];
      return { success: true, path: `/notes/${newName}`, name: newName };
    });
    await boot({ libraryState, renameFile } as Partial<ElectronAPI>);
    await findLibraryRow("notes.md");
    const listedBefore = libraryState.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "notes.md" }));
    const field = screen.getByDisplayValue("notes.md");
    await userEvent.clear(field);
    await userEvent.type(field, "renamed.md{Enter}");

    await waitFor(() =>
      expect(renameFile).toHaveBeenCalledWith({ oldPath: OPEN.path, newName: "renamed.md" })
    );
    await waitFor(() => expect(libraryState.mock.calls.length).toBeGreaterThan(listedBefore));
    await findLibraryRow("renamed.md");
    expect(libraryRow("notes.md")).toBeNull();
    expect(document.title).toBe("renamed.md — Markie");
  });

  it("lists a document another machine synced, the next time it looks at the server", async () => {
    let items = [local()];
    let listing = "list-1";
    const libraryState = vi.fn(async () => ({ signedIn: true, items }));
    const docCheckUpdates = vi.fn(async () => ({ updates: [], listing }));
    await boot({ libraryState, docCheckUpdates } as Partial<ElectronAPI>);
    await findLibraryRow("notes.md");
    await waitFor(() => expect(docCheckUpdates).toHaveBeenCalled());
    const listedBefore = libraryState.mock.calls.length;

    // The other machine syncs a document; the server's list moves.
    items = [
      local(),
      local({
        kind: "cloud-only",
        path: null,
        name: "from-the-laptop.md",
        cloudId: "cloud-9",
        state: "cloud-only",
        remoteVersion: 1,
        exists: false,
      }),
    ];
    listing = "list-2";
    // Coming back to the window is one of the moments the app looks.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await findLibraryRow("from-the-laptop.md");
    expect(libraryState.mock.calls.length).toBeGreaterThan(listedBefore);
  });

  it("does not refetch the Library while the server's list stands still", async () => {
    const libraryState = vi.fn(async () => ({ signedIn: true, items: [local()] }));
    const docCheckUpdates = vi.fn(async () => ({ updates: [], listing: "same" }));
    await boot({ libraryState, docCheckUpdates } as Partial<ElectronAPI>);
    await findLibraryRow("notes.md");
    await waitFor(() => expect(docCheckUpdates).toHaveBeenCalled());
    const listedBefore = libraryState.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(docCheckUpdates.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(libraryState.mock.calls.length).toBe(listedBefore);
  });
});
