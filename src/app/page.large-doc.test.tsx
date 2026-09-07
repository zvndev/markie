// The document size tiers, as the page honours them (src/lib/doc-tiers.ts).
// Main decides from a stat and the payload carries the decision; this suite
// pins what the renderer does with it.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Wrap the real module so the verdict is genuine and only the call is watched.
vi.mock("@/lib/rich-safety", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rich-safety")>();
  return { ...real, startReconstructionJob: vi.fn(real.startReconstructionJob) };
});

import { clearReconstructionCache, startReconstructionJob } from "@/lib/rich-safety";
import Home from "./page";

const probe = vi.mocked(startReconstructionJob);

// The flag is main's; the renderer never re-measures. A short body keeps the
// test honest about that, and a real size drives the copy.
const LARGE = {
  name: "big.md",
  path: "/notes/big.md",
  content: "# Big\n\nA paragraph that stands in for four megabytes.\n",
  size: 4_400_000,
  large: true,
};
const SMALL = {
  name: "notes.md",
  path: "/notes/notes.md",
  content: "# Small\n\nHello there.\n",
  size: 24,
  large: false,
};
const REFUSED = {
  tooLarge: true as const,
  name: "huge.md",
  path: "/notes/huge.md",
  size: 143_000_000,
};

const largeStrip = () => document.querySelector("[data-markie-large-doc-strip]");
const refusalStrip = () => document.querySelector("[data-markie-too-large-strip]");
const richPane = () => document.querySelector("[data-markie-rich-pane]");
const sourceEditor = () => document.querySelector(".cm-editor");
const modeButton = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  clearReconstructionCache();
  probe.mockClear();
});

describe("large documents", () => {
  it("opens in Source view with Rich and Split unavailable, and skips the rich pipeline", async () => {
    const registryTrack = vi.fn(async () => ({ ok: true }));
    installBridge({
      getInitialFile: vi.fn(async () => LARGE),
      registryTrack,
    } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(largeStrip()).not.toBeNull());
    expect(largeStrip()!.textContent).toContain(
      "Large document (4.4 MB). Opened in source view; rich editing is off for files over 1.0 MB."
    );
    expect(richPane()).toBeNull();
    await waitFor(() => expect(sourceEditor()).not.toBeNull());

    const rich = modeButton(/rich mode/i);
    const split = modeButton(/split mode/i);
    const source = modeButton(/source mode/i);
    expect(rich.disabled).toBe(true);
    expect(rich.title).toBe("Too large for rich view");
    expect(split.disabled).toBe(true);
    expect(source.disabled).toBe(false);
    expect(source.getAttribute("aria-pressed")).toBe("true");

    // Main registered the document when it read it; the probe has no rich
    // edits to protect.
    expect(registryTrack).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses the Rich shortcut and gives the mode back with the next ordinary document", async () => {
    installBridge({ getInitialFile: vi.fn(async () => LARGE) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(largeStrip()).not.toBeNull());

    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(richPane()).toBeNull();
    expect(modeButton(/source mode/i).getAttribute("aria-pressed")).toBe("true");

    emit("onFileOpened", SMALL);
    await waitFor(() => expect(largeStrip()).toBeNull());
    await waitFor(() => expect(richPane()).not.toBeNull());
    expect(modeButton(/rich mode/i).disabled).toBe(false);
    expect(modeButton(/rich mode/i).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(probe).toHaveBeenCalled());
  });

  it("shows a refusal for a file over the cap and keeps the open document", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(document.title).toBe("notes.md — Markie"));

    emit("onFileOpened", REFUSED);
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(refusalStrip()!.textContent).toContain(
      "huge.md was not opened. Markie opens markdown files up to 100 MB. This one is 143 MB."
    );
    expect(document.title).toBe("notes.md — Markie");
    expect(richPane()).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(refusalStrip()).toBeNull();
  });

  it("boots to the welcome state when the launch file was refused", async () => {
    installBridge({ getInitialFile: vi.fn(async () => REFUSED) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(document.title).not.toContain("huge.md");
  });
});
