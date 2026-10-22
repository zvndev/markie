import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge, listenerCount } from "@/test/mock-bridge";
import type { DocumentWorkspaceProps } from "./documents/document-workspace";
import type { DocumentShellState } from "@/lib/document-shell";

const state = vi.hoisted(() => ({ props: null as DocumentWorkspaceProps | null, prepare: vi.fn<() => Promise<boolean>>(), cloudGuard: vi.fn<() => boolean>(), execute: vi.fn() }));
vi.mock("./documents/document-workspace", () => ({ DocumentWorkspace: (props: DocumentWorkspaceProps) => {
  state.props = props;
  const { onPrepareClose } = props;
  useEffect(() => { onPrepareClose?.(state.prepare); return () => onPrepareClose?.(null); }, [onPrepareClose]);
  const { onShellChange } = props;
  useEffect(() => {
    onShellChange?.({ name: "synthetic.txt", dirty: false, hasSession: true, private: false, ready: true, busy: false, records: [],
      create: vi.fn(), open: vi.fn(), importFile: vi.fn(), save: vi.fn(), share: vi.fn(), showVault: vi.fn(), prepareClose: state.prepare, prepareLeave: state.prepare, commands: { enabledCommands: ["undo", "redo", "find"], execute: state.execute } });
    return () => onShellChange?.(null);
  }, [onShellChange]);
  return <div><p>{props.incomingDocument?.payload.name ?? "No incoming document"}</p><button type="button" onClick={() => void props.shareDocument?.({ name: "synthetic.txt", bytes: new Uint8Array(), text: "" })}>Share fixture</button></div>;
} }));
vi.mock("./document-cloud-dialog", () => ({ DocumentCloudDialog: ({ onCloseGuard, file, cloudDocumentId }: { file?: unknown; cloudDocumentId?: string; onCloseGuard?: (guard: (() => boolean) | null) => void }) => {
  useEffect(() => { onCloseGuard?.(state.cloudGuard); return () => onCloseGuard?.(null); }, [onCloseGuard]);
  return <p>Synthetic cloud dialog{cloudDocumentId ? ` for ${cloudDocumentId}${file ? " with local seed" : " without local seed"}` : ""}</p>;
} }));
import { DocumentWorkspaceHost } from "./document-workspace-host";

beforeEach(() => { state.props = null; state.prepare.mockReset().mockResolvedValue(true); state.cloudGuard.mockReset().mockReturnValue(true); state.execute.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("native document workspace host lifecycle", () => {
  it("waits for the committed nonbusy shell after successful asynchronous cloud recovery", async () => {
    installBridge(); let shell: DocumentShellState | null = null, finish!: (allowed: boolean) => void;
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    const initial = shell!;
    state.prepare.mockImplementationOnce(() => {
      state.props!.onShellChange!({ ...initial, busy: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    await act(async () => { initial.openCloudDocument!("cloud-id"); });
    expect(shell!.busy).toBe(true);
    await act(async () => { finish(true); });
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
    await act(async () => { state.props!.onShellChange!({ ...initial, busy: true }); });
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
    await act(async () => { state.props!.onShellChange!({ ...initial, busy: false }); });
    await screen.findByText("Synthetic cloud dialog for cloud-id without local seed");
    await act(async () => { state.props!.onShellChange!({ ...initial, busy: false }); });
    expect(screen.getAllByText(/Synthetic cloud dialog/)).toHaveLength(1);
    expect(state.prepare).toHaveBeenCalledOnce();
  });
  it("cancels an unfinished Cloud preparation on unmount without applying its late success", async () => {
    installBridge(); let shell: DocumentShellState | null = null, finish!: (allowed: boolean) => void;
    const view = render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    state.prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { shell!.openCloudDocument!("cloud-id"); });
    view.unmount(); await act(async () => { finish(true); });
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
  });
  it("reports rejected Cloud preparation and permits a later safe retry", async () => {
    installBridge(); let shell: DocumentShellState | null = null;
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    state.prepare.mockRejectedValueOnce(new Error("Synthetic recovery failure"));
    await act(async () => { shell!.openCloudDocument!("cloud-id"); });
    expect(screen.getByRole("alert")).toHaveTextContent("Recovery did not finish");
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
    await act(async () => { shell!.openCloudDocument!("cloud-id"); });
    await screen.findByText("Synthetic cloud dialog for cloud-id without local seed");
  });
  it.each(["session", "private", "inactive", "modal", "unmount"])("cancels prepared cloud opening when %s ownership changes before nonbusy publication", async (change) => {
    installBridge(); let shell: DocumentShellState | null = null, finish!: (allowed: boolean) => void;
    const onShellChange = (value: DocumentShellState | null) => { shell = value; };
    const view = render(<DocumentWorkspaceHost embedded onShellChange={onShellChange} />);
    const initial = shell!;
    state.prepare.mockImplementationOnce(() => {
      state.props!.onShellChange!({ ...initial, busy: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    await act(async () => { initial.openCloudDocument!("cloud-id"); });
    await act(async () => { finish(true); });
    if (change === "unmount") view.unmount();
    else if (change === "inactive") view.rerender(<DocumentWorkspaceHost embedded active={false} onShellChange={onShellChange} />);
    else {
      if (change === "modal") {
        const modal = document.createElement("section"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); view.container.append(modal);
      }
      await act(async () => { state.props!.onShellChange!({ ...initial, busy: false, ...(change === "session" ? { selectedId: "different-session" } : change === "private" ? { private: true } : {}) }); });
    }
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
  });
  it("opens existing cloud IDs only after local recovery and blocks native fallbacks while the modal is open", async () => {
    installBridge(); let shell: DocumentShellState | null = null;
    const view = render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    state.prepare.mockResolvedValueOnce(false);
    await act(async () => { shell!.openCloudDocument!("cloud-id"); });
    expect(screen.queryByText(/Synthetic cloud dialog/)).toBeNull();
    await act(async () => { shell!.openCloudDocument!("cloud-id"); });
    await screen.findByText("Synthetic cloud dialog for cloud-id without local seed");
    expect(state.props?.externalModalOpen).toBe(true);
    expect(view.container.querySelector(".docs-embedded-content")).toHaveAttribute("inert");
    const field = document.createElement("textarea"); view.container.firstElementChild!.append(field); field.focus();
    const exec = vi.fn(); Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); emit("onMenuFind"); shell!.openCloudDocument!("other-id"); });
    expect(exec).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.prepare).toHaveBeenCalledTimes(2);
  });
  it("embeds content without owning the native frame, app close, file commands or legacy text events", async () => {
    const bridge = installBridge({ platform: "darwin" });
    const view = render(<DocumentWorkspaceHost embedded active={false} />);
    expect(view.container.querySelector(".docs-native-titlebar")).toBeNull();
    expect(view.container.querySelector(".docs-desktop-host")).toBeNull();
    expect(state.props).toMatchObject({ embedded: true, active: false, subscribeCommands: undefined });
    expect(bridge.onAppWillClose).not.toHaveBeenCalled();
    expect(bridge.onFileOpened).not.toHaveBeenCalled();
    expect(listenerCount("onMenuSave")).toBe(0);
    expect(listenerCount("onMenuUndo")).toBe(0);
    expect(listenerCount("onDocumentFileOpened")).toBe(1);
    view.rerender(<DocumentWorkspaceHost embedded active />);
    expect(listenerCount("onMenuUndo")).toBe(1);
    view.rerender(<DocumentWorkspaceHost embedded active={false} />);
    expect(listenerCount("onMenuUndo")).toBe(0);
  });
  it("activates retained embedded content when an OS document arrives", async () => {
    const descriptor = { leaseId: "incoming", name: "incoming.txt", size: 1, lastModified: 1, revision: "revision", writable: true };
    const bridge = installBridge(), onActivate = vi.fn();
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptor }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn().mockResolvedValue({ ok: true, value: { descriptor, bytes: new Uint8Array([65]) } });
    render(<DocumentWorkspaceHost embedded active={false} onActivate={onActivate} />);
    await screen.findByText("incoming.txt");
    expect(onActivate).toHaveBeenCalledOnce();
  });
  it("settles a native batch only after every queued request is consumed", async () => {
    const descriptors = ["a", "b"].map((id) => ({ leaseId: id, name: `${id}.txt`, size: 1, lastModified: 1, revision: "revision", writable: true }));
    const bridge = installBridge(); let shell: DocumentShellState | null = null;
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptors[0] }).mockResolvedValueOnce({ ok: true, value: descriptors[1] }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn(async ({ leaseId }) => ({ ok: true as const, value: { descriptor: descriptors.find((item) => item.leaseId === leaseId)!, bytes: new Uint8Array([65]) } }));
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await screen.findByText("a.txt");
    await waitFor(() => expect(bridge.documentFiles!.takeInitial).toHaveBeenCalledTimes(3));
    let complete = false, settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!().then((ok) => { complete = true; return ok; }); });
    expect(complete).toBe(false);
    await act(async () => { state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId, true); });
    await screen.findByText("b.txt"); expect(complete).toBe(false);
    await act(async () => { state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId, true); });
    expect(await settlement).toBe(true);
  });
  it("waits for committed nonbusy publications both after import acknowledgment and after recovery", async () => {
    const descriptor = { leaseId: "word", name: "imported.docx", size: 1, lastModified: 1, revision: "revision", writable: true };
    const bridge = installBridge(); let shell: DocumentShellState | null = null, finish!: (allowed: boolean) => void;
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptor }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn().mockResolvedValue({ ok: true, value: { descriptor, bytes: new Uint8Array([65]) } });
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await screen.findByText("imported.docx");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    const imported = { ...shell!, name: descriptor.name, selectedId: "word-session" };
    state.prepare.mockImplementationOnce(() => {
      state.props!.onShellChange!({ ...imported, busy: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    let result: boolean | undefined, settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!().then((ok) => { result = ok; return ok; }); });
    await act(async () => {
      state.props!.onShellChange!({ ...imported, busy: true });
      state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId, true);
    });
    expect(result).toBeUndefined(); expect(state.prepare).not.toHaveBeenCalled();
    await act(async () => { state.props!.onShellChange!({ ...imported, busy: true }); });
    expect(result).toBeUndefined();
    await act(async () => { state.props!.onShellChange!({ ...imported, busy: false }); });
    expect(state.prepare).toHaveBeenCalledOnce();
    await act(async () => { finish(true); });
    expect(result).toBeUndefined();
    await act(async () => { state.props!.onShellChange!({ ...imported, busy: true }); });
    expect(result).toBeUndefined(); expect(state.prepare).toHaveBeenCalledOnce();
    await act(async () => { state.props!.onShellChange!({ ...imported, busy: false }); });
    expect(await settlement).toBe(true);
  });
  it("waits for initial native activation to commit before preparing settlement", async () => {
    installBridge(); let shell: DocumentShellState | null = null, result: boolean | undefined;
    const onShellChange = (value: DocumentShellState | null) => { shell = value; };
    const view = render(<DocumentWorkspaceHost embedded active={false} onShellChange={onShellChange} />);
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!().then((ok) => { result = ok; return ok; }); });
    expect(result).toBeUndefined(); expect(state.prepare).not.toHaveBeenCalled();
    view.rerender(<DocumentWorkspaceHost embedded active onShellChange={onShellChange} />);
    expect(await settlement).toBe(true); expect(state.prepare).toHaveBeenCalledOnce();
  });
  it("waits through the real inactive parent wrapper until both activation and inherited inert clear commit", async () => {
    installBridge(); let shell: DocumentShellState | null = null, result: boolean | undefined;
    const onShellChange = (value: DocumentShellState | null) => { shell = value; };
    const view = render(<div inert><DocumentWorkspaceHost embedded active={false} onShellChange={onShellChange} /></div>);
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!().then((ok) => { result = ok; return ok; }); });
    expect(result).toBeUndefined(); expect(state.prepare).not.toHaveBeenCalled();
    await act(async () => { view.rerender(<div inert={false}><DocumentWorkspaceHost embedded active onShellChange={onShellChange} /></div>); });
    expect(await settlement).toBe(true); expect(state.prepare).toHaveBeenCalledOnce();
  });
  it("cancels lost active ownership even while the native drain is still pending", async () => {
    const bridge = installBridge(); let shell: DocumentShellState | null = null, finishRead!: (result: { ok: true; value: null }) => void, result: boolean | undefined;
    bridge.documentFiles!.takeInitial = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; })).mockResolvedValue({ ok: true, value: null });
    const onShellChange = (value: DocumentShellState | null) => { shell = value; };
    const view = render(<DocumentWorkspaceHost embedded onShellChange={onShellChange} />);
    await act(async () => { void shell!.settleIncomingDocuments!().then((ok) => { result = ok; }); });
    await act(async () => { view.rerender(<DocumentWorkspaceHost embedded active={false} onShellChange={onShellChange} />); });
    expect(result).toBe(false); expect(state.prepare).not.toHaveBeenCalled();
    await act(async () => { finishRead({ ok: true, value: null }); });
  });
  it.each(["private", "session", "inactive", "inert", "modal", "conversion", "unmount"])("cancels native settlement after recovery when %s ownership changes", async (change) => {
    installBridge(); let shell: DocumentShellState | null = null, finish!: (allowed: boolean) => void;
    const onShellChange = (value: DocumentShellState | null) => { shell = value; };
    const view = render(<DocumentWorkspaceHost embedded onShellChange={onShellChange} />), initial = shell!;
    state.prepare.mockImplementationOnce(() => {
      state.props!.onShellChange!({ ...initial, busy: true });
      return new Promise((resolve) => { finish = resolve; });
    });
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!(); });
    await act(async () => { finish(true); });
    if (change === "unmount") view.unmount();
    else if (change === "inactive") view.rerender(<DocumentWorkspaceHost embedded active={false} onShellChange={onShellChange} />);
    else {
      if (change === "inert") view.container.setAttribute("inert", "");
      if (change === "modal" || change === "conversion") {
        const modal = document.createElement("section"); modal.setAttribute("role", change === "conversion" ? "alertdialog" : "dialog"); modal.setAttribute("aria-modal", "true"); view.container.append(modal);
      }
      await act(async () => { state.props!.onShellChange!({ ...initial, busy: false, ...(change === "private" ? { private: true } : change === "session" ? { selectedId: "other-session" } : {}) }); });
    }
    expect(await settlement).toBe(false); expect(state.prepare).toHaveBeenCalledOnce();
  });
  it.each(["refused", "rejected"])("stops native settlement when recovery is %s", async (failure) => {
    installBridge(); let shell: DocumentShellState | null = null;
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    if (failure === "refused") state.prepare.mockResolvedValueOnce(false);
    else state.prepare.mockRejectedValueOnce(new Error("Synthetic recovery error"));
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!(); });
    expect(await settlement).toBe(false);
  });
  it("retains the thirty-second bound while waiting for nonbusy publication and refuses competing settlement", async () => {
    installBridge(); let shell: DocumentShellState | null = null, result: boolean | undefined;
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await act(async () => { state.props!.onShellChange!({ ...shell!, busy: true }); });
    vi.useFakeTimers(); let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!().then((ok) => { result = ok; return ok; }); });
    expect(await shell!.settleIncomingDocuments!()).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); }); expect(result).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(await settlement).toBe(false);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it("keeps native parse failures distinct from a ready committed shell", async () => {
    const descriptor = { leaseId: "broken", name: "broken.docx", size: 1, lastModified: 1, revision: "revision", writable: true };
    const bridge = installBridge(); let shell: DocumentShellState | null = null;
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptor }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn().mockRejectedValue(new Error("Synthetic native read failure"));
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await screen.findByRole("alert"); let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!(); });
    expect(await settlement).toBe(false); expect(state.prepare).not.toHaveBeenCalled();
  });
  it("cancels native batch settlement on unmount instead of advancing the next file", async () => {
    const descriptor = { leaseId: "a", name: "a.txt", size: 1, lastModified: 1, revision: "revision", writable: true };
    const bridge = installBridge(); let shell: DocumentShellState | null = null;
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptor }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn().mockResolvedValue({ ok: true, value: { descriptor, bytes: new Uint8Array([65]) } });
    const view = render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await screen.findByText("a.txt");
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!(); });
    view.unmount(); expect(await settlement).toBe(false);
  });
  it("does not treat a consumed failed import as a successfully settled file", async () => {
    const descriptor = { leaseId: "broken", name: "broken.docx", size: 1, lastModified: 1, revision: "revision", writable: true };
    const bridge = installBridge(); let shell: DocumentShellState | null = null;
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptor }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn().mockResolvedValue({ ok: true, value: { descriptor, bytes: new Uint8Array([65]) } });
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await screen.findByText("broken.docx");
    let settlement!: Promise<boolean>;
    await act(async () => { settlement = shell!.settleIncomingDocuments!(); });
    await act(async () => { state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId, false); });
    expect(await settlement).toBe(false);
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it("adds the cloud draft guard to both embedded close and leave actions", async () => {
    installBridge(); let shell: DocumentShellState | null = null;
    render(<DocumentWorkspaceHost embedded onShellChange={(value) => { shell = value; }} />);
    await act(async () => { screen.getByRole("button", { name: "Share fixture" }).click(); });
    await screen.findByText("Synthetic cloud dialog"); state.cloudGuard.mockReturnValue(false);
    await act(async () => { expect(await shell!.prepareClose()).toBe(false); expect(await shell!.prepareLeave()).toBe(false); });
    expect(state.prepare).not.toHaveBeenCalled();
    state.cloudGuard.mockReturnValue(true);
    await act(async () => { expect(await shell!.prepareLeave()).toBe(true); });
    expect(state.prepare).toHaveBeenCalledOnce();
  });
  it("reserves a native macOS drag region without placing controls under traffic lights", () => {
    installBridge({ platform: "darwin" });
    const view = render(<DocumentWorkspaceHost />);
    expect(view.container.querySelector(".docs-native-titlebar")).toHaveAttribute("data-window-drag-surface", "true");
    expect(view.container.querySelector(".docs-desktop-mac")).not.toBeNull();
    view.unmount(); installBridge({ platform: "win32" });
    const windows = render(<DocumentWorkspaceHost />);
    expect(windows.container.querySelector(".docs-native-titlebar")).toBeNull();
  });
  it("routes native menu undo and redo through the focused editor history", async () => {
    installBridge();
    const view = render(<DocumentWorkspaceHost />);
    const editor = document.createElement("div"); editor.tabIndex = 0; editor.className = "docs-word-host";
    view.container.firstElementChild!.append(editor); editor.focus();
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); });
    expect(state.execute.mock.calls).toEqual([["undo"], ["redo"]]);
  });
  it("offers native undo to the document textarea's own history before browser fallback", async () => {
    installBridge(); const view = render(<DocumentWorkspaceHost />);
    const field = document.createElement("textarea"); field.setAttribute("data-document-text-editor", ""); view.container.firstElementChild!.append(field); field.focus();
    await act(async () => { emit("onMenuUndo"); });
    expect(state.execute).toHaveBeenCalledWith("undo");
  });
  it("routes active document menus back to the editor after a shell button takes focus", async () => {
    installBridge(); const view = render(<DocumentWorkspaceHost embedded />);
    const editor = document.createElement("div"); editor.className = "docs-word-host";
    const shellButton = document.createElement("button"); shellButton.textContent = "Markie toolbar";
    view.container.firstElementChild!.append(editor); view.container.append(shellButton); shellButton.focus();
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); emit("onMenuFind"); });
    expect(state.execute.mock.calls).toEqual([["undo"], ["redo"], ["find"]]);
    expect(view.container.querySelector('[role="tab"]')).toBeNull();
  });
  it("refuses native editor fallbacks while a parent shell is inert for combined close", async () => {
    installBridge(); const view = render(<div inert><DocumentWorkspaceHost embedded /></div>);
    const editor = document.createElement("div"); editor.className = "docs-word-host";
    const received = vi.fn(); editor.addEventListener("keydown", received); view.container.querySelector(".docs-embedded-host")!.append(editor);
    const shellButton = document.createElement("button"); view.container.append(shellButton); shellButton.focus();
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); emit("onMenuFind"); });
    expect(received).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("acknowledges only the exact close ticket after recovery succeeds", async () => {
    const bridge = installBridge();
    render(<DocumentWorkspaceHost />);
    await act(async () => { emit("onAppWillClose", 41); });
    await waitFor(() => expect(bridge.appCloseReady).toHaveBeenCalledWith(41));
    expect(bridge.appCloseCancel).not.toHaveBeenCalled();
  });
  it("cancels a native close when durable recovery cannot be confirmed", async () => {
    state.prepare.mockResolvedValue(false); const bridge = installBridge();
    render(<DocumentWorkspaceHost />);
    await act(async () => { emit("onAppWillClose", 42); });
    await waitFor(() => expect(bridge.appCloseCancel).toHaveBeenCalledWith(42));
    expect(bridge.appCloseReady).not.toHaveBeenCalled();
  });
  it("does not acknowledge a late recovery after its host was unmounted", async () => {
    let finish!: (value: boolean) => void;
    state.prepare.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const bridge = installBridge(), view = render(<DocumentWorkspaceHost />);
    await act(async () => { emit("onAppWillClose", 43); });
    view.unmount(); await act(async () => { finish(true); });
    expect(bridge.appCloseReady).not.toHaveBeenCalled();
  });
  it("keeps the window open when the cloud draft close guard refuses", async () => {
    state.cloudGuard.mockReturnValue(false); const bridge = installBridge();
    render(<DocumentWorkspaceHost />);
    await act(async () => { screen.getByRole("button", { name: "Share fixture" }).click(); });
    await screen.findByText("Synthetic cloud dialog");
    await act(async () => { emit("onAppWillClose", 44); });
    await waitFor(() => expect(bridge.appCloseCancel).toHaveBeenCalledWith(44));
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it("queues OS-granted documents instead of replacing an unconsumed request", async () => {
    const descriptors = ["a", "b"].map((id) => ({ leaseId: id, name: `${id}.txt`, size: 1, lastModified: 1, revision: "revision", writable: true }));
    const bridge = installBridge();
    bridge.documentFiles!.takeInitial = vi.fn().mockResolvedValueOnce({ ok: true, value: descriptors[0] }).mockResolvedValueOnce({ ok: true, value: descriptors[1] }).mockResolvedValue({ ok: true, value: null });
    bridge.documentFiles!.read = vi.fn(async ({ leaseId }) => ({ ok: true as const, value: { descriptor: descriptors.find((value) => value.leaseId === leaseId)!, bytes: new Uint8Array([65]) } }));
    render(<DocumentWorkspaceHost />);
    await screen.findByText("a.txt");
    await waitFor(() => expect(bridge.documentFiles!.takeInitial).toHaveBeenCalledTimes(3));
    await act(async () => { state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId, true); });
    await screen.findByText("b.txt");
    expect(state.props?.pickDocument).toBeTypeOf("function"); expect(state.props?.subscribeCommands).toBeTypeOf("function");
  });
});
