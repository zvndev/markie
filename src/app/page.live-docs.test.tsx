import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emit, installBridge } from "@/test/mock-bridge";
import type { DocumentShellState } from "@/lib/document-shell";
import type { LiveDocsShell } from "@/components/live-docs/live-docs-area";
import { authStore } from "@/lib/auth-store";

// The Live Docs area as a third pane (super-nightly, step M3): the rail
// button, and that no command meant for the panes behind it reaches them.
const state = vi.hoisted(() => ({
  docs: null as DocumentShellState | null,
  docsActive: false,
  area: null as LiveDocsShell | null,
  areaActive: false,
  areaMounts: 0,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost", getAuthToken: () => null, adoptAuthToken: () => {}, pushSyncConfig: () => {},
  getConfirmedAuthIdentity: () => null, getServerURL: () => "https://account.example.test",
}));
vi.mock("@/components/document-workspace-host", () => ({ DocumentWorkspaceHost: ({ active, onShellChange }: { active: boolean; onShellChange: (shell: DocumentShellState | null) => void }) => {
  useEffect(() => { onShellChange(state.docs); return () => onShellChange(null); }, [onShellChange]);
  useEffect(() => { state.docsActive = active; }, [active]);
  return <section data-testid="documents-pane" inert={!active} />;
} }));
vi.mock("@/components/live-docs/live-docs-area", () => ({ LiveDocsArea: ({ active, onShellChange }: { active: boolean; onShellChange: (shell: LiveDocsShell | null) => void }) => {
  useEffect(() => { state.areaMounts += 1; onShellChange(state.area); return () => onShellChange(null); }, [onShellChange]);
  useEffect(() => { state.areaActive = active; }, [active]);
  return <section data-testid="live-docs-area"><h1>Live Docs</h1></section>;
} }));
import Home from "./page";

const RAIL = "Live Docs: Darkmown projects";
const push = (channel: string, ...args: unknown[]) => act(async () => { emit(channel, ...args); });

beforeEach(async () => {
  localStorage.clear();
  await authStore.refresh();
  state.docsActive = false;
  state.areaActive = false;
  state.areaMounts = 0;
  state.docs = {
    name: "proposal.docx", dirty: false, hasSession: true, private: false, ready: true, busy: false, records: [], renderer: "word",
    commands: { enabledCommands: ["format-bold", "find"], execute: vi.fn() },
    create: vi.fn(), open: vi.fn(), openCloudDocument: vi.fn(), settleIncomingDocuments: vi.fn(async () => true), importFile: vi.fn(), save: vi.fn(), share: vi.fn(), showVault: vi.fn(),
    prepareClose: vi.fn(async () => true), prepareLeave: vi.fn(async () => true),
  };
  state.area = {
    projectName: "corner-shop", activeName: "index.wd", activeDirty: true, dirtyCount: 1,
    save: vi.fn(), undo: vi.fn(), redo: vi.fn(), prepareClose: vi.fn(() => true),
  };
});

async function boot(nightly = true) {
  if (nightly) localStorage.setItem("markie.nightly", "1");
  const api = installBridge({ getInitialFile: vi.fn(async () => ({ name: "notes.md", path: "/notes/notes.md", content: "Markdown behind the area\n" })) });
  render(<Home documentsEnabled />);
  await screen.findByText("Markdown behind the area");
  return api;
}
async function openArea() {
  await userEvent.click(screen.getByRole("button", { name: RAIL }));
  await screen.findByTestId("live-docs-area");
  await waitFor(() => expect(state.areaActive).toBe(true));
}
const markdownPaneInert = () => !!screen.getByText("Markdown behind the area").closest("[inert]");

describe("the Live Docs pane", () => {
  it("does not exist without the nightly gate", async () => {
    await boot(false);
    expect(screen.queryByRole("button", { name: RAIL })).not.toBeInTheDocument();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("option", { name: /Live Docs…/ })).not.toBeInTheDocument();
    expect(state.areaMounts).toBe(0);
  });

  it("opens from its rail button over the other panes, and a second click goes back", async () => {
    await boot();
    expect(state.areaMounts).toBe(0);
    await openArea();
    expect(screen.getByRole("button", { name: RAIL })).toHaveAttribute("aria-current", "page");
    expect(markdownPaneInert()).toBe(true);
    expect(state.docsActive).toBe(false);
    await waitFor(() => expect(document.title).toBe("• index.wd — Markie"));
    await userEvent.click(screen.getByRole("button", { name: RAIL }));
    await waitFor(() => expect(markdownPaneInert()).toBe(false));
    expect(state.areaActive).toBe(false);
    // Kept mounted, so the project and unsaved tabs survive the trip.
    expect(screen.getByTestId("live-docs-area")).toBeInTheDocument();
    expect(state.areaMounts).toBe(1);
  });

  it("sends menu Save and Undo to the area, and nothing meant for a document to the panes behind it", async () => {
    const api = await boot();
    await openArea();
    await push("menu-save");
    expect(state.area!.save).toHaveBeenCalledTimes(1);
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(state.docs!.save).not.toHaveBeenCalled();
    await push("menu-undo");
    await push("menu-redo");
    expect(state.area!.undo).toHaveBeenCalledTimes(1);
    expect(state.area!.redo).toHaveBeenCalledTimes(1);
    await push("menu-find");
    await push("menu-save-as");
    await push("menu-export-html");
    await push("menu-print");
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(api.saveFileAs).not.toHaveBeenCalled();
    expect(api.exportHTML).not.toHaveBeenCalled();
    expect(api.setDocumentMenuState).toHaveBeenLastCalledWith({ renderer: "none", enabledCommands: [] });
  });

  it("takes ⌘S for the area from the keyboard too, and ignores the Markdown pane's keys", async () => {
    const api = await boot();
    await openArea();
    await userEvent.keyboard("{Meta>}s{/Meta}");
    expect(state.area!.save).toHaveBeenCalledTimes(1);
    expect(api.saveFile).not.toHaveBeenCalled();
    await userEvent.keyboard("{Meta>}f{/Meta}");
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("offers only commands that need no document in the palette", async () => {
    await boot();
    await openArea();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("option", { name: /File\s*Save(?! As)/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Library…/ })).toBeInTheDocument();
    for (const hidden of [/Export HTML/, /Save As…/, /Find…/, /Format Tables/, /Share…/, /Make interactive/, /Rich Mode/]) {
      expect(screen.queryByRole("option", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("steps aside when a document is opened", async () => {
    await boot();
    await openArea();
    await push("file-opened", { name: "other.md", path: "/notes/other.md", content: "Another document\n" });
    await screen.findByText("Another document");
    expect(state.areaActive).toBe(false);
    expect(screen.getByText("Another document").closest("[inert]")).toBeNull();
  });

  it("keeps the window open while the area has unsaved files, and shows it", async () => {
    const api = await boot();
    await openArea();
    await userEvent.click(screen.getByRole("button", { name: RAIL }));
    await waitFor(() => expect(state.areaActive).toBe(false));
    // The page holds the shell object the area handed it.
    state.area!.prepareClose = vi.fn(() => false);
    await push("app-will-close", 7);
    await waitFor(() => expect(api.appCloseCancel).toHaveBeenCalledWith(7));
    expect(api.appCloseReady).not.toHaveBeenCalled();
    await waitFor(() => expect(state.areaActive).toBe(true));
  });
});
