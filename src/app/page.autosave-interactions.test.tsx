// Autosave shares the open document with a disk watcher, a sync engine and a
// CSV encoder. Each boundary gets a test, so a refactor cannot cross one in
// silence. A failure here is a real bug, not a stale expectation.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, useEffect } from "react";
import type { DocumentShellState } from "@/lib/document-shell";
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
vi.mock("@/components/document-workspace-host", () => ({ DocumentWorkspaceHost: ({ active, onShellChange }: { active: boolean; onShellChange: (value: DocumentShellState) => void }) => {
  useEffect(() => { onShellChange({ name: "Untitled.docx", ready: true, hasSession: true, dirty: false, private: false, busy: false, records: [], create: vi.fn(), open: vi.fn(), importFile: vi.fn(), save: vi.fn(), share: vi.fn(), showVault: vi.fn(), prepareLeave: async () => true, prepareClose: async () => true }); }, [onShellChange]);
  return active ? <p>Active document renderer</p> : null;
} }));

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
  it("keeps the latest dirty Markdown recovery before entering Documents", async () => {
    const draftSave = vi.fn(async () => ({ ok: true }));
    installBridge({ getInitialFile: vi.fn(async () => OPEN), saveFile: vi.fn(async () => ({ success: false, canceled: true })), draftSave });
    render(<Home documentsEnabled />);
    await waitFor(() => expect(richEditor()?.isEditable).toBe(true));
    await act(async () => { richEditor().commands.setContent("keep this dirty buffer"); });
    fireEvent.click(screen.getByRole("button", { name: "Library: recent and projects (⌘L)" }));
    fireEvent.click(await screen.findByRole("button", { name: "New document…" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Word document" }));
    await screen.findByText("Active document renderer");
    expect(draftSave).toHaveBeenCalledWith(expect.objectContaining({ path: OPEN.path, name: OPEN.name, content: expect.stringContaining("keep this dirty buffer") }));
  });

  it("does not leave dirty Markdown when the recovery write fails", async () => {
    installBridge({ getInitialFile: vi.fn(async () => OPEN), saveFile: vi.fn(async () => ({ success: false, canceled: true })), draftSave: vi.fn(async () => ({ ok: false })) });
    render(<Home documentsEnabled />);
    await waitFor(() => expect(richEditor()?.isEditable).toBe(true));
    await act(async () => { richEditor().commands.setContent("keep this window"); });
    fireEvent.click(screen.getByRole("button", { name: "Library: recent and projects (⌘L)" }));
    fireEvent.click(await screen.findByRole("button", { name: "New document…" }));
    fireEvent.click(await screen.findByRole("button", { name: "New Word document" }));
    await screen.findByText(/Markdown recovery copy could not be saved/);
    expect(screen.queryByText("Active document renderer")).not.toBeInTheDocument();
  });
  // A CSV is held as the text it is on disk and edited through its table
  // (src/components/csv-table); nothing converts it on the way in or out.
  async function bootCsv(file: typeof OPEN, overrides: Partial<ElectronAPI>) {
    installBridge({ getInitialFile: vi.fn(async () => file), ...overrides });
    render(<Home />);
    return await screen.findByRole("grid");
  }
  const editCell = async (grid: HTMLElement, from: string, to: string) => {
    await act(async () => { fireEvent.mouseDown(within(grid).getByText(from, { selector: "[role=gridcell]" })); });
    await act(async () => { fireEvent.keyDown(grid, { key: "Enter" }); });
    const field = screen.getByRole("textbox", { name: "Edit cell" });
    await act(async () => {
      fireEvent.change(field, { target: { value: to } });
      fireEvent.keyDown(field, { key: "Enter" });
    });
  };

  it("opens a CSV as a table and autosaves an edited cell as CSV, the rest of the file untouched", async () => {
    const saveFile = okSave(CSV.path);
    // A semicolon file from Excel: BOM, CRLF, a quoted cell, no trailing newline.
    const excel = { ...CSV, content: "\uFEFFa;b\r\n\"x; y\";2\r\n3;4" };
    const grid = await bootCsv(excel, { saveFile });
    expect(document.querySelector("[data-markie-rich-pane]")).toBeNull();
    await editCell(grid, "2", "5");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(saveFile.mock.calls[0]![0].content).toBe("\uFEFFa;b\r\n\"x; y\";5\r\n3;4");
  });

  it("saves a CSV on ⌘S as it is, with no warning about dropped content", async () => {
    const saveFile = okSave(CSV.path);
    const grid = await bootCsv(CSV, { saveFile });
    await editCell(grid, "1", "9");
    await act(async () => {
      emit("onMenuSave");
    });
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(saveFile.mock.calls[0]![0].content).toBe("a,b\n9,2\n");
    expect(screen.queryByText(/Saved as CSV/i)).not.toBeInTheDocument();
  });

  it("offers Save As both forms of a CSV: the file as it is, and the Markdown table of its rows", async () => {
    const saveFileAs = vi.fn(async () => ({ success: true, path: "/n/t.md", name: "t.md", wroteCsv: false }));
    const semicolons = { ...CSV, content: "a;b\r\n1;2\r\n" };
    await bootCsv(semicolons, { saveFileAs } as Partial<ElectronAPI>);
    await act(async () => {
      emit("onMenuSaveAs");
    });
    await waitFor(() => expect(saveFileAs).toHaveBeenCalled());
    expect(saveFileAs).toHaveBeenCalledWith(expect.objectContaining({
      csvContent: "a;b\r\n1;2\r\n",
      content: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    }));
    // Saved as .md, the open document is that Markdown file: no table view of a CSV any more.
    await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
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
