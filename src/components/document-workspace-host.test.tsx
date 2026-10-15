import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge, listenerCount } from "@/test/mock-bridge";
import type { DocumentWorkspaceProps } from "./documents/document-workspace";
import type { DocumentShellState } from "@/lib/document-shell";

const state = vi.hoisted(() => ({ props: null as DocumentWorkspaceProps | null, prepare: vi.fn<() => Promise<boolean>>(), cloudGuard: vi.fn<() => boolean>() }));
vi.mock("./documents/document-workspace", () => ({ DocumentWorkspace: (props: DocumentWorkspaceProps) => {
  state.props = props;
  const { onPrepareClose } = props;
  useEffect(() => { onPrepareClose?.(state.prepare); return () => onPrepareClose?.(null); }, [onPrepareClose]);
  const { onShellChange } = props;
  useEffect(() => {
    onShellChange?.({ name: "synthetic.txt", dirty: false, hasSession: true, private: false, ready: true, busy: false, records: [],
      create: vi.fn(), open: vi.fn(), importFile: vi.fn(), save: vi.fn(), share: vi.fn(), showVault: vi.fn(), prepareClose: state.prepare, prepareLeave: state.prepare });
    return () => onShellChange?.(null);
  }, [onShellChange]);
  return <div><p>{props.incomingDocument?.payload.name ?? "No incoming document"}</p><button type="button" onClick={() => void props.shareDocument?.({ name: "synthetic.txt", bytes: new Uint8Array(), text: "" })}>Share fixture</button></div>;
} }));
vi.mock("./document-cloud-dialog", () => ({ DocumentCloudDialog: ({ onCloseGuard }: { onCloseGuard?: (guard: (() => boolean) | null) => void }) => {
  useEffect(() => { onCloseGuard?.(state.cloudGuard); return () => onCloseGuard?.(null); }, [onCloseGuard]);
  return <p>Synthetic cloud dialog</p>;
} }));
import { DocumentWorkspaceHost } from "./document-workspace-host";

beforeEach(() => { state.props = null; state.prepare.mockReset().mockResolvedValue(true); state.cloudGuard.mockReset().mockReturnValue(true); });

describe("native document workspace host lifecycle", () => {
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
    const received: { key: string; redo: boolean }[] = [];
    editor.addEventListener("keydown", (event) => { received.push({ key: event.key, redo: event.shiftKey }); event.preventDefault(); });
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); });
    expect(received).toEqual([{ key: "z", redo: false }, { key: "z", redo: true }]);
  });
  it("offers native undo to the document textarea's own history before browser fallback", async () => {
    installBridge(); const view = render(<DocumentWorkspaceHost />);
    const field = document.createElement("textarea"); field.setAttribute("data-document-text-editor", ""); view.container.firstElementChild!.append(field); field.focus();
    const handled = vi.fn((event: KeyboardEvent) => event.preventDefault()); field.addEventListener("keydown", handled);
    await act(async () => { emit("onMenuUndo"); });
    expect(handled).toHaveBeenCalledOnce();
  });
  it("routes active document menus back to the editor after a shell button takes focus", async () => {
    installBridge(); const view = render(<DocumentWorkspaceHost embedded />);
    const editor = document.createElement("div"); editor.className = "docs-word-host";
    const home = document.createElement("button"); home.role = "tab"; home.textContent = "Home"; const clicked = vi.fn(); home.addEventListener("click", clicked);
    const find = document.createElement("input"); find.setAttribute("aria-label", "Find Word text"); editor.append(home, find);
    const shellButton = document.createElement("button"); shellButton.textContent = "Markie toolbar";
    view.container.firstElementChild!.append(editor); view.container.append(shellButton); shellButton.focus();
    const received: string[] = [];
    editor.addEventListener("keydown", (event) => { received.push(event.key); if (event.key !== "f") event.preventDefault(); });
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); emit("onMenuFind"); });
    expect(received).toEqual(["z", "z", "f"]); expect(clicked).toHaveBeenCalledOnce();
    await waitFor(() => expect(find).toHaveFocus());
  });
  it("refuses native editor fallbacks while a parent shell is inert for combined close", async () => {
    installBridge(); const view = render(<div inert><DocumentWorkspaceHost embedded /></div>);
    const editor = document.createElement("div"); editor.className = "docs-word-host";
    const received = vi.fn(); editor.addEventListener("keydown", received); view.container.querySelector(".docs-embedded-host")!.append(editor);
    const shellButton = document.createElement("button"); view.container.append(shellButton); shellButton.focus();
    await act(async () => { emit("onMenuUndo"); emit("onMenuRedo"); emit("onMenuFind"); });
    expect(received).not.toHaveBeenCalled();
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
    await act(async () => { state.props!.onIncomingDocumentHandled!(state.props!.incomingDocument!.requestId); });
    await screen.findByText("b.txt");
    expect(state.props?.pickDocument).toBeTypeOf("function"); expect(state.props?.subscribeCommands).toBeTypeOf("function");
  });
});
