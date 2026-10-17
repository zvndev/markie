import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge } from "@/test/mock-bridge";
import type { DocumentShellState } from "@/lib/document-shell";

const state = vi.hoisted(() => ({ shell: null as DocumentShellState | null, activate: null as (() => void) | null, nativeOnMount: false }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost", getAuthToken: () => null, adoptAuthToken: () => {}, pushSyncConfig: () => {},
}));
vi.mock("@/components/document-workspace-host", () => ({ DocumentWorkspaceHost: ({ active, embedded, onShellChange, onActivate }: {
  active: boolean; embedded: boolean; onShellChange: (shell: DocumentShellState | null) => void; onActivate: () => void;
}) => {
  useEffect(() => { onShellChange(state.shell); return () => onShellChange(null); }, [onShellChange]);
  useEffect(() => { state.activate = onActivate; if (state.nativeOnMount) onActivate(); }, [onActivate]);
  return <section data-testid="format-editor" data-embedded={embedded}>
    {active ? <p>Word content inside Markie</p> : null}
  </section>;
} }));
vi.mock("@/components/document-cloud-library", () => ({ DocumentCloudLibrary: ({ onOpen }: { onOpen: (id: string) => void }) => <section aria-label="Cloud documents"><button type="button" onClick={() => onOpen("cloud-proposal")}>Cloud proposal.docx</button></section> }));
import Home from "./page";

beforeEach(() => {
  localStorage.clear();
  state.nativeOnMount = false; state.activate = null;
  state.shell = {
    name: "proposal.docx", dirty: true, hasSession: true, private: false, ready: true, busy: false, records: [], renderer: "word",
    commands: { enabledCommands: ["format-bold", "insert-table", "document-history", "find"], execute: vi.fn() },
    create: vi.fn(), open: vi.fn(), openCloudDocument: vi.fn(), settleIncomingDocuments: vi.fn(async () => true), importFile: vi.fn(), save: vi.fn(), share: vi.fn(), showVault: vi.fn(),
    prepareClose: vi.fn(async () => true), prepareLeave: vi.fn(async () => true),
  };
});
async function boot(overrides: Parameters<typeof installBridge>[0] = {}) {
  const api = installBridge({ getInitialFile: vi.fn(async () => ({ name: "notes.md", path: "/notes/notes.md", content: "Retained Markdown buffer\n" })), ...overrides });
  render(<Home documentsEnabled />);
  await screen.findByText("Retained Markdown buffer");
  await screen.findByTestId("format-editor");
  await userEvent.click(screen.getByRole("button", { name: "Library: recent and projects (⌘L)" }));
  await screen.findByRole("button", { name: "New Word document" });
  return api;
}
async function openWord() {
  await userEvent.click(screen.getByRole("button", { name: "New Word document" }));
  await screen.findByText("Word content inside Markie");
}

describe("document capabilities inside the existing Markie app", () => {
  it("hands a cold native Word request to the original shell after Markdown initialization", async () => {
    state.nativeOnMount = true;
    installBridge({ getInitialFile: vi.fn(async () => null) });
    render(<Home documentsEnabled />);
    await screen.findByText("Word content inside Markie");
    expect(document.querySelectorAll(".markie-toolbar")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Return to|Classic workspace/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Library: recent and projects (⌘L)" }));
    await userEvent.click(screen.getByRole("button", { name: /Untitled\.md/ }));
    await waitFor(() => expect(document.querySelector("[data-markie-rich-pane]")).toBeVisible());
  });
  it("keeps one original shell and the mounted Markdown buffer across format changes", async () => {
    await boot();
    const markdown = screen.getByText("Retained Markdown buffer");
    const toolbar = document.querySelector(".markie-toolbar"), rail = document.querySelector(".markie-activity-bar"), library = document.querySelector(".markie-side-panel");
    await openWord();
    expect(screen.getByTestId("format-editor")).toHaveAttribute("data-embedded", "true");
    expect(document.querySelectorAll(".markie-toolbar")).toHaveLength(1);
    expect(document.querySelector(".markie-toolbar")).toBe(toolbar);
    expect(document.querySelector(".markie-activity-bar")).toBe(rail);
    expect(document.querySelector(".markie-side-panel")).toBe(library);
    expect(markdown).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Documents: Word, text and private files" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    await waitFor(() => expect(markdown).toBeVisible());
    expect(screen.getByText("Retained Markdown buffer")).toBe(markdown);
    expect(document.title).toBe("notes.md — Markie");
  });
  it("routes native save/copy to Word without saving the hidden Markdown buffer", async () => {
    const api = await boot(); await openWord();
    await act(async () => { emit("onMenuSave"); emit("onMenuSaveAs"); });
    expect(state.shell!.save).toHaveBeenNthCalledWith(1);
    expect(state.shell!.save).toHaveBeenNthCalledWith(2, true);
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(api.saveFileAs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(state.shell!.save).toHaveBeenCalledTimes(3);
  });
  it("opens a sidebar cloud document through the guarded renderer without creating a local seed", async () => {
    const api = await boot();
    const markdown = screen.getByText("Retained Markdown buffer");
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    await waitFor(() => expect(state.shell!.openCloudDocument).toHaveBeenCalledExactlyOnceWith("cloud-proposal"));
    expect(state.shell!.prepareLeave).toHaveBeenCalledTimes(1);
    expect(state.shell!.create).not.toHaveBeenCalled();
    expect(api.openFilePath).not.toHaveBeenCalled();
    expect(markdown).toBeInTheDocument();
    expect(document.querySelectorAll(".markie-toolbar")).toHaveLength(1);
  });
  it("keeps Markdown visible when the retained document refuses a cloud handoff", async () => {
    await boot();
    vi.mocked(state.shell!.prepareLeave).mockResolvedValue(false);
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    expect(state.shell!.openCloudDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Retained Markdown buffer")).toBeVisible();
    expect(document.title).toBe("notes.md — Markie");
  });
  it("does not start cloud handoff while the document renderer is busy", async () => {
    state.shell!.busy = true;
    await boot();
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    expect(state.shell!.prepareLeave).not.toHaveBeenCalled();
    expect(state.shell!.openCloudDocument).not.toHaveBeenCalled();
    expect(screen.getByText("Retained Markdown buffer")).toBeVisible();
  });
  it("waits for the Word import before opening the final Markdown file in a mixed drop", async () => {
    let finish!: (settled: boolean) => void;
    vi.mocked(state.shell!.settleIncomingDocuments!).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const openFilePath = vi.fn(async (path: string) => {
      if (path.endsWith(".docx")) { state.activate?.(); return null; }
      return { name: "last.md", path, content: "Final mixed-drop Markdown\n" };
    });
    await boot({ pathForFile: (file) => `/drop/${file.name}`, openFilePath });
    await act(async () => { fireEvent.drop(document.querySelector(".markie-side-panel")!, { dataTransfer: { files: [new File(["word"], "first.docx"), new File(["text"], "last.md")] } }); });
    await waitFor(() => expect(state.shell!.settleIncomingDocuments).toHaveBeenCalledOnce());
    expect(openFilePath.mock.calls).toEqual([["/drop/first.docx"]]);
    await act(async () => { finish(true); });
    await screen.findByText("Final mixed-drop Markdown");
    expect(openFilePath.mock.calls).toEqual([["/drop/first.docx"], ["/drop/last.md"]]);
    expect(document.title).toBe("last.md — Markie");
  });
  it("does not let earlier Markdown overtake a final queued Word import", async () => {
    const openFilePath = vi.fn(async (path: string) => {
      if (path.endsWith(".docx")) { state.activate?.(); return null; }
      return { name: "first.md", path, content: "Earlier dropped Markdown\n" };
    });
    const api = await boot({ pathForFile: (file) => `/drop/${file.name}`, openFilePath });
    await act(async () => { fireEvent.drop(document.querySelector(".markie-side-panel")!, { dataTransfer: { files: [new File(["text"], "first.md"), new File(["word"], "last.docx")] } }); });
    await waitFor(() => expect(state.shell!.settleIncomingDocuments).toHaveBeenCalledOnce());
    await screen.findByText("Word content inside Markie");
    expect(screen.queryByText("Earlier dropped Markdown")).not.toBeInTheDocument();
    expect(api.registryTrack).toHaveBeenCalledWith({ path: "/drop/first.md", name: "first.md", content: "Earlier dropped Markdown\n" });
    expect(api.registryTrack).not.toHaveBeenCalledWith(expect.objectContaining({ name: "last.docx" }));
  });
  it("stops a mixed drop when its native import fails or still needs consent", async () => {
    vi.mocked(state.shell!.settleIncomingDocuments!).mockResolvedValue(false);
    const openFilePath = vi.fn(async () => { state.activate?.(); return null; });
    await boot({ pathForFile: (file) => `/drop/${file.name}`, openFilePath });
    await act(async () => { fireEvent.drop(document.querySelector(".markie-side-panel")!, { dataTransfer: { files: [new File(["broken"], "broken.docx"), new File(["text"], "last.md")] } }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Finish the pending document operation before opening the remaining dropped files.");
    expect(openFilePath).toHaveBeenCalledExactlyOnceWith("/drop/broken.docx");
    expect(screen.getByText("Retained Markdown buffer")).toBeInTheDocument();
  });
  it("routes native actions to the current renderer and publishes unique known capabilities", async () => {
    const api = await boot(); await openWord();
    await waitFor(() => expect(api.setDocumentMenuState).toHaveBeenCalledWith(expect.objectContaining({ renderer: "word", enabledCommands: expect.arrayContaining(["format-bold", "insert-table", "document-history"]) })));
    await act(async () => { emit("onDocumentCommand", "format-bold"); emit("onDocumentCommand", "not-a-command"); });
    expect(state.shell!.commands!.execute).toHaveBeenCalledExactlyOnceWith("format-bold");
    for (const [sent] of vi.mocked(api.setDocumentMenuState!).mock.calls) expect(new Set(sent.enabledCommands).size).toBe(sent.enabledCommands.length);
  });
  it("disables all native document capabilities inside private scope", async () => {
    state.shell!.private = true; state.shell!.renderer = "none";
    const api = await boot(); await openWord();
    await waitFor(() => expect(api.setDocumentMenuState).toHaveBeenCalledWith({ renderer: "none", enabledCommands: [] }));
    await act(async () => { emit("onDocumentCommand", "format-bold"); });
    expect(state.shell!.commands!.execute).not.toHaveBeenCalled();
  });
  it("selects retained Windows Markdown by canonical path without reloading its buffer", async () => {
    const api = await boot({ platform: "win32", getInitialFile: vi.fn(async () => ({ name: "notes.md", path: "C:\\Docs\\Notes.md", content: "Retained Markdown buffer\n" })), libraryState: vi.fn(async () => ({ signedIn: false, items: [{ kind: "local" as const, path: "c:\\docs\\notes.md", name: "notes.md", cloudId: null, state: "local-only" as const, lastOpenedAt: null, remoteVersion: null, exists: true }] })) });
    const markdown = screen.getByText("Retained Markdown buffer"); await openWord();
    await userEvent.click(screen.getByText("notes.md", { exact: true }));
    await waitFor(() => expect(markdown).toBeVisible());
    expect(api.openFilePath).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Return to|Classic workspace/i })).not.toBeInTheDocument();
  });
  it("forwards exact native close tickets only after document guards succeed", async () => {
    const api = await boot(); await openWord();
    vi.mocked(state.shell!.prepareClose).mockResolvedValueOnce(false);
    await act(async () => { emit("onAppWillClose", 74); });
    await waitFor(() => expect(api.appCloseCancel).toHaveBeenCalledWith(74));
    expect(api.appCloseReady).not.toHaveBeenCalled();
    await act(async () => { emit("onAppWillClose", 75); });
    await waitFor(() => expect(api.appCloseReady).toHaveBeenCalledWith(75));
  });
  it("retains the active Word editor when leaving its guarded state is refused", async () => {
    await boot(); await openWord();
    vi.mocked(state.shell!.prepareLeave).mockResolvedValue(false);
    await userEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    expect(await screen.findByText("Word content inside Markie")).toBeVisible();
    expect(document.title).toBe("• proposal.docx — Markie");
  });
  it("checks retained document recovery even when Markdown is visible", async () => {
    const api = await boot();
    vi.mocked(state.shell!.prepareClose).mockResolvedValue(false);
    await act(async () => { emit("onAppWillClose", 81); });
    await waitFor(() => expect(api.appCloseCancel).toHaveBeenCalledWith(81));
    expect(api.appCloseReady).not.toHaveBeenCalled();
  });
  it.each(["refused", "rejected"])("keeps dirty hidden Markdown when strict close recovery is %s", async (failure) => {
    const api = await boot();
    vi.mocked(api.saveFile).mockRejectedValue(new Error("Synthetic disk full"));
    await waitFor(() => expect((window as unknown as { __markieEditor?: { isEditable: boolean } }).__markieEditor?.isEditable).toBe(true));
    await act(async () => { (window as unknown as { __markieEditor: { commands: { setContent: (content: string) => void } } }).__markieEditor.commands.setContent("<p>Dirty retained Markdown</p>"); });
    await waitFor(() => expect(document.title).toContain("•"));
    await openWord();
    if (failure === "refused") vi.mocked(api.draftSave!).mockResolvedValue({ ok: false });
    else vi.mocked(api.draftSave!).mockRejectedValue(new Error("Synthetic journal failure"));
    await act(async () => { emit("onAppWillClose", 94); });
    await waitFor(() => expect(api.appCloseCancel).toHaveBeenCalledWith(94));
    expect(api.appCloseReady).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Markdown recovery could not be confirmed");
  });
  it("freezes the entire shared shell while the second close guard is pending and unfreezes on cancellation", async () => {
    const api = await boot();
    vi.mocked(api.saveFile).mockRejectedValue(new Error("Synthetic disk full"));
    await waitFor(() => expect((window as unknown as { __markieEditor?: { isEditable: boolean } }).__markieEditor?.isEditable).toBe(true));
    await act(async () => { (window as unknown as { __markieEditor: { commands: { setContent: (content: string) => void } } }).__markieEditor.commands.setContent("<p>Retained pending close draft</p>"); });
    await waitFor(() => expect(document.title).toContain("•"));
    await openWord();
    let finish!: (value: { ok: boolean }) => void;
    vi.mocked(api.draftSave!).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ ok: false });
    await act(async () => { emit("onAppWillClose", 95); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(document.querySelector(".markie-shell")).toHaveAttribute("inert");
    expect(state.shell!.prepareClose).toHaveBeenCalledTimes(1);
    expect(api.appCloseReady).not.toHaveBeenCalled();
    await act(async () => { finish({ ok: false }); });
    await waitFor(() => expect(api.appCloseCancel).toHaveBeenCalledWith(95));
    expect(document.querySelector(".markie-shell")).not.toHaveAttribute("inert");
  });
});
