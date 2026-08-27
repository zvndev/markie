// Typing lands on disk on its own, and never through a dialog or a blind
// overwrite. The edits are driven through the real rich editor handle the app
// publishes for automation, so they travel the same path a keystroke does:
// TipTap onUpdate, the 250ms serializer debounce, then editContent.
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

// Typed so the assertions can read the payload main would have received.
type SaveArgs = Parameters<ElectronAPI["saveFile"]>[0];
const okSave = () =>
  vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => ({
    success: true,
    path: OPEN.path,
  }));

interface Handle {
  commands: { setContent(c: string): void };
}
const richEditor = () =>
  (window as unknown as { __markieEditor: Handle }).__markieEditor;

async function boot(overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({ getInitialFile: vi.fn(async () => OPEN), ...overrides });
  render(<Home />);
  await screen.findByText("start");
  // The safety probe resolves off the open path; autosave is not armed for
  // rich until it does.
  await waitFor(() =>
    expect(
      (window as unknown as { __markieEditor?: { isEditable: boolean } }).__markieEditor
        ?.isEditable
    ).toBe(true)
  );
  return api;
}

/** Type into rich and let the serializer debounce and the autosave clock run. */
async function typeAndWait(text: string, ms = 6000) {
  await act(async () => {
    richEditor().commands.setContent(text);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe("autosave", () => {
  it("writes the buffer about a second after an edit, marked as an autosave", async () => {
    const saveFile = okSave();
    await boot({ saveFile } as Partial<ElectronAPI>);
    expect(saveFile).not.toHaveBeenCalled();

    await act(async () => {
      richEditor().commands.setContent("start edited");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // the serializer debounce only
    });
    expect(saveFile).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200); // the autosave idle delay
    });
    await waitFor(() =>
      expect(saveFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: OPEN.path, autosave: true })
      )
    );
    expect(saveFile.mock.calls[0][0].content).toMatch(/start edited/);
  });

  it("routes an autosave disk conflict into the strip and stops retrying", async () => {
    const saveFile = vi.fn<(args: SaveArgs) => Promise<SaveResult>>(async () => ({
      success: false,
      code: "disk-changed" as const,
      content: "theirs\n",
    }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await typeAndWait("mine");

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    const calls = saveFile.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // Nothing may keep hammering a file somebody else is writing.
    await typeAndWait("mine again", 10_000);
    expect(saveFile.mock.calls.length).toBe(calls);
  });

  it("never asks the user anything: an autosave carries the flag that forbids it", async () => {
    const saveFile = okSave();
    await boot({ saveFile } as Partial<ElectronAPI>);
    await typeAndWait("first burst");
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    for (const [args] of saveFile.mock.calls) {
      expect(args.autosave).toBe(true);
    }
  });

  it("a manual save cancels the pending autosave rather than writing twice", async () => {
    const saveFile = okSave();
    await boot({ saveFile } as Partial<ElectronAPI>);
    await act(async () => {
      richEditor().commands.setContent("typed then saved");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // serializer only; autosave still pending
    });
    await act(async () => {
      emit("onMenuSave");
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile.mock.calls[0][0].autosave).toBe(false);
    // The pending timer must not fire behind it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it("does not autosave a document with no file to write", async () => {
    const saveFile = okSave();
    const saveFileAs = vi.fn(async () => ({ success: false, canceled: true }));
    await boot({ saveFile, saveFileAs } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuNewFile");
    });
    await typeAndWait("an untitled thought");
    expect(saveFile).not.toHaveBeenCalled();
    expect(saveFileAs).not.toHaveBeenCalled();
  });
});
