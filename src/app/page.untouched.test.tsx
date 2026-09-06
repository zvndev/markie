import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { installBridge } from "@/test/mock-bridge";

vi.mock("@/lib/auth-client", () => ({
  authClient: { me: async () => null },
  sharesClient: { access: async () => null, list: async () => null, sharedByMe: async () => [] },
  collabWsBase: () => "ws://localhost",
  getAuthToken: () => null,
  adoptAuthToken: () => {},
  pushSyncConfig: () => {},
}));

import Home from "./page";

// Opening a document is not an edit. The rich pane used to raise one anyway:
// TipTap emits an update event from setEditable, the pane took it for typing,
// and an autosave plus a cloud push followed for every document the moment it
// opened. On disk that was invisible. On the server it carried a stale
// version, so a document another machine had moved on came back "conflict"
// with nobody having touched it.
const OPEN = {
  name: "notes.md",
  path: "/notes/notes.md",
  content: "# Notes\n\nline one\nline two\nline three\n",
};

beforeEach(() => {
  localStorage.clear();
});

describe("an untouched document", () => {
  it("is never saved or pushed on its own", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: OPEN.path }));
    const docPush = vi.fn(async () => ({ ok: true, pushed: true }));
    installBridge({
      getInitialFile: vi.fn(async () => OPEN),
      saveFile,
      docPush,
    } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(document.title).toBe("notes.md — Markie"));
    await screen.findByText("line one", { exact: false });
    // Longer than the rich pane's debounce plus the autosave's idle wait.
    await new Promise((r) => setTimeout(r, 2500));
    expect(saveFile).not.toHaveBeenCalled();
    expect(docPush).not.toHaveBeenCalled();
    expect(document.title).toBe("notes.md — Markie");
  }, 15000);
});
