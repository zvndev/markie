import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";
import { MENU_ACCELERATORS, canonicalChord } from "@/lib/toolbar-shortcuts";

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
  render(<Home />);
  await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
  await screen.findByText("opened content");
  return api;
}

// The page reads e.metaKey/e.ctrlKey, so a Mac chord is Meta plus the key.
const chord = (keys: string) => userEvent.keyboard(`{Meta>}${keys}{/Meta}`);

const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

beforeEach(() => {
  localStorage.clear();
});

describe("page keyboard shortcuts", () => {
  it("⌘S saves the open document", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await chord("s");
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  });

  it("⇧⌘S opens the save sheet instead of saving in place", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    const saveFileAs = vi.fn(async () => ({ canceled: true, success: false }));
    await boot({ saveFile, saveFileAs } as Partial<ElectronAPI>);
    await userEvent.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
    await waitFor(() => expect(saveFileAs).toHaveBeenCalledTimes(1));
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("⌘O asks main for a file", async () => {
    const openFile = vi.fn(async () => null);
    await boot({ openFile } as Partial<ElectronAPI>);
    await chord("o");
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
  });

  it("⌘1 / ⌘2 / ⌘3 switch view modes", async () => {
    await boot();
    await chord("2");
    await waitFor(() => expect(pressed("Source mode (⌘2)")).toBe("true"));
    await chord("3");
    await waitFor(() => expect(pressed("Split mode (⌘3)")).toBe("true"));
    await chord("1");
    await waitFor(() => expect(pressed("Rich mode (⌘1)")).toBe("true"));
  });

  it("⌘K toggles the command palette", async () => {
    await boot();
    await chord("k");
    const field = await screen.findByPlaceholderText(/Type a command/i);
    expect(field).toBeInTheDocument();
    await chord("k");
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Type a command/i)).not.toBeInTheDocument()
    );
  });

  it("⌘/ toggles the shortcuts sheet", async () => {
    await boot();
    await chord("/");
    expect(
      await screen.findByRole("heading", { name: "Keyboard Shortcuts" })
    ).toBeInTheDocument();
    await chord("/");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Keyboard Shortcuts" })
      ).not.toBeInTheDocument()
    );
  });

  it("⌘N starts a blank document", async () => {
    await boot();
    await chord("n");
    await waitFor(() => expect(document.title).toBe("Markie"));
  });

  it("⌘L toggles the side panel", async () => {
    await boot();
    await chord("l");
    expect(await screen.findByRole("button", { name: "Collapse library" })).toBeInTheDocument();
    await chord("l");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Collapse library" })
      ).not.toBeInTheDocument()
    );
  });

  it("⌘F opens find, ⌥⌘F opens find and replace", async () => {
    await boot();
    await chord("f");
    expect(await screen.findByPlaceholderText("Find")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Replace with")).not.toBeInTheDocument();
    await userEvent.keyboard("{Meta>}{Alt>}f{/Alt}{/Meta}");
    expect(await screen.findByPlaceholderText("Replace")).toBeInTheDocument();
  });

  it("every chord the page handles is one the menu already reserves", () => {
    // A chord the page acts on but the menu never declares is a shortcut the
    // Electron menu can silently take away.
    const handled = ["Mod-s", "Mod-Shift-s", "Mod-o", "Mod-1", "Mod-2", "Mod-3", "Mod-k", "Mod-l", "Mod-n", "Mod-/", "Mod-f", "Mod-Alt-f"];
    const declared = new Set(MENU_ACCELERATORS.map(canonicalChord));
    for (const key of handled) {
      expect(declared.has(canonicalChord(key)), key).toBe(true);
    }
  });
});

describe("page keyboard shortcuts while a modal is open", () => {
  // Documenting what actually happens: the page's keydown handler is a plain
  // window listener with no modal guard, so accelerators keep firing behind an
  // open overlay.
  it("still saves with the command palette open", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    await boot({ saveFile } as Partial<ElectronAPI>);
    await chord("k");
    await screen.findByPlaceholderText(/Type a command/i);
    await chord("s");
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  });
});
