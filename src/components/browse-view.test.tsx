import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElectronAPI, MdRow, MdScanResult } from "@/lib/electron";
import { emit, installBridge } from "@/test/mock-bridge";
import { BrowseView } from "./browse-view";

const row = (o: Partial<MdRow> = {}): MdRow => ({
  path: "/home/me/notes/one.md",
  name: "one.md",
  dir: "/home/me/notes",
  mtimeMs: 1,
  ...o,
});

const scan = (o: Partial<MdScanResult> = {}): MdScanResult => ({
  files: [row()],
  scannedAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

function renderBrowse(result: MdScanResult, overrides: Partial<ElectronAPI> = {}) {
  // Flat list rather than the folder tree, so file rows are on screen without
  // having to expand anything first.
  localStorage.setItem("markie.browse.mode.v1", "files");
  const api = installBridge({
    mdIndexScan: vi.fn(async () => result),
    mdIndexStars: vi.fn(async () => []),
    ...overrides,
  });
  const onOpenPath = vi.fn();
  render(<BrowseView onOpenPath={onOpenPath} activePath={null} />);
  return { api, onOpenPath };
}

const NOTE = /^Index is incomplete:/;

beforeEach(() => {
  localStorage.clear();
});

describe("BrowseView truncated index", () => {
  it("says the index is incomplete, with the reason main gave", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "time budget reached" }));
    expect(
      await screen.findByText("Index is incomplete: time budget reached")
    ).toBeInTheDocument();
  });

  it("still says so when the reason is missing", async () => {
    renderBrowse(scan({ truncated: true }));
    expect(await screen.findByText(NOTE)).toBeInTheDocument();
  });

  it("says nothing when the field is absent, as an older main leaves it", async () => {
    renderBrowse(scan());
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("says nothing for a complete scan", async () => {
    renderBrowse(scan({ truncated: false, truncatedReason: null }));
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("sits above the list, not in place of it", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "depth cap" }));
    const note = await screen.findByText("Index is incomplete: depth cap");
    expect(screen.getByText("one.md")).toBeInTheDocument();
    expect(
      note.compareDocumentPosition(screen.getByText("one.md")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("clears once a rescan comes back complete", async () => {
    renderBrowse(scan({ truncated: true, truncatedReason: "time budget reached" }), {
      mdIndexRefresh: vi.fn(async () => scan()),
    } as Partial<ElectronAPI>);
    await screen.findByText(NOTE);
    await userEvent.click(screen.getByTitle("Rescan"));
    await waitFor(() => expect(screen.queryByText(NOTE)).not.toBeInTheDocument());
  });

  it("appears when a pushed index update is the truncated one", async () => {
    renderBrowse(scan());
    await screen.findByText("one.md");
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    await act(async () => {
      emit("onMdIndexUpdated", {
        ...scan({ truncated: true, truncatedReason: "too many folders" }),
      });
    });
    expect(
      await screen.findByText("Index is incomplete: too many folders")
    ).toBeInTheDocument();
  });

  it("stays out of the way of a failed scan, which has its own message", async () => {
    renderBrowse({
      files: undefined as unknown as MdRow[],
      scannedAt: null,
      error: "Couldn't read your markdown files.",
      truncated: true,
    });
    expect(
      await screen.findByText(/Couldn't read your markdown files\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });
});
