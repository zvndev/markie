import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge } from "@/test/mock-bridge";
import type { ElectronAPI } from "@/lib/electron";

const auth = vi.hoisted(() => ({ active: false, role: "owner" as "owner" | "editor" | "viewer" }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => auth.active ? { id: "me", name: "Test", email: "test@example.com" } : null },
  sharesClient: {
    access: async () => auth.active ? { role: auth.role } : null,
    list: async () => auth.active ? [{ user_id: auth.role === "owner" ? "other" : "me", role: auth.role === "owner" ? "editor" : auth.role }] : null,
    sharedByMe: async () => [],
  },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => auth.active ? "test-token" : null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

vi.mock("@/components/source-editor", () => ({
  preloadSourceEditor: () => {},
  SourceEditor: (props: {
    value: string;
    onChange: (text: string) => void;
    plainText?: boolean;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Source document"
      data-plain-text={String(props.plainText)}
      value={props.value}
      readOnly={props.readOnly}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

import Home from "./page";
import { authStore } from "@/lib/auth-store";

beforeEach(async () => {
  localStorage.clear();
  auth.active = false;
  await authStore.refresh();
});

describe("plain text is not Markdown", () => {
  it("copies the whole file, as stored, from the document corner", async () => {
    const content = "# literal heading\n\n**not bold**\n";
    installBridge({
      getInitialFile: vi.fn(async () => ({ name: "notes.txt", path: "/notes.txt", content })),
    });
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Home />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Source document" })).toHaveValue(content));
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(content));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it.each(["txt", "text", "log"])("opens .%s literally without a rich editor", async (extension) => {
    const content = "# literal heading\n\n**not bold**\n  indented\n";
    installBridge({
      getInitialFile: vi.fn(async () => ({ name: `notes.${extension}`, path: `/notes.${extension}`, content })),
    });
    const view = render(<Home />);
    const source = await screen.findByRole("textbox", { name: "Source document" });
    await waitFor(() => expect(source).toHaveValue(content));
    expect(source).toHaveAttribute("data-plain-text", "true");
    expect(view.container.querySelector("[data-markie-rich-pane]")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Document formatting" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Editing mode" })).not.toBeInTheDocument();
    await act(async () => { emit("onSetMode", "preview"); emit("onSetMode", "split"); });
    expect(source).toHaveValue(content);
    expect(view.container.querySelector("[data-markie-rich-pane]")).toBeNull();
  });

  it("saves literal edits without Markdown normalization", async () => {
    const path = "/literal.txt";
    const saveFile = vi.fn(async () => ({ success: true, path }));
    installBridge({
      getInitialFile: vi.fn(async () => ({ name: "literal.txt", path, content: "# literal\n" })),
      saveFile,
    });
    render(<Home />);
    const source = await screen.findByRole("textbox", { name: "Source document" });
    const text = "# literal\n\n**literal**\n  two spaces\n";
    fireEvent.change(source, { target: { value: text } });
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true });
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ content: text, filePath: path })));
  });

  it.each(["owner", "editor", "viewer"] as const)("preserves %s permissions in the plain-text live session", async (role) => {
    auth.active = true;
    auth.role = role;
    await authStore.refresh();
    const syncDocRole = vi.fn(async () => {});
    installBridge({
      getInitialFile: vi.fn(async () => ({ name: "shared.txt", path: "/shared.txt", content: "literal **text**" })),
      registryGet: vi.fn(async () => ({ path: "/shared.txt", name: "shared.txt", cloud_doc_id: "cloud", share_role: role,
        content_hash: null, cloud_version: 1, sync_state: "synced", last_opened_at: null, last_synced_at: null })),
      syncDocRole,
    } as Partial<ElectronAPI>);
    const view = render(<Home />);
    await screen.findByRole("textbox", { name: "Source document" });
    await waitFor(() => expect(syncDocRole).toHaveBeenCalledWith({ cloudId: "cloud", role }));
    // A shared text file with another member goes live in its own pane now:
    // no rich editor, and no "file sync only" note. The pane remounts when
    // the session starts, so the textbox is re-queried after it lands.
    await waitFor(() => expect(view.container.querySelector("[data-markie-text-live]")).not.toBeNull());
    const source = screen.getByRole("textbox", { name: "Source document" });
    if (role === "viewer") expect(source).toHaveAttribute("readonly");
    else expect(source).not.toHaveAttribute("readonly");
    expect(view.container.querySelector("[data-markie-rich-pane]")).toBeNull();
    expect(screen.queryByText(/Plain text uses file sync/)).not.toBeInTheDocument();
  });
});
