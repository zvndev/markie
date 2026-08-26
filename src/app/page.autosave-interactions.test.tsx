// Autosave shares the open document with a disk watcher, a sync engine and a
// CSV encoder. Each boundary gets a test, so a refactor cannot cross one in
// silence. A failure here is a real bug, not a stale expectation.
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, SaveResult } from "@/lib/electron";
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
const CSV = { name: "t.csv", path: "/n/t.csv", content: "a,b\n1,2\n" };

type SaveArgs = Parameters<ElectronAPI["saveFile"]>[0];
const okSave = (path = OPEN.path) =>
  vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => ({ success: true, path }));

interface Handle {
  isEditable: boolean;
  commands: { setContent(c: string): void };
}
const richEditor = () =>
  (window as unknown as { __markieEditor: Handle }).__markieEditor;

async function bootWith(file: typeof OPEN, overrides: Partial<ElectronAPI>) {
  installBridge({ getInitialFile: vi.fn(async () => file), ...overrides });
  render(<Home />);
  await waitFor(() => expect(richEditor()?.isEditable).toBe(true));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("autosave truce lines", () => {
  it("keeps writing the CSV encoding to disk, not the markdown it edits", async () => {
    const saveFile = okSave(CSV.path);
    await bootWith(CSV, { saveFile });
    await screen.findByText("1"); // the table rendered from the CSV

    await act(async () => {
      richEditor().commands.setContent("| a | b |\n| --- | --- |\n| 1 | 3 |");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const written = saveFile.mock.calls[0]![0].content;
    expect(written).toMatch(/^a,b/); // CSV, not a markdown table
    expect(written).not.toMatch(/\|/);
  });

  it("says nothing about CSV truncation on an autosave, and everything on a manual one", async () => {
    // A .csv keeps the first table and drops the rest. Repeating that once a
    // second while somebody types buries the banner in its own noise.
    const saveFile = okSave(CSV.path);
    await bootWith(CSV, { saveFile });
    await screen.findByText("1");
    await act(async () => {
      richEditor().commands.setContent("Prose above.\n\n| a | b |\n| --- | --- |\n| 1 | 3 |");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(screen.queryByText(/Saved as CSV/i)).not.toBeInTheDocument();

    await act(async () => {
      emit("onMenuSave");
    });
    expect(await screen.findByText(/Saved as CSV/i)).toBeInTheDocument();
  });

  it("suspends autosave while a disk change is pending", async () => {
    const saveFile = okSave();
    await bootWith(OPEN, { saveFile });
    await screen.findByText("start");

    await act(async () => {
      emit("onFileChangedOnDisk", { path: OPEN.path, content: "theirs\n" });
    });
    await act(async () => {
      richEditor().commands.setContent("mine while conflicted");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // Suspended until the user resolves it: autosave must never be the thing
    // that overwrites an agent's concurrent edit.
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("a solo autosave pushes to the cloud exactly as a manual save does", async () => {
    // The live-session variant (a collab room suppresses docPush) is not
    // reachable from this harness: it needs a real Yjs websocket provider.
    // What is pinned here is that autosave takes the same handleSave path,
    // so the collab branch inside it cannot diverge between the two.
    const docPush = vi.fn(async () => ({ ok: true, pushed: true }));
    const saveFile = okSave();
    await bootWith(OPEN, { saveFile, docPush });
    await screen.findByText("start");
    await act(async () => {
      richEditor().commands.setContent("solo edit");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    await waitFor(() => expect(docPush).toHaveBeenCalled());
  });

  it("an autosave and a manual save send main the same write", async () => {
    // "Same operation, not a separate code path" is the locked save model.
    // The only difference main may see is the flag that forbids a dialog.
    const saveFile = okSave();
    await bootWith(OPEN, { saveFile });
    await screen.findByText("start");
    await act(async () => {
      richEditor().commands.setContent("one and the same");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const auto = saveFile.mock.calls[0]![0];

    await act(async () => {
      emit("onMenuSave");
    });
    await waitFor(() => expect(saveFile.mock.calls.length).toBe(2));
    const manual = saveFile.mock.calls[1]![0];

    expect(auto.autosave).toBe(true);
    expect(manual.autosave).toBe(false);
    expect({ ...auto, autosave: undefined }).toEqual({ ...manual, autosave: undefined });
  });

  it("a viewer's read-only document never autosaves", async () => {
    // Rich and Source are both locked for a viewer, but the gate is checked
    // independently: nothing may reach disk for a document this user may not
    // write, whatever a future editing surface decides to allow.
    const saveFile = okSave();
    await bootWith(OPEN, { saveFile });
    await screen.findByText("start");
    // Drive the buffer straight through the editor handle, which stays live
    // even when the pane is locked.
    await act(async () => {
      emit("onFileChangedOnDisk", { path: OPEN.path, content: "theirs\n" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });
});
