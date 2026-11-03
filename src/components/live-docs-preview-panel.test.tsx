import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveDocsPreviewApi, LiveDocsPreviewChoice, LiveDocsPreviewStatus } from "@/lib/electron";
import { LiveDocsPreviewPanel } from "./live-docs-preview-panel";

const project = { name: "site", root: "/tmp/site", reasons: ["has site/pages"] };
const accepted: LiveDocsPreviewChoice = { ok: true, project };
const ready: LiveDocsPreviewStatus = {
  ok: true,
  phase: "ready",
  project,
  url: "http://127.0.0.1:51234/",
  node: { path: "/opt/homebrew/bin/node", version: "v22.11.0", via: "zsh -l" },
};

function installApi(overrides: Partial<LiveDocsPreviewApi> = {}) {
  let emit: (status: LiveDocsPreviewStatus) => void = () => {};
  const api = {
    choose: vi.fn(async (): Promise<LiveDocsPreviewChoice> => accepted),
    start: vi.fn(async () => ready),
    stop: vi.fn(async () => ({ ok: true })),
    layout: vi.fn(async () => ({ ok: true })),
    onStatus: vi.fn((callback: (status: LiveDocsPreviewStatus) => void) => {
      emit = callback;
      return () => { emit = () => {}; };
    }),
    ...overrides,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: "darwin", liveDocsPreview: api };
  return { api, emit: (status: LiveDocsPreviewStatus) => act(() => emit(status)) };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("LiveDocsPreviewPanel", () => {
  it("starts the folder main accepted, shows where it runs, and stops when closed", async () => {
    const { api } = installApi();
    const { unmount } = render(<LiveDocsPreviewPanel choice={accepted} suspended={false} onClose={() => {}} />);
    expect(api.start).toHaveBeenCalledWith();
    expect(await screen.findByText("http://127.0.0.1:51234/ · Node v22.11.0")).toBeTruthy();
    unmount();
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it("shows the native view only once the server is ready, and hides it under other overlays", async () => {
    const { api, emit } = installApi({ start: vi.fn(() => new Promise<LiveDocsPreviewStatus>(() => {})) });
    const { rerender, container } = render(<LiveDocsPreviewPanel choice={accepted} suspended={false} onClose={() => {}} />);
    expect(api.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    expect(container.querySelector("[data-live-docs-phase]")?.getAttribute("data-live-docs-phase")).toBe("starting");

    emit(ready);
    expect(api.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));

    rerender(<LiveDocsPreviewPanel choice={accepted} suspended onClose={() => {}} />);
    expect(api.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
  });

  it("says why a folder was refused, and never starts it", () => {
    const { api } = installApi();
    render(
      <LiveDocsPreviewPanel
        choice={{ ok: false, code: "not-a-project", message: "notes is not a Darkmown project. It has no site/pages folder." }}
        suspended={false}
        onClose={() => {}}
      />
    );
    expect(screen.getByRole("alert").textContent).toMatch(/not a Darkmown project/);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("shows the dev server's own output when it fails, and can try again", async () => {
    const failed: LiveDocsPreviewStatus = { ok: false, phase: "error", project, code: "node-missing", message: "Markie could not find Node.js.", log: ["zsh: command not found"] };
    const { api } = installApi({ start: vi.fn(async () => failed) });
    render(<LiveDocsPreviewPanel choice={accepted} suspended={false} onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Markie could not find Node.js.");
    expect(screen.getByText("zsh: command not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it("treats the private build's locked answer as an error, not a start that never ends", async () => {
    installApi({ start: vi.fn(async () => ({ ok: false, error: "Private release authorization is required." }) as unknown as LiveDocsPreviewStatus) });
    render(<LiveDocsPreviewPanel choice={accepted} suspended={false} onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Private release authorization is required.");
  });

  it("closes on Escape unless another overlay is on top", () => {
    installApi();
    const onClose = vi.fn();
    const { rerender } = render(<LiveDocsPreviewPanel choice={accepted} suspended onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<LiveDocsPreviewPanel choice={accepted} suspended={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
