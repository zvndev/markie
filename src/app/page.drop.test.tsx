import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
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

const mdFile = (name = "dropped.md", body = "dropped from the desktop\n") =>
  new File([body], name, { type: "text/markdown" });

const drop = async (file: File) => {
  await act(async () => {
    fireEvent.drop(window, { dataTransfer: { files: [file] } });
  });
};

beforeEach(() => {
  localStorage.clear();
});

describe("page drag and drop", () => {
  it("shows the drop target while a file is over the window", async () => {
    await boot();
    await act(async () => {
      fireEvent.dragOver(window, { dataTransfer: { files: [mdFile()] } });
    });
    expect(await screen.findByText("Drop markdown file")).toBeInTheDocument();
    await act(async () => {
      // The handler only clears on a leave that left the window entirely,
      // which it reads off a null relatedTarget.
      const leaving = new Event("dragleave");
      Object.defineProperty(leaving, "relatedTarget", { value: null });
      fireEvent(window, leaving);
    });
    await waitFor(() =>
      expect(screen.queryByText("Drop markdown file")).not.toBeInTheDocument()
    );
  });

  it("opens the real on-disk file when the desktop bridge can resolve its path", async () => {
    const openFilePath = vi.fn(async () => ({
      name: "dropped.md",
      path: "/desktop/dropped.md",
      content: "the file as it is on disk\n",
    }));
    const pathForFile = vi.fn(() => "/desktop/dropped.md");
    await boot({ openFilePath, pathForFile } as unknown as Partial<ElectronAPI>);

    await drop(mdFile());

    await waitFor(() => expect(pathForFile).toHaveBeenCalledTimes(1));
    expect(openFilePath).toHaveBeenCalledExactlyOnceWith("/desktop/dropped.md");
    await waitFor(() => expect(document.title).toBe("dropped.md — Markie"));
    expect(await screen.findByText("the file as it is on disk")).toBeInTheDocument();
  });

  it("falls back to the file's own bytes when no path can be resolved", async () => {
    const openFilePath = vi.fn(async () => null);
    const registryTrack = vi.fn(async () => ({ ok: true }));
    // pathForFile answers null for a file the sandbox has no path for.
    await boot({
      pathForFile: vi.fn(() => null),
      openFilePath,
      registryTrack,
    } as unknown as Partial<ElectronAPI>);

    await drop(mdFile("pasted.md", "read straight from the drop\n"));

    await waitFor(() => expect(document.title).toBe("pasted.md — Markie"));
    expect(await screen.findByText("read straight from the drop")).toBeInTheDocument();
    // No path means nothing to open by path, and nothing to track: the
    // registry only ever saw the document Markie booted with.
    expect(openFilePath).not.toHaveBeenCalled();
    expect(registryTrack).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "pasted.md" })
    );
  });

  it("leaves the document alone when the drop carries no file", async () => {
    await boot();
    await act(async () => {
      fireEvent.drop(window, { dataTransfer: { files: [] } });
    });
    expect(document.title).toBe("notes.md — Markie");
    expect(screen.getByText("opened content")).toBeInTheDocument();
    expect(screen.queryByText("Drop markdown file")).not.toBeInTheDocument();
  });

  it("clears the drop target once the drop lands", async () => {
    await boot({ pathForFile: vi.fn(() => null) } as unknown as Partial<ElectronAPI>);
    await act(async () => {
      fireEvent.dragOver(window, { dataTransfer: { files: [mdFile()] } });
    });
    await screen.findByText("Drop markdown file");
    await drop(mdFile());
    await waitFor(() =>
      expect(screen.queryByText("Drop markdown file")).not.toBeInTheDocument()
    );
  });
});
