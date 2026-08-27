// The journal is what covers the window between "the user typed" and "the
// bytes are on disk". These are the two ends of it: the buffer being written
// ahead of the save, and the next launch offering it back.
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

const entry = (over: Partial<{ key: string; path: string | null; name: string | null; content: string }> = {}) => ({
  key: "abc-notes.md",
  path: OPEN.path as string | null,
  name: OPEN.name as string | null,
  savedAt: new Date().toISOString(),
  bytes: 14,
  content: "recovered body",
  ...over,
});

interface Handle {
  isEditable: boolean;
  commands: { setContent(c: string): void };
}
const richEditor = () =>
  (window as unknown as { __markieEditor: Handle }).__markieEditor;

beforeEach(() => {
  localStorage.clear();
});

describe("draft journal", () => {
  it("offers a recovered draft on boot and restores it dirty", async () => {
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      draftCheck: vi.fn(async () => [entry()]),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }));
    expect(await screen.findByText("recovered body")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toMatch(/^• /)); // the dirty dot
  });

  it("discard removes the draft without touching the buffer", async () => {
    const draftDiscard = vi.fn(async () => ({ ok: true }));
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      draftCheck: vi.fn(async () => [entry({ key: "k", content: "zzz" })]),
      draftDiscard,
    } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await userEvent.click(await screen.findByRole("button", { name: /discard/i }));
    expect(draftDiscard).toHaveBeenCalledWith("k");
    expect(screen.queryByText("zzz")).not.toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
  });

  it("ignores a draft that belongs to a document nobody opened", async () => {
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      draftCheck: vi.fn(async () => [entry({ path: "/somewhere/else.md", name: "else.md" })]),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector("[data-markie-draft-strip]")).toBeNull();
  });

  it("journals the buffer ahead of the file write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const draftSave = vi.fn(async () => ({ ok: true }));
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      draftSave,
      saveFile,
    } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await waitFor(() => expect(richEditor()?.isEditable).toBe(true));

    await act(async () => {
      richEditor().commands.setContent("typed but not saved");
    });
    // The serializer settles, then the journal, all before the file write.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(saveFile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(draftSave).toHaveBeenCalledWith(
        expect.objectContaining({ path: OPEN.path, content: expect.stringMatching(/typed but not saved/) })
      )
    );

    // Once the save commits, the entry is spent and cleared.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    await waitFor(() =>
      expect(draftSave).toHaveBeenCalledWith(
        expect.objectContaining({ path: OPEN.path, content: "" })
      )
    );
    vi.useRealTimers();
  });

  it("journals a document with nowhere to autosave to", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const draftSave = vi.fn(async () => ({ ok: true }));
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      draftSave,
      saveFile,
      saveFileAs: vi.fn(async () => ({ success: false, canceled: true })),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await screen.findByText("start");
    await waitFor(() => expect(richEditor()?.isEditable).toBe(true));
    await act(async () => {
      emit("onMenuNewFile");
    });
    await act(async () => {
      richEditor().commands.setContent("an untitled thought");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    // Nothing to write to, so nothing was written...
    expect(saveFile).not.toHaveBeenCalled();
    // ...but it is still recoverable.
    await waitFor(() =>
      expect(draftSave).toHaveBeenCalledWith(
        expect.objectContaining({ path: null, content: expect.stringMatching(/untitled thought/) })
      )
    );
    vi.useRealTimers();
  });
});
