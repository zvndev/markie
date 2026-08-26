import { render, screen, waitFor } from "@testing-library/react";
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

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "first line\n" };

async function boot(overrides: Partial<ElectronAPI> = {}) {
  // Boot with the document already open, so the welcome sample never races it.
  const api = installBridge({ getInitialFile: vi.fn(async () => OPEN), ...overrides });
  render(<Home />);
  await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  await screen.findByText("first line");
  return api;
}

beforeEach(() => {
  localStorage.clear();
});

describe("page save", () => {
  it("saves the open buffer to the open path", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSave");
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(saveFile).toHaveBeenCalledWith({
      filePath: OPEN.path,
      content: OPEN.content,
      force: false,
      // A save the user asked for. Main reads this to decide whether it may
      // put a dialog in front of them.
      autosave: false,
    });
  });

  it("takes the disk copy when main answers 'reloaded'", async () => {
    const saveFile = vi.fn(async () => ({
      success: true,
      code: "reloaded" as const,
      content: "what was actually on disk\n",
    }));
    await boot({ saveFile, docPush: vi.fn(async () => ({ ok: true })) } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSave");
    });
    // The buffer now holds the disk copy...
    expect(await screen.findByText("what was actually on disk")).toBeInTheDocument();
    expect(screen.queryByText("first line")).not.toBeInTheDocument();
    // ...and it counts as saved, so the title carries no dirty mark.
    await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  });

  it("does not push a reloaded copy back over what it just pulled", async () => {
    const docPush = vi.fn(async () => ({ ok: true, pushed: true }));
    await boot({
      saveFile: vi.fn(async () => ({
        success: true,
        code: "reloaded" as const,
        content: "disk wins\n",
      })),
      docPush,
    } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSave");
    });
    await screen.findByText("disk wins");
    expect(docPush).not.toHaveBeenCalled();
  });

  it("keeps the buffer and says so when the save never reached disk", async () => {
    const saveFile = vi.fn(async () => ({
      success: false,
      error: "Markie isn't allowed to write there.",
    }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSave");
    });
    // The failure is said out loud on the banner...
    const banner = await screen.findByText("Markie isn't allowed to write there.");
    expect(banner).toBeInTheDocument();
    // ...and the text the user wrote is still there.
    expect(screen.getByText("first line")).toBeInTheDocument();
  });

  it("says so when the file landed on disk but never reached the cloud", async () => {
    await boot({
      saveFile: vi.fn(async () => ({ success: true, path: OPEN.path })),
      docPush: vi.fn(async () => ({ error: "Backup rejected: version conflict." })),
    } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSave");
    });
    expect(
      await screen.findByText("Backup rejected: version conflict.")
    ).toBeInTheDocument();
  });

  it("falls back to Save As when nothing is open yet", async () => {
    const saveFileAs = vi.fn(async () => ({
      success: true,
      path: "/notes/untitled.md",
      name: "untitled.md",
      wroteCsv: false,
    }));
    const saveFile = vi.fn(async () => ({ success: true }));
    installBridge({ saveFileAs, saveFile } as Partial<ElectronAPI>);
    render(<Home />);
    await act(async () => {
      emit("onMenuNewFile");
    });
    await act(async () => {
      emit("onMenuSave");
    });
    await waitFor(() => expect(saveFileAs).toHaveBeenCalledTimes(1));
    expect(saveFile).not.toHaveBeenCalled();
  });
});
