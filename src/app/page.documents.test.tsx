import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge } from "@/test/mock-bridge";
import type { DocumentShellState } from "@/lib/document-shell";
import { authStore } from "@/lib/auth-store";

const state = vi.hoisted(() => ({ shell: null as DocumentShellState | null, activate: null as (() => void) | null, publish: null as ((shell: DocumentShellState | null) => void) | null, authUser: null as { id: string; name: string; email: string } | null, hostActive: false, nativeOnMount: false }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => state.authUser },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost", getAuthToken: () => null, adoptAuthToken: () => {}, pushSyncConfig: () => {},
  getConfirmedAuthIdentity: () => null, getServerURL: () => "https://account.example.test",
}));
vi.mock("@/components/document-workspace-host", () => ({ DocumentWorkspaceHost: ({ active, embedded, onShellChange, onActivate }: {
  active: boolean; embedded: boolean; onShellChange: (shell: DocumentShellState | null) => void; onActivate: () => void;
}) => {
  useEffect(() => { state.publish = onShellChange; onShellChange(state.shell); return () => { state.publish = null; onShellChange(null); }; }, [onShellChange]);
  useEffect(() => { state.hostActive = active; }, [active]);
  useEffect(() => { state.activate = onActivate; if (state.nativeOnMount) onActivate(); }, [onActivate]);
  return <section className="docs-embedded-host" inert={!active} data-testid="format-editor" data-embedded={embedded}>
    {active ? <p>Word content inside Markie</p> : null}
  </section>;
} }));
vi.mock("@/components/document-cloud-library", () => ({ DocumentCloudLibrary: ({ onOpen }: { onOpen: (id: string) => void }) => <section aria-label="Cloud documents"><button type="button" onClick={() => onOpen("cloud-proposal")}>Cloud proposal.docx</button></section> }));
import Home from "./page";

beforeEach(async () => {
  localStorage.clear();
  state.authUser = null; await authStore.refresh();
  state.nativeOnMount = false; state.activate = null; state.publish = null; state.hostActive = false;
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
  await screen.findByRole("button", { name: "New document…" });
  return api;
}
async function openWord() {
  await userEvent.click(screen.getByRole("button", { name: "New document…" }));
  await userEvent.click(screen.getByRole("button", { name: "New Word document" }));
  await screen.findByText("Word content inside Markie");
}

describe("document capabilities inside the existing Markie app", () => {
  it("never falls back to a Markdown picker while browser document tools are cold", async () => {
    installBridge();
    vi.stubGlobal("electronAPI", undefined);
    const initial = state.shell!; state.shell = null;
    render(<Home documentsEnabled />);
    await screen.findByTestId("format-editor");
    const open = screen.getByRole("button", { name: /^(Open|Open file…)$/ });
    expect(open).toBeDisabled();
    await userEvent.click(open);
    expect(document.querySelector('input[type="file"]')).toBeNull(); expect(initial.importFile).not.toHaveBeenCalled();
    await act(async () => { state.shell = { ...initial, ready: false }; state.publish!(state.shell); });
    expect(open).toBeDisabled();
    await act(async () => { state.shell = initial; state.publish!(initial); });
    await waitFor(() => expect(open).not.toBeDisabled());
    await userEvent.click(open);
    expect(initial.importFile).toHaveBeenCalledOnce();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
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

  it("routes shared PDF and native output to Word, never the retained Markdown", async () => {
    state.shell!.commands!.enabledCommands = [...state.shell!.commands!.enabledCommands, "document-print", "document-export-pdf"];
    const api = await boot(); await openWord();
    await act(async () => { emit("onMenuPrint"); emit("onMenuExportPDF", "light"); emit("onMenuExportPDF", "dark"); });
    expect(state.shell!.commands!.execute).toHaveBeenNthCalledWith(1, "document-print");
    expect(state.shell!.commands!.execute).toHaveBeenNthCalledWith(2, "document-export-pdf");
    expect(state.shell!.commands!.execute).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Export menu" }));
    await userEvent.click(screen.getByRole("button", { name: "Export PDF…" }));
    expect(state.shell!.commands!.execute).toHaveBeenLastCalledWith("document-export-pdf");
    expect(api.exportPDF).not.toHaveBeenCalled();
    expect(screen.getByText("Retained Markdown buffer")).not.toBeVisible();
  });

  it.each(["private", "busy", "modal", "inert", "unsupported"])("blocks Word output when %s without falling through to Markdown", async (guard) => {
    state.shell!.commands!.enabledCommands = [...state.shell!.commands!.enabledCommands, "document-print", "document-export-pdf"];
    const api = await boot(); await openWord();
    await act(async () => {
      if (guard === "private") state.shell!.private = true;
      if (guard === "busy") state.shell!.busy = true;
      if (guard === "modal") state.shell!.commands!.modalOpen = true;
      if (guard === "unsupported") state.shell!.commands!.enabledCommands = [];
      state.publish!({ ...state.shell! });
    });
    if (guard === "inert") document.querySelector(".docs-embedded-host")!.setAttribute("inert", "");
    await act(async () => { emit("onMenuPrint"); emit("onMenuExportPDF", "light"); emit("onDocumentCommand", "document-export-pdf"); });
    expect(state.shell!.commands!.execute).not.toHaveBeenCalled();
    expect(api.exportPDF).not.toHaveBeenCalled();
  });

  it("offers only the supported Word output commands through the existing palette", async () => {
    state.shell!.commands!.enabledCommands = [...state.shell!.commands!.enabledCommands, "document-print", "document-export-pdf"];
    const api = await boot(); await openWord();
    await userEvent.click(screen.getByRole("button", { name: "Commands (⌘K)" }));
    await userEvent.type(screen.getByPlaceholderText("Type a command…"), "PDF");
    expect(screen.queryByRole("option", { name: /PDF \((Dark|Light)\)/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /File: Export PDF…$/ }));
    await waitFor(() => expect(state.shell!.commands!.execute).toHaveBeenCalledExactlyOnceWith("document-export-pdf"));
    expect(api.exportPDF).not.toHaveBeenCalled();
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
  it("retains the Cloud intent until activation and delayed nonbusy shell publication commit", async () => {
    await boot();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    const initial = state.shell!, accepted = vi.fn(); let finish!: (allowed: boolean) => void;
    vi.mocked(initial.openCloudDocument!).mockImplementation(() => { if (state.hostActive && !state.shell!.busy) accepted(); });
    vi.mocked(initial.prepareLeave).mockImplementationOnce(() => {
      state.shell = { ...initial, busy: true }; state.publish!(state.shell);
      return new Promise((resolve) => { finish = resolve; });
    });
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    await userEvent.click(screen.getByRole("button", { name: "Cloud proposal.docx" }));
    expect(initial.prepareLeave).toHaveBeenCalledOnce();
    await act(async () => { finish(true); });
    await screen.findByText("Word content inside Markie");
    expect(accepted).not.toHaveBeenCalled();
    await act(async () => { state.shell = { ...initial, busy: false }; state.publish!(state.shell); });
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(initial.openCloudDocument).toHaveBeenCalledExactlyOnceWith("cloud-proposal");
  });
  it("dispatches Cloud only after the Host active commit, without depending on an animation frame", async () => {
    await boot(); const accepted = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.mocked(state.shell!.openCloudDocument!).mockImplementation(() => { if (state.hostActive && !document.querySelector(".docs-embedded-host[inert]")) accepted(); });
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(state.shell!.openCloudDocument).toHaveBeenCalledExactlyOnceWith("cloud-proposal");
  });
  it.each(["session", "private", "modal", "closing", "navigation", "account"])("cancels a prepared Cloud handoff when %s ownership changes", async (change) => {
    await boot(); const initial = state.shell!; let finish!: (allowed: boolean) => void, finishClose: ((allowed: boolean) => void) | undefined;
    vi.mocked(initial.prepareLeave).mockImplementationOnce(() => {
      state.shell = { ...initial, busy: true }; state.publish!(state.shell);
      return new Promise((resolve) => { finish = resolve; });
    });
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    await act(async () => { finish(true); }); await screen.findByText("Word content inside Markie");
    let modal: HTMLElement | undefined;
    if (change === "navigation") {
      await userEvent.click(screen.getByRole("button", { name: "Library: recent and projects (⌘L)" }));
      await userEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    }
    else if (change === "account") await act(async () => { state.authUser = { id: "new-account", name: "Synthetic B", email: "b@example.test" }; await authStore.refresh(); });
    else if (change === "closing") {
      vi.mocked(initial.prepareClose).mockImplementationOnce(() => new Promise((resolve) => { finishClose = resolve; }));
      await act(async () => { emit("onAppWillClose", 99); });
      expect(document.querySelector(".markie-shell")).toHaveAttribute("inert");
    } else {
      if (change === "modal") { modal = document.createElement("section"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); document.body.append(modal); }
      await act(async () => { state.shell = { ...initial, busy: true, ...(change === "session" ? { selectedId: "other-session" } : change === "private" ? { private: true } : {}) }; state.publish!(state.shell); });
    }
    modal?.remove();
    await act(async () => { state.shell = { ...initial, busy: false }; state.publish!(state.shell); finishClose?.(false); });
    expect(initial.openCloudDocument).not.toHaveBeenCalled();
  });
  it("cancels a pending Cloud handoff on unmount before preparation resolves", async () => {
    await boot(); const initial = state.shell!; let finish!: (allowed: boolean) => void;
    vi.mocked(initial.prepareLeave).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    cleanup(); await act(async () => { finish(true); });
    expect(initial.openCloudDocument).not.toHaveBeenCalled();
  });
  it("does not activate Word after Cloud is cancelled during Markdown recovery", async () => {
    const api = await boot(); let finish!: (result: { ok: boolean }) => void;
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    vi.mocked(api.saveFile).mockRejectedValue(new Error("Synthetic disk failure"));
    await waitFor(() => expect((window as unknown as { __markieEditor?: { isEditable: boolean } }).__markieEditor?.isEditable).toBe(true));
    await act(async () => { (window as unknown as { __markieEditor: { commands: { setContent: (html: string) => void } } }).__markieEditor.commands.setContent("<p>Retained delayed Markdown</p>"); });
    vi.mocked(api.draftSave!).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await userEvent.click(screen.getByRole("button", { name: "Commands (⌘K)" }));
    await screen.findByRole("dialog", { name: "Command palette" });
    await act(async () => { finish({ ok: true }); });
    // The modal cancels the handoff and full-page Cloud stays in place.
    // Return through its own Document action to prove the buffer survived.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Back to document" }));
    expect(await screen.findByText("Retained delayed Markdown")).toBeVisible();
    expect(state.hostActive).toBe(false);
    expect(state.shell!.openCloudDocument).not.toHaveBeenCalled();
  });
  it("reports a rejected Cloud preparation and permits one safe retry", async () => {
    await boot(); const initial = state.shell!;
    vi.mocked(initial.prepareLeave).mockRejectedValueOnce(new Error("Synthetic recovery failure"));
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cloud proposal.docx" }));
    expect(await screen.findByText("Recovery did not finish. The cloud document was not opened.")).toBeVisible();
    expect(initial.openCloudDocument).not.toHaveBeenCalled();
    // The abandoned handoff steps back to the retained document so its error
    // is visible; the retry starts by returning to Cloud.
    await userEvent.click(screen.getByRole("button", { name: "Cloud: synced and shared" }));
    await userEvent.click(screen.getByRole("button", { name: "Cloud proposal.docx" }));
    await waitFor(() => expect(initial.openCloudDocument).toHaveBeenCalledExactlyOnceWith("cloud-proposal"));
    expect(screen.queryByText("Recovery did not finish. The cloud document was not opened.")).toBeNull();
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
    // No handoff started, so the full-page Cloud stays put for a later retry
    // and the retained buffer remains mounted underneath it.
    expect(screen.getByRole("heading", { name: "Cloud" })).toBeVisible();
    expect(screen.getByText("Retained Markdown buffer")).not.toBeVisible();
    expect(document.title).toBe("notes.md — Markie");
  });
  it("announces an overlapping drop and stays busy until the whole original batch settles", async () => {
    let finish!: (settled: boolean) => void;
    vi.mocked(state.shell!.settleIncomingDocuments!).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const openFilePath = vi.fn(async () => { state.activate?.(); return null; });
    await boot({ pathForFile: (file) => `/drop/${file.name}`, openFilePath });
    const shell = document.querySelector(".markie-shell")!;
    const drop = (name: string) => fireEvent.drop(document.querySelector(".markie-side-panel")!, { dataTransfer: { files: [new File(["word"], name)] } });
    await act(async () => { drop("first.docx"); });
    await waitFor(() => expect(state.shell!.settleIncomingDocuments).toHaveBeenCalledOnce());
    expect(shell).toHaveAttribute("aria-busy", "true");
    await act(async () => { drop("second.docx"); });
    expect(screen.getByRole("alert")).toHaveTextContent("Drop them again when the editor is ready.");
    expect(openFilePath).toHaveBeenCalledExactlyOnceWith("/drop/first.docx");
    await act(async () => { finish(true); });
    await waitFor(() => expect(shell).toHaveAttribute("aria-busy", "false"));
  });
  it("explains a drop rejected by a busy renderer without starting file access", async () => {
    state.shell!.busy = true;
    const api = await boot({ pathForFile: (file) => `/drop/${file.name}` });
    await act(async () => { fireEvent.drop(document.querySelector(".markie-side-panel")!, { dataTransfer: { files: [new File(["word"], "later.docx")] } }); });
    expect(screen.getByText("Those files were not opened while another operation was running. Drop them again when the editor is ready.")).toBeVisible();
    expect(api.openFilePath).not.toHaveBeenCalled();
    expect(document.querySelector(".markie-shell")).toHaveAttribute("aria-busy", "false");
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
