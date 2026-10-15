import { render, screen, waitFor } from "@testing-library/react";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import type { ElectronAPI } from "@/lib/electron";
import type { EditorProps } from "@/components/editor";
import { emit, installBridge, listenerCount } from "@/test/mock-bridge";
import * as tableFormatting from "@/lib/format-tables";

const permissions = vi.hoisted(() => ({ active: false, inaccessible: false }));
const sourceCommands = vi.hoisted(() => ({ undo: vi.fn(), redo: vi.fn(), focus: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => permissions.active ? { id: "viewer", name: "Viewer", email: "viewer@example.com" } : null },
  sharesClient: {
    access: async () => { if (permissions.inaccessible) throw new Error("Offline"); return { role: "viewer" }; },
    list: async () => [], sharedByMe: async () => [],
  },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => permissions.active ? "test-viewer-token" : null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

// Exercise the page's native source-handle boundary without importing CodeMirror
// outside its owning module. Rich editor checks below use the real TipTap editor.
vi.mock("@/components/source-editor", () => ({
  preloadSourceEditor: () => {},
  SourceEditor: ({ value, readOnly, onReady }: EditorProps) => {
    useEffect(() => {
      onReady?.({ ...sourceCommands, findTarget: () => ({ text: () => "", caret: () => 0, highlight: () => {}, reveal: () => {}, replace: () => {}, release: () => {} }) });
      return () => onReady?.(null);
    }, [onReady]);
    return <div className="cm-editor"><div role="textbox" aria-label="Source document" tabIndex={0} contentEditable={!readOnly} suppressContentEditableWarning>{value}</div></div>;
  },
}));

import Home from "./page";
import { authStore } from "@/lib/auth-store";

const OPEN = { name: "notes.md", path: "/notes/notes.md", content: "opened content\n" };
const TABLE = { name: "table.md", path: "/notes/table.md", content: "| a | bbbb |\n| --- | --- |\n| c | d |\n" };
const richEditor = () => (window as unknown as { __markieEditor?: Editor | null }).__markieEditor;

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

async function bootReadOnly(file = OPEN, inaccessible = false) {
  permissions.active = true;
  permissions.inaccessible = inaccessible;
  await authStore.refresh();
  const api = installBridge({
    getInitialFile: vi.fn(async () => file),
    registryGet: vi.fn(async () => ({ path: file.path, name: file.name, cloud_doc_id: "cloud-readonly", share_role: null,
      content_hash: null, cloud_version: 1, sync_state: "synced", last_opened_at: null, last_synced_at: null })),
  } as Partial<ElectronAPI>);
  render(<Home />);
  await screen.findByText(inaccessible ? /Read-only until it is/ : /Shared with you · view only/);
  await waitFor(() => expect(richEditor()?.isEditable).toBe(false));
  return api;
}

beforeEach(async () => {
  localStorage.clear();
  permissions.active = false;
  permissions.inaccessible = false;
  await authStore.refresh();
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

  it.each(["rich", "source"] as const)("does not route native Undo/Redo into a viewer's %s Markdown editor", async (pane) => {
    const api = await bootReadOnly();
    let chain: ReturnType<typeof vi.spyOn> | undefined;
    const before = richEditor()!.getJSON();
    if (pane === "rich") {
      const editor = richEditor()!;
      editor.view.dom.tabIndex = 0;
      editor.view.dom.focus();
      expect(document.activeElement?.closest(".ProseMirror")).not.toBeNull();
      chain = vi.spyOn(editor, "chain");
    } else {
      await push("onSetMode", "edit");
      const source = await screen.findByRole("textbox", { name: "Source document" });
      expect(source).toHaveAttribute("contenteditable", "false");
      source.focus();
      expect(document.activeElement?.closest(".cm-editor")).not.toBeNull();
    }
    try {
      await push("onMenuUndo");
      await push("onMenuRedo");
      expect(sourceCommands.undo).not.toHaveBeenCalled();
      expect(sourceCommands.redo).not.toHaveBeenCalled();
      if (chain) expect(chain).not.toHaveBeenCalled();
      if (pane === "rich") expect(richEditor()!.getJSON()).toEqual(before);
      else expect(screen.getByRole("textbox", { name: "Source document" })).toHaveTextContent(OPEN.content.trim());
      expect(document.title).toBe("notes.md — Markie");
      expect(api.saveFile).not.toHaveBeenCalled();
    } finally { chain?.mockRestore(); }
  });

  it("does not invoke native Undo/Redo on a locally noneditable rich editor", async () => {
    const { api } = await boot();
    const editor = richEditor()!;
    await waitFor(() => expect(editor.isEditable).toBe(true));
    await act(async () => { editor.setEditable(false); });
    editor.view.dom.tabIndex = 0;
    editor.view.dom.focus();
    const before = editor.getJSON();
    const chain = vi.spyOn(editor, "chain");
    try {
      await push("onMenuUndo");
      await push("onMenuRedo");
      expect(chain).not.toHaveBeenCalled();
      expect(editor.getJSON()).toEqual(before);
      expect(document.title).toBe("notes.md — Markie");
      expect(api.saveFile).not.toHaveBeenCalled();
    } finally { chain.mockRestore(); }
  });

  it.each([false, true])("rejects native Format Tables for read-only Markdown (access unreachable: %s)", async (inaccessible) => {
    const api = await bootReadOnly(TABLE, inaccessible);
    const formatter = vi.spyOn(tableFormatting, "formatMarkdownTables");
    const before = richEditor()!.getJSON();
    try {
      await push("onMenuFormatTables");
      expect(formatter).not.toHaveBeenCalled();
      expect(richEditor()!.getJSON()).toEqual(before);
      expect(document.title).toBe("table.md — Markie");
      expect(api.saveFile).not.toHaveBeenCalled();
    } finally { formatter.mockRestore(); }
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
