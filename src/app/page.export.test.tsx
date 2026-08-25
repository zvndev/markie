import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";

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

// A promise the test resolves by hand, to hold one export in flight while a
// second one is attempted.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
});

describe("page export/print handlers", () => {
  it("menu-export-pdf sends the document HTML, theme, and folder to main", async () => {
    const exportPDF = vi.fn(async () => ({ success: true, path: "/tmp/out.pdf" }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuExportPDF", "light");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));
    const arg = (exportPDF.mock.calls[0] as unknown[])[0] as {
      html: string;
      theme: string;
      docPath?: string;
    };
    expect(arg.theme).toBe("light");
    expect(arg.docPath).toBe(OPEN.path);
    expect(arg.html).toContain("opened content");
  });

  it("defaults the export theme to dark when the menu sends none", async () => {
    const exportPDF = vi.fn(async () => ({ success: true, path: "/tmp/out.pdf" }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuExportPDF");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));
    expect(((exportPDF.mock.calls[0] as unknown[])[0] as { theme: string }).theme).toBe("dark");
  });

  it("refuses a second export while one is in flight, then frees up", async () => {
    const gate = deferred<{ success: true; path: string }>();
    const exportPDF = vi.fn(() => gate.promise);
    await boot({ exportPDF } as Partial<ElectronAPI>);

    await push("onMenuExportPDF", "dark"); // this one is now in flight
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));

    await push("onMenuExportPDF", "dark"); // refused, not dispatched
    expect(
      await screen.findByText(/already exporting/i)
    ).toBeInTheDocument();
    expect(exportPDF).toHaveBeenCalledTimes(1);

    // Let the first finish; the guard clears and a fresh export dispatches.
    await act(async () => {
      gate.resolve({ success: true, path: "/tmp/out.pdf" });
    });
    await push("onMenuExportPDF", "dark");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(2));
  });

  it("treats a cancelled save sheet as a non-event, not an error", async () => {
    const exportPDF = vi.fn(async () => ({ canceled: true, success: false }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuExportPDF", "dark");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/couldn't export/i)).toBeNull();
  });

  it("surfaces a failed export as a readable error", async () => {
    const exportPDF = vi.fn(async () => ({
      success: false,
      error: "Disk is full.",
    }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuExportPDF", "dark");
    expect(await screen.findByText("Disk is full.")).toBeInTheDocument();
  });

  it("menu-export-html hands main the HTML and the document folder", async () => {
    const exportHTML = vi.fn(async () => ({ success: true, path: "/tmp/out.html" }));
    await boot({ exportHTML } as Partial<ElectronAPI>);
    await push("onMenuExportHTML");
    await waitFor(() => expect(exportHTML).toHaveBeenCalledTimes(1));
    const arg = (exportHTML.mock.calls[0] as unknown[])[0] as {
      html: string;
      defaultName: string;
      docPath?: string;
    };
    expect(arg.defaultName).toBe("notes.html");
    expect(arg.docPath).toBe(OPEN.path);
    expect(arg.html).toContain("opened content");
  });

  it("menu-print prints through main rather than exporting a file", async () => {
    const exportPDF = vi.fn(async () => ({ success: true }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuPrint");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));
    expect(((exportPDF.mock.calls[0] as unknown[])[0] as { mode?: string }).mode).toBe("print");
  });

  it("treats a dismissed print sheet as a non-event, not an error", async () => {
    const exportPDF = vi.fn(async () => ({ canceled: true, success: false }));
    await boot({ exportPDF } as Partial<ElectronAPI>);
    await push("onMenuPrint");
    await waitFor(() => expect(exportPDF).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/couldn't print/i)).toBeNull();
  });
});
