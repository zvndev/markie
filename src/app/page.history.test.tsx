// History has to be reachable from the File menu and the palette, and a
// restore must land in the buffer without writing anything.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
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

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "start\n" };
const VERSIONS = [
  { stamp: "2026-08-26T10-00-00.000Z", iso: "2026-08-26T10:00:00.000Z", author: "user", bytes: 9 },
];

function withHistory(overrides: Partial<ElectronAPI> = {}) {
  return installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    historyList: vi.fn(async () => VERSIONS),
    historyRead: vi.fn(async () => ({ content: "an older version\n" })),
    ...overrides,
  } as Partial<ElectronAPI>);
}

beforeEach(() => {
  localStorage.clear();
});

describe("history from the page", () => {
  it("the File menu opens the dialog for the open document", async () => {
    withHistory();
    render(<Home />);
    await screen.findByText("start");
    await act(async () => {
      emit("onMenuHistory");
    });
    expect(await screen.findByRole("dialog", { name: /history: notes\.md/i })).toBeInTheDocument();
  });

  it("restoring loads the version as unsaved and writes nothing", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    withHistory({ saveFile } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await act(async () => {
      emit("onMenuHistory");
    });
    const restore = await screen.findByRole("button", { name: /restore/i });
    await waitFor(() => expect(restore).toBeEnabled());
    await userEvent.click(restore);

    expect(await screen.findByText("an older version")).toBeInTheDocument();
    // Dirty, so the user commits it deliberately...
    await waitFor(() => expect(document.title).toMatch(/^• /));
    // ...and nothing was written on the way.
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("is in the command palette under File", async () => {
    withHistory();
    render(<Home />);
    await screen.findByText("start");
    await act(async () => {
      emit("onMenuCommandPalette");
    });
    await userEvent.type(await screen.findByPlaceholderText(/type a command/i), "history");
    expect(await screen.findByRole("option", { name: /History…/ })).toBeInTheDocument();
  });
});
