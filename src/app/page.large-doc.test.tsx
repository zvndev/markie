// The document size tiers, as the page honours them (src/lib/doc-tiers.ts).
// Main decides from a stat and the payload carries the decision; this suite
// pins what the renderer does with it.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";
import { EditorView } from "@codemirror/view";

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

// Text over the cap without a size from main is measured in the renderer.
// A 100 MB string in a test would prove nothing but the machine's memory, so
// the measurement is what the mock answers for a marked string.
vi.mock("@/lib/doc-tiers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/doc-tiers")>();
  return {
    ...real,
    measureBytes: (text: string) =>
      text.startsWith("HUGE:") ? 143_000_000 : text.startsWith("LARGE:") ? 2_500_000 : real.measureBytes(text),
  };
});

import { clearReconstructionCache, startReconstructionJob } from "@/lib/rich-safety";
import Home from "./page";

const probe = vi.mocked(startReconstructionJob);

// The flag is main's; the renderer never re-measures. A short body keeps the
// test honest about that, and a real size drives the copy.
// The content is long enough in characters to stand at the large tier on its
// own: page re-measures a document a beat after it lands, and a few dozen
// characters claiming four megabytes would be demoted the moment a slow
// machine let that beat pass mid-test.
const LARGE = {
  name: "big.md",
  path: "/notes/big.md",
  content: "# Big\n\n" + "A paragraph that stands in for four megabytes.\n".repeat(22_000),
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
      "Large document (4.4 MB). Opened in source view; rich editing and live collaboration are off for files over 1.0 MB."
    );
    expect(richPane()).toBeNull();
    await waitFor(() => expect(sourceEditor()).not.toBeNull());

    // The strip and the editor can land a render before the mode buttons on a
    // slow machine, and the buttons are re-rendered when they follow, so they
    // are looked up afresh each time. The shortcut is refused either way.
    await waitFor(() => {
      const rich = modeButton(/rich mode/i);
      const split = modeButton(/split mode/i);
      const source = modeButton(/source mode/i);
      expect(rich.disabled).toBe(true);
      expect(rich.title).toBe("Too large for rich view");
      expect(split.disabled).toBe(true);
      expect(source.disabled).toBe(false);
      expect(source.getAttribute("aria-pressed")).toBe("true");
    });

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

  it("gives New File an ordinary document again", async () => {
    installBridge({ getInitialFile: vi.fn(async () => LARGE) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(largeStrip()).not.toBeNull());

    emit("onMenuNewFile", undefined);
    await waitFor(() => expect(largeStrip()).toBeNull());
    expect(modeButton(/rich mode/i).disabled).toBe(false);
    expect(modeButton(/split mode/i).disabled).toBe(false);
    await waitFor(() => expect(richPane()).not.toBeNull());
  });

  it("re-settles the tier from the size of a disk change, both ways", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    // The file grew past the line on disk; main sends the new size with the
    // text and the reload lands in Source view.
    emit("onFileChangedOnDisk", { path: SMALL.path, content: "# Grown\n", size: 2_500_000 });
    await userEvent.click(await screen.findByRole("button", { name: /reload/i }));
    await waitFor(() => expect(largeStrip()).not.toBeNull());
    expect(largeStrip()!.textContent).toContain("Large document (2.5 MB)");
    expect(richPane()).toBeNull();
    expect(modeButton(/rich mode/i).disabled).toBe(true);

    // And shrank back: the mode it displaced returns.
    emit("onFileChangedOnDisk", { path: SMALL.path, content: "# Trimmed\n", size: 10 });
    await userEvent.click(await screen.findByRole("button", { name: /reload/i }));
    await waitFor(() => expect(largeStrip()).toBeNull());
    await waitFor(() => expect(richPane()).not.toBeNull());
    expect(modeButton(/rich mode/i).disabled).toBe(false);
  });

  it("keeps the open document when the file on disk outgrows the cap", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    emit("onFileChangedOnDisk", { path: SMALL.path, tooLarge: true, size: 143_000_000 });
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(refusalStrip()!.textContent).toContain(
      "notes.md was not reloaded. Markie opens markdown files up to 100 MB. This one is 143 MB."
    );
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();
    expect(richPane()).not.toBeNull();
    expect(document.title).toBe("notes.md — Markie");
  });

  it("measures text that arrives without a size, so a snapshot of a large document stays large", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    // A history version or a recovered draft: same shape, no size from main.
    // Multi-byte text, because the line is drawn in file bytes.
    const big = "# Snapshot\n\n" + "ünïcödé ".repeat(120_000);
    emit("onFileOpened", { name: "notes.md", path: SMALL.path, content: big, unsaved: true });
    await waitFor(() => expect(largeStrip()).not.toBeNull());
    expect(largeStrip()!.textContent).toContain("Large document (1.4 MB)");
    expect(richPane()).toBeNull();
  });

  it("refuses text over the cap that arrives without a size, and keeps the open document", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    // A history version or a recovered draft of a file that has since grown.
    emit("onFileOpened", { name: "notes.md", path: SMALL.path, content: "HUGE: a snapshot\n", unsaved: true });
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(refusalStrip()!.textContent).toContain(
      "notes.md was not restored. Markie opens markdown files up to 100 MB. This one is 143 MB."
    );
    expect(richPane()).not.toBeNull();
    expect(largeStrip()).toBeNull();
    expect(document.title).toBe("notes.md — Markie");
  });

  it("drops a pending disk conflict when the file outgrows the cap, and the refusal when it is readable again", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    emit("onFileChangedOnDisk", { path: SMALL.path, content: "theirs\n", size: 7 });
    await screen.findByRole("button", { name: /reload/i });

    emit("onFileChangedOnDisk", { path: SMALL.path, tooLarge: true, size: 143_000_000 });
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(screen.queryByRole("button", { name: /reload/i })).toBeNull();

    emit("onFileChangedOnDisk", { path: SMALL.path, content: "theirs, trimmed\n", size: 16 });
    await screen.findByRole("button", { name: /reload/i });
    expect(refusalStrip()).toBeNull();
  });

  it("re-tiers a document the user edits across the line, both ways", async () => {
    installBridge({ getInitialFile: vi.fn(async () => SMALL) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(sourceEditor()).not.toBeNull());
    const view = EditorView.findFromDOM(sourceEditor() as HTMLElement)!;

    // A paste that takes the document past the line: long enough that the
    // cheap length test cannot rule it out, marked so the measurement says so.
    const pasted = "LARGE:" + "x".repeat(340_000);
    view.dispatch({ changes: { from: 0, insert: pasted } });
    await waitFor(() => expect(largeStrip()).not.toBeNull(), { timeout: 3000 });
    expect(largeStrip()!.textContent).toContain("Large document (2.5 MB)");
    expect(modeButton(/rich mode/i).disabled).toBe(true);

    // Trimmed back below it: Rich is on offer again.
    view.dispatch({ changes: { from: 0, to: pasted.length, insert: "" } });
    await waitFor(() => expect(largeStrip()).toBeNull(), { timeout: 3000 });
    expect(modeButton(/rich mode/i).disabled).toBe(false);
  });

  it("keeps saving a document edited past the cap, and the strip says what that means", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: SMALL.path }));
    installBridge({ getInitialFile: vi.fn(async () => SMALL), saveFile } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(sourceEditor()).not.toBeNull());
    const view = EditorView.findFromDOM(sourceEditor() as HTMLElement)!;

    // A paste that takes the document past the cap. Refusing to write the
    // user's bytes would be the loss; a file Markie will not reopen is not.
    const pasted = "HUGE:" + "x".repeat(340_000);
    view.dispatch({ changes: { from: 0, insert: pasted } });
    await waitFor(() => expect(largeStrip()).not.toBeNull(), { timeout: 3000 });
    expect(largeStrip()!.textContent).toContain(
      "This document is now 143 MB, more than Markie opens (100 MB). It still saves, but Markie will not open it again until it is smaller."
    );
    expect(refusalStrip()).toBeNull();
    expect(richPane()).toBeNull();
    expect(modeButton(/rich mode/i).disabled).toBe(true);

    emit("onMenuSave", undefined);
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect((saveFile.mock.calls[0] as unknown as [{ content: string }])[0].content.startsWith("HUGE:")).toBe(true);

    // Trimmed back below the line: an ordinary document again.
    view.dispatch({ changes: { from: 0, to: pasted.length, insert: "" } });
    await waitFor(() => expect(largeStrip()).toBeNull(), { timeout: 3000 });
    expect(modeButton(/rich mode/i).disabled).toBe(false);
  });

  it("tiers a converted file by what was converted, not by the file", async () => {
    // A 600 KB CSV whose markdown table is 1.2 MB: every cell gains its
    // separators on the way in (src/lib/csv.ts). Main sent the file's size;
    // the buffer is measured for real.
    const row = Array(100).fill("x").join(",") + "\n";
    const csv = row.repeat(3000);
    const registryTrack = vi.fn(async () => ({ ok: true }));
    installBridge({
      getInitialFile: vi.fn(async () => ({
        name: "data.csv",
        path: "/notes/data.csv",
        content: csv,
        size: csv.length,
        large: false,
      })),
      registryTrack,
    } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(largeStrip()).not.toBeNull());
    expect(largeStrip()!.textContent).toContain("Large document (1.2 MB)");
    expect(richPane()).toBeNull();
    expect(modeButton(/source mode/i).getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(/rich mode/i).disabled).toBe(true);
    await waitFor(() => expect(sourceEditor()).not.toBeNull());
    // Never offered to the rich pipeline, so nothing was probed; and main read
    // a 600 KB file it did not call large, so the registry row is made here.
    expect(probe).not.toHaveBeenCalled();
    expect(registryTrack).toHaveBeenCalledTimes(1);
  });

  it("tiers a CSV reloaded from disk by the table it becomes, not by the file", async () => {
    const CSV = { name: "data.csv", path: "/notes/data.csv", content: "a,b\n1,2\n", size: 8, large: false };
    installBridge({ getInitialFile: vi.fn(async () => CSV) } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());

    // 600,000 bytes of CSV; the markdown table it becomes is past the line.
    const grown = Array.from({ length: 3000 }, () => "a".repeat(100).split("").join(",")).join("\n") + "\n";
    emit("onFileChangedOnDisk", { path: CSV.path, content: grown, size: grown.length });
    await userEvent.click(await screen.findByRole("button", { name: /reload/i }));
    await waitFor(() => expect(largeStrip()).not.toBeNull(), { timeout: 5000 });
    expect(largeStrip()!.textContent).toContain("Large document (1.2 MB)");
    expect(richPane()).toBeNull();
    expect(modeButton(/rich mode/i).disabled).toBe(true);
  });

  it("keeps the offer of a recovered draft the cap refuses", async () => {
    installBridge({
      getInitialFile: vi.fn(async () => SMALL),
      draftCheck: vi.fn(async () => [
        {
          key: "k-notes",
          path: SMALL.path,
          name: SMALL.name,
          savedAt: new Date().toISOString(),
          bytes: 143_000_000,
          content: "HUGE: the only copy",
        },
      ]),
    } as Partial<ElectronAPI>);
    render(<Home />);
    await waitFor(() => expect(richPane()).not.toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }));
    await waitFor(() => expect(refusalStrip()).not.toBeNull());
    expect(refusalStrip()!.textContent).toContain("notes.md was not restored.");
    // The draft is still on offer: nothing took it down, and the file on
    // disk still holds it for whatever the user does next.
    expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
    expect(document.title).toBe("notes.md — Markie");
  });
});
