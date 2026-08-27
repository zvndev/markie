import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge, listenerCount } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "opened content\n" };

async function boot(overrides: Partial<ElectronAPI> = {}) {
  const api = installBridge({
    getInitialFile: vi.fn(async () => OPEN),
    ...overrides,
  });
  const view = render(<Home />);
  await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  await screen.findByText("opened content");
  return { api, view };
}

const push = async (channel: string, ...args: unknown[]) => {
  await act(async () => {
    emit(channel, ...args);
  });
};

beforeEach(() => {
  localStorage.clear();
});

describe("page menu pushes", () => {
  it("menu-save saves the open document", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await push("onMenuSave");
    await waitFor(() =>
      expect(saveFile).toHaveBeenCalledExactlyOnceWith({
        filePath: OPEN.path,
        content: OPEN.content,
        force: false,
        autosave: false,
      })
    );
  });

  it("menu-save-as opens the save sheet", async () => {
    const saveFileAs = vi.fn(async () => ({ canceled: true, success: false }));
    await boot({ saveFileAs } as Partial<ElectronAPI>);
    await push("onMenuSaveAs");
    await waitFor(() => expect(saveFileAs).toHaveBeenCalledTimes(1));
  });

  it("menu-new-file empties the buffer and forgets the path", async () => {
    await boot();
    await push("onMenuNewFile");
    await waitFor(() => expect(document.title).toBe("Markie"));
    expect(screen.queryByText("opened content")).not.toBeInTheDocument();
  });

  it("menu-open-file asks main for a file, beside the one already open", async () => {
    const openFile = vi.fn(async () => null);
    await boot({ openFile } as Partial<ElectronAPI>);
    await push("onMenuOpenFile");
    await waitFor(() => expect(openFile).toHaveBeenCalledExactlyOnceWith({ near: OPEN.path }));
  });

  it("file-opened loads the document main pushed and tracks it", async () => {
    const registryTrack = vi.fn(async () => ({ ok: true }));
    await boot({ registryTrack } as Partial<ElectronAPI>);
    const next = { name: "other.md", path: "/notes/other.md", content: "other content\n" };
    await push("onFileOpened", next);
    await waitFor(() => expect(document.title).toBe("other.md — Markie"));
    expect(await screen.findByText("other content")).toBeInTheDocument();
    expect(registryTrack).toHaveBeenCalledWith({
      path: next.path,
      name: next.name,
      content: next.content,
    });
  });

  it("set-mode drives the view mode", async () => {
    await boot();
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Rich mode (⌘1)")).toBe("true");
    await push("onSetMode", "edit");
    await waitFor(() => expect(pressed("Source mode (⌘2)")).toBe("true"));
    await push("onSetMode", "split");
    await waitFor(() => expect(pressed("Split mode (⌘3)")).toBe("true"));
    await push("onSetMode", "preview");
    await waitFor(() => expect(pressed("Rich mode (⌘1)")).toBe("true"));
  });

  it("toggle-stats and menu-shortcuts open their panels", async () => {
    await boot();
    await push("onToggleStats");
    expect(await screen.findByText("Statistics")).toBeInTheDocument();
    await push("onMenuShortcuts");
    expect(
      await screen.findByRole("heading", { name: "Keyboard Shortcuts" })
    ).toBeInTheDocument();
  });

  it("menu-format-tables rewrites the buffer in place", async () => {
    installBridge({
      getInitialFile: vi.fn(async () => ({
        name: "table.md",
        path: "/notes/table.md",
        content: "| a | bbbb |\n| --- | --- |\n| c | d |\n",
      })),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(document.title).toBe("table.md — Markie"));
    await push("onMenuFormatTables");
    // The document is now dirty because the tables were reformatted.
    await waitFor(() => expect(document.title).toBe("• table.md — Markie"));
  });

  it("leaves no listener behind on unmount", async () => {
    const { view } = await boot();
    expect(listenerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(listenerCount()).toBe(0);
  });

  it("registers each push channel exactly once", async () => {
    await boot();
    for (const channel of [
      "menu-save",
      "menu-save-as",
      "menu-new-file",
      "menu-open-file",
      "file-opened",
      "set-mode",
    ]) {
      expect(listenerCount(channel), channel).toBe(1);
    }
  });
});
