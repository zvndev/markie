// The P0 this release exists to close: Markie used to throw away unsaved work
// on file switch, New File, window close and quit. Every one of those paths
// settles the document first now.
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
const SECOND = { name: "b.md", path: "/notes/b.md", content: "second\n" };

type SaveArgs = Parameters<ElectronAPI["saveFile"]>[0];
const okSave = () =>
  vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => ({
    success: true,
    path: OPEN.path,
  }));

interface Handle {
  isEditable: boolean;
  commands: { setContent(c: string): void };
}
const richEditor = () =>
  (window as unknown as { __markieEditor: Handle }).__markieEditor;

async function boot(overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({ getInitialFile: vi.fn(async () => OPEN), ...overrides });
  render(<Home />);
  await screen.findByText("start");
  await waitFor(() => expect(richEditor()?.isEditable).toBe(true));
  return api;
}

/** Type, and stop in the window where the edit is in the buffer but not on disk. */
async function typeUnsaved(text: string) {
  await act(async () => {
    richEditor().commands.setContent(text);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300); // the serializer only
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("settling the document before it goes", () => {
  it("flushes the pending autosave before opening another file", async () => {
    const saveFile = okSave();
    await boot({ saveFile, openFile: vi.fn(async () => SECOND) } as Partial<ElectronAPI>);
    await typeUnsaved("unsaved edit");
    expect(saveFile).not.toHaveBeenCalled();

    await act(async () => {
      emit("onMenuOpenFile");
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(saveFile.mock.calls[0]![0].content).toMatch(/unsaved edit/);
    expect(await screen.findByText("second")).toBeInTheDocument();
  });

  it("flushes before New File replaces the buffer", async () => {
    const saveFile = okSave();
    await boot({ saveFile } as Partial<ElectronAPI>);
    await typeUnsaved("about to be discarded");
    expect(saveFile).not.toHaveBeenCalled();

    await act(async () => {
      emit("onMenuNewFile");
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(saveFile.mock.calls[0]![0].content).toMatch(/about to be discarded/);
  });

  it("answers app-will-close with appCloseReady, after the write", async () => {
    const saveFile = okSave();
    const appCloseReady = vi.fn();
    await boot({ saveFile, appCloseReady } as Partial<ElectronAPI>);
    await typeUnsaved("typed then closed");

    await act(async () => {
      emit("onAppWillClose");
    });
    await waitFor(() => expect(appCloseReady).toHaveBeenCalled());
    expect(saveFile).toHaveBeenCalled();
    expect(saveFile.mock.calls[0]![0].content).toMatch(/typed then closed/);
    // The write happened first: main destroys the window as soon as it hears back.
    expect(saveFile.mock.invocationCallOrder[0]!).toBeLessThan(
      appCloseReady.mock.invocationCallOrder[0]!
    );
  });

  it("still answers app-will-close when the save fails, so quit cannot wedge", async () => {
    const saveFile = vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => {
      throw new Error("disk full");
    });
    const appCloseReady = vi.fn();
    await boot({ saveFile, appCloseReady } as Partial<ElectronAPI>);
    await typeUnsaved("doomed edit");

    await act(async () => {
      emit("onAppWillClose");
    });
    await waitFor(() => expect(appCloseReady).toHaveBeenCalled());
  });

  it("a clean document closes without writing anything", async () => {
    const saveFile = okSave();
    const appCloseReady = vi.fn();
    await boot({ saveFile, appCloseReady } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onAppWillClose");
    });
    await waitFor(() => expect(appCloseReady).toHaveBeenCalled());
    expect(saveFile).not.toHaveBeenCalled();
  });
});
